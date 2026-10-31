import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createExclusive, ensurePrivateDir, readPrivate, replaceAtomic } from "../fsafe.js";
import { parseZecToZats } from "../policy/amount.js";
import type { ChainAdapter } from "../chain/types.js";
import type { Config, PossibleSend } from "../types.js";

/**
 * The canonical payment store: idempotency bindings and payment states, shared by every
 * zshield-mcp process on one wallet. See docs/RELIABILITY_DESIGN.md.
 */

export const STATE_DIR_NAME = ".zshield-state";
export const STORE_VERSION = 1;
/** No store file is larger than this; a bigger one is refused rather than read. */
const MAX_FILE_BYTES = 64 * 1024;
/** Events read for one call. Writers only add an event when the state moves forward. */
const MAX_EVENTS_PER_CALL = 64;

/**
 * Where a call stands. Ordered: a call's state is the highest of its events, so it only
 * ever moves forward. `not_sent` and `expired` both mean proven not sent.
 */
export type CallState = "pending" | "unknown" | "not_sent" | "expired" | "sent" | "failed" | "mined";
/**
 * Forward order. `failed` is above `sent`: a send that returned a txid and was later
 * marked failed by the wallet. It is below `mined`, so a transaction seen in a block is
 * never reported failed, and a later mined sighting still wins over a wrong failed one.
 */
export const STATE_RANK: Record<CallState, number> = { pending: 0, unknown: 1, not_sent: 2, expired: 2, sent: 3, failed: 4, mined: 5 };

/** A state at or above this rank is settled: recovery leaves it alone. */
export function isSettled(state: CallState): boolean {
  return STATE_RANK[state] >= 2;
}

/** What a call set out to do, written before anything is sent. */
export interface CallIntent {
  call_id: string;
  ts: string;
  amount_zec: number | string;
  amount_zats: string;
  recipient: string;
  memo?: string;
  allowlist_hit: boolean;
  cap_zec: number | string;
  view_key_fingerprint: string | null;
  idempotency_key?: string;
  params_sha256?: string;
  /** Made by ZShield when the payment was authorized: `op_` and 32 hex digits. Never from the caller */
  operation_id?: string;
  /**
   * The height an expiry is proven from: the highest of the tip the pre-send check saw,
   * the wallet's own height, and the highest tip recorded for this wallet.
   */
  chain_tip?: number;
  /** The wallet's own scanned height at the pre-send check. A mined send cannot be below it */
  wallet_height?: number;
  /** Only on records an older version imported from an audit log. Nothing imports now */
  imported?: boolean;
  /**
   * Set by a live send, which signs the transaction and records its id before it transmits
   * anything. Such a call with no recorded id never transmitted: no history entry is its own.
   */
  two_step?: boolean;
}

export interface CallEvent {
  ts: string;
  call_id: string;
  state: CallState;
  txid?: string;
  block_height?: number;
  code?: string;
  error?: string;
  possible_sends?: PossibleSend[];
  note?: string;
  /** The txid of the signed transaction, written before it was transmitted */
  staged_txid?: string;
  /** Who wrote it. "import" only on events an older version wrote */
  by: "send" | "recovery" | "status" | "import";
}

export interface CallRecord {
  callId: string;
  intent?: CallIntent;
  state: CallState;
  /** The event that set the state */
  top?: CallEvent;
  txid?: string;
  blockHeight?: number;
  /** The txid bound at signing time, before the broadcast. The call's identity when set. */
  stagedTxid?: string;
  events: CallEvent[];
}

export interface KeyBinding {
  key: string;
  call_id: string;
  params_sha256: string;
  ts: string;
}

/** Hash of the payment parameters that an idempotency key is bound to. Amounts compare by zatoshis. */
export function paymentParamsHash(input: { amount_zec: number | string; recipient: string; memo?: string }): string {
  let amount: string;
  try {
    amount = parseZecToZats(input.amount_zec, "amount_zec").toString();
  } catch {
    amount = `raw:${String(input.amount_zec)}`;
  }
  return createHash("sha256")
    .update(JSON.stringify([amount, input.recipient, input.memo ?? ""]))
    .digest("hex");
}

const NAME = /^[A-Za-z0-9_-][A-Za-z0-9._:-]{0,127}$/;

/** Call ids and txids become file names, so only plain, bounded names are accepted. */
export function safeName(value: string, what: string): string {
  if (!NAME.test(value) || value.includes("..")) throw new Error(`Invalid ${what} for the payment store.`);
  // Colons are not allowed in Windows file names.
  return value.replace(/:/g, "%3A");
}

function sha(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Fold a call's events: the highest state wins, so a stale or late writer cannot move it back. */
export function foldEvents(callId: string, intent: CallIntent | undefined, events: CallEvent[]): CallRecord {
  let top: CallEvent | undefined;
  let txid: string | undefined;
  let blockHeight: number | undefined;
  for (const e of events) {
    if (!(e.state in STATE_RANK)) continue;
    if (!top || STATE_RANK[e.state] > STATE_RANK[top.state]) top = e;
  }
  // The txid and height come from the strongest event that has one.
  const withTx = events.filter((e) => e.txid && e.state in STATE_RANK).sort((a, b) => STATE_RANK[b.state] - STATE_RANK[a.state]);
  if (withTx[0]) {
    txid = withTx[0].txid;
    blockHeight = withTx.find((e) => e.block_height !== undefined)?.block_height;
  }
  const stagedTxid = events.find((e) => e.staged_txid)?.staged_txid;
  return { callId, intent, state: top?.state ?? "pending", top, txid, blockHeight, stagedTxid, events };
}

/** Whether `next` moves a call in `current` state forward. */
export function movesForward(current: CallRecord | undefined, next: CallState): boolean {
  return STATE_RANK[next] > STATE_RANK[current?.state ?? "pending"];
}

/** Operation ids: `op_` and 32 lowercase hex digits, made by ZShield, never taken from a caller. */
export const OPERATION_ID_PATTERN = /^op_[0-9a-f]{32}$/;

export function newOperationId(): string {
  return `op_${randomBytes(16).toString("hex")}`;
}

export class PaymentStore {
  readonly dir: string;
  /** Live mode: the OS wallet lock is required, not best effort. Set by storeFor */
  requireOsLock = false;

  constructor(dir: string) {
    this.dir = dir;
  }

  private sub(name: "keys" | "calls" | "pending" | "txids" | "ops"): string {
    return join(this.dir, name);
  }

  /** Create the folders (0700) if needed and repair loose modes. Returns repair notes. */
  ensureLayout(): string[] {
    const notes: string[] = [];
    for (const d of [this.dir, this.sub("keys"), this.sub("calls"), this.sub("pending"), this.sub("txids"), this.sub("ops")]) {
      const n = ensurePrivateDir(d);
      if (n) notes.push(n);
    }
    return notes;
  }

  get initialized(): boolean {
    return readPrivate(join(this.dir, "meta.json"), MAX_FILE_BYTES) !== undefined;
  }

  markInitialized(note: string): void {
    replaceAtomic(this.dir, "meta.json", JSON.stringify({ version: STORE_VERSION, created: new Date().toISOString(), note }));
  }

  private readJson<T>(path: string): T | undefined {
    const text = readPrivate(path, MAX_FILE_BYTES);
    if (text === undefined) return undefined;
    try {
      return JSON.parse(text) as T;
    } catch {
      return undefined;
    }
  }

  /** The call bound to an idempotency key, if any. One small file read. */
  readKey(key: string): KeyBinding | undefined {
    const b = this.readJson<KeyBinding>(join(this.sub("keys"), `${sha(key)}.json`));
    return b && b.key === key ? b : undefined;
  }

  /**
   * Bind a key to a call. Exclusive: exactly one call ever wins a key. Returns the
   * existing binding when another call already holds it.
   */
  bindKey(key: string, callId: string, paramsSha256: string): { won: true } | { won: false; existing: KeyBinding } {
    const binding: KeyBinding = { key, call_id: callId, params_sha256: paramsSha256, ts: new Date().toISOString() };
    if (createExclusive(this.sub("keys"), `${sha(key)}.json`, JSON.stringify(binding))) return { won: true };
    const existing = this.readKey(key);
    if (!existing) throw new Error("The idempotency key file exists but cannot be read.");
    return { won: false, existing };
  }

  private callDir(callId: string): string {
    return join(this.sub("calls"), safeName(callId, "call id"));
  }

  /** Write the intent and the pending marker. The intent file is written once. */
  writeIntent(intent: CallIntent): void {
    const dir = this.callDir(intent.call_id);
    ensurePrivateDir(dir);
    createExclusive(dir, "intent.json", JSON.stringify(intent));
    if (intent.operation_id) createExclusive(this.sub("ops"), `${intent.operation_id}.json`, JSON.stringify({ call_id: intent.call_id }));
    this.markPending(intent.call_id);
  }

  markPending(callId: string): void {
    createExclusive(this.sub("pending"), safeName(callId, "call id"), "");
  }

  /** Remove the pending marker of a settled call. Harmless if already gone. */
  clearPending(callId: string): void {
    try {
      fs.unlinkSync(join(this.sub("pending"), safeName(callId, "call id")));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }

  /** Call ids with a pending marker. Only unsettled calls, so this stays small. */
  pendingCalls(): string[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.sub("pending"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    return names.filter((n) => !n.startsWith(".tmp-")).map((n) => n.replace(/%3A/g, ":"));
  }

  /** The call an operation id was made for. Undefined for an unknown or malformed id. One small file read. */
  callForOperation(operationId: string): string | undefined {
    if (!OPERATION_ID_PATTERN.test(operationId)) return undefined;
    return this.readJson<{ call_id: string }>(join(this.sub("ops"), `${operationId}.json`))?.call_id;
  }

  /**
   * A call from this wallet that was signed (its txid is on record) and is not settled: it
   * may have been broadcast, and its notes are still spoken for. Undefined when there is none.
   */
  unresolvedSend(exceptCallId?: string): { callId: string; txid: string } | undefined {
    for (const callId of this.pendingCalls()) {
      if (callId === exceptCallId) continue;
      const r = this.readCall(callId);
      if (r && !isSettled(r.state) && (r.stagedTxid ?? r.txid)) return { callId, txid: (r.stagedTxid ?? r.txid)! };
    }
    return undefined;
  }

  /** Add one event. Events are never rewritten. */
  appendEvent(event: CallEvent): void {
    const dir = this.callDir(event.call_id);
    ensurePrivateDir(dir);
    const name = `${Date.now().toString().padStart(15, "0")}-${randomBytes(6).toString("hex")}.json`;
    createExclusive(dir, name, JSON.stringify(event));
  }

  /** A call's current state, read fresh from disk. Undefined when the store has no such call. */
  readCall(callId: string): CallRecord | undefined {
    let dir: string;
    try {
      dir = this.callDir(callId);
    } catch {
      return undefined;
    }
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
    const intent = this.readJson<CallIntent>(join(dir, "intent.json"));
    const events: CallEvent[] = [];
    for (const n of names.filter((x) => x !== "intent.json" && !x.startsWith(".tmp-")).sort().slice(0, MAX_EVENTS_PER_CALL)) {
      const e = this.readJson<CallEvent>(join(dir, n));
      if (e && e.call_id === callId) events.push(e);
    }
    if (!intent && events.length === 0) return undefined;
    return foldEvents(callId, intent, events);
  }

  /**
   * Record a forward move. Re-reads the call first and writes nothing when the state
   * would not move forward, so repeated recovery runs add no events. Clears the pending
   * marker once settled. Returns the call as it stands after.
   */
  advance(event: CallEvent): CallRecord {
    const current = this.readCall(event.call_id);
    const sameTxGainsHeight =
      current?.state === event.state && event.block_height !== undefined && current.blockHeight === undefined && current.txid === event.txid;
    if (movesForward(current, event.state) || sameTxGainsHeight) this.appendEvent(event);
    const after = this.readCall(event.call_id) ?? foldEvents(event.call_id, undefined, [event]);
    if (isSettled(after.state)) this.clearPending(event.call_id);
    return after;
  }

  /**
   * Bind the txid of a signed, untransmitted transaction to the call, durably, before it
   * is transmitted. Throws when another call already owns the txid or the write fails.
   */
  stageTxid(callId: string, txid: string, ts: string): void {
    if (!this.claimTxid(txid, callId)) throw new Error("Another call already owns this transaction id.");
    this.appendEvent({ ts, call_id: callId, state: "pending", staged_txid: txid, note: "Signed, not yet transmitted.", by: "send" });
  }

  /** Which call a txid was credited to. */
  txidOwner(txid: string): string | undefined {
    return this.readJson<{ call_id: string }>(join(this.sub("txids"), safeName(txid, "txid")))?.call_id;
  }

  /**
   * The highest chain tip recorded for this wallet, or undefined. It only ever rises, so a
   * server that later reports a lower tip cannot pull an expiry proof earlier.
   */
  readTipMark(): number | undefined {
    const j = this.readJson<{ height?: unknown }>(join(this.dir, "tip.json"));
    const h = j?.height;
    return typeof h === "number" && Number.isSafeInteger(h) && h >= 0 ? h : undefined;
  }

  /** Record `height` as seen, if it is higher than the mark. Call it under the wallet lock. */
  raiseTipMark(height: number): void {
    if (!Number.isSafeInteger(height) || height < 0) return;
    const current = this.readTipMark();
    if (current !== undefined && current >= height) return;
    replaceAtomic(this.dir, "tip.json", JSON.stringify({ height, ts: new Date().toISOString() }));
  }

  /** Credit a txid to a call, once. True when it is this call's (now or before). */
  claimTxid(txid: string, callId: string): boolean {
    if (createExclusive(this.sub("txids"), safeName(txid, "txid"), JSON.stringify({ call_id: callId }))) return true;
    return this.txidOwner(txid) === callId;
  }
}

/** The store folder for a wallet directory: inside it, resolved through symlinks. */
export function walletStateDir(walletDir: string): string {
  let real: string;
  try {
    real = fs.realpathSync(walletDir);
  } catch {
    real = resolve(walletDir);
  }
  return join(real, STATE_DIR_NAME);
}

/**
 * The store for this server. A chain bound to a wallet directory names it, so every
 * process on that wallet shares it. A chain with none (the default mock, test adapters)
 * gets one beside the audit dir.
 */
export function resolveStateDir(config: Pick<Config, "auditDir">, chain: Pick<ChainAdapter, "stateDir">): string {
  return chain.stateDir ?? join(dirname(resolve(config.auditDir)), STATE_DIR_NAME);
}

const stores = new Map<string, PaymentStore>();

/**
 * The store for this config and chain, opened on first use in this process: folders
 * created and checked. Every read after that goes to disk; nothing is cached.
 */
export function storeFor(
  config: Pick<Config, "auditDir" | "auditFallbackPath">,
  chain: Pick<ChainAdapter, "stateDir"> & Partial<Pick<ChainAdapter, "mode">>
): PaymentStore {
  const store = openFor(config, chain);
  // A live wallet must have the OS lock; the mock chain may fall back to the in-process one.
  store.requireOsLock = chain.mode === "live";
  return store;
}

function openFor(config: Pick<Config, "auditDir" | "auditFallbackPath">, chain: Pick<ChainAdapter, "stateDir">): PaymentStore {
  const dir = resolveStateDir(config, chain);
  let store = stores.get(dir);
  if (!store && !chain.stateDir) {
    // No wallet dir (mock or test chain) and nowhere to write beside the audit dir: use a
    // private folder in the temp dir, one per audit dir. A wallet's store never moves.
    try {
      new PaymentStore(dir).ensureLayout();
    } catch {
      const alt = join(tmpdir(), `zshield-state-${process.getuid?.() ?? "u"}-${sha(resolve(config.auditDir)).slice(0, 16)}`);
      const cached = stores.get(alt);
      if (cached) return cached;
      return openStore(alt);
    }
  }
  if (!store) {
    store = openStore(dir);
  }
  return store;
}

/**
 * Open a store: create and check its folders. The audit log is a compliance trail and is
 * never read back into the store, so only the store's own files decide what was sent.
 */
function openStore(dir: string): PaymentStore {
  const store = new PaymentStore(dir);
  store.ensureLayout();
  if (!store.initialized) store.markInitialized("created");
  stores.set(dir, store);
  return store;
}

/** Forget opened stores, as a restart would. For tests. */
export function resetPaymentStores(): void {
  stores.clear();
  recentRefusals.clear();
}

/** Calls refused before any send, kept in memory so zcash_payment_status can report them. */
export interface Refusal {
  code?: string;
  error?: string;
  amount_zats?: string;
  idempotency_key?: string;
}
const recentRefusals = new Map<string, Refusal>();
const MAX_RECENT_REFUSALS = 1000;

/** Keep a refused call (nothing sent, nothing bound) so zcash_payment_status can report it. Bounded. */
export function rememberRefusal(callId: string, r: Refusal): void {
  recentRefusals.set(callId, r);
  if (recentRefusals.size > MAX_RECENT_REFUSALS) recentRefusals.delete(recentRefusals.keys().next().value!);
}

export function recentRefusal(callId: string): Refusal | undefined {
  return recentRefusals.get(callId);
}

/** The newest refused call that used `key`. */
export function recentRefusalByKey(key: string): { callId: string; r: Refusal } | undefined {
  let hit: { callId: string; r: Refusal } | undefined;
  for (const [callId, r] of recentRefusals) if (r.idempotency_key === key) hit = { callId, r };
  return hit;
}
