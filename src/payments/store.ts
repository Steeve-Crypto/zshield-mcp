import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createExclusive, ensurePrivateDir, readPrivate, replaceAtomic } from "../fsafe.js";
import { fallbackAuditPath } from "../audit/log.js";
import { parseZecToZats } from "../policy/amount.js";
import type { ChainAdapter } from "../chain/types.js";
import type { AuditEntry, Config, PossibleSend } from "../types.js";

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
export type CallState = "pending" | "unknown" | "not_sent" | "expired" | "sent" | "mined";
export const STATE_RANK: Record<CallState, number> = { pending: 0, unknown: 1, not_sent: 2, expired: 2, sent: 3, mined: 4 };

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
  /** The chain tip the pre-send check saw. Used to prove expiry later */
  chain_tip?: number;
  /** Where it came from when imported from an older audit log */
  imported?: boolean;
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
  /** Who wrote it */
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
  return { callId, intent, state: top?.state ?? "pending", top, txid, blockHeight, events };
}

/** Whether `next` moves a call in `current` state forward. */
export function movesForward(current: CallRecord | undefined, next: CallState): boolean {
  return STATE_RANK[next] > STATE_RANK[current?.state ?? "pending"];
}

export class PaymentStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private sub(name: "keys" | "calls" | "pending" | "txids" | "imports"): string {
    return join(this.dir, name);
  }

  /** Create the folders (0700) if needed and repair loose modes. Returns repair notes. */
  ensureLayout(): string[] {
    const notes: string[] = [];
    for (const d of [this.dir, this.sub("keys"), this.sub("calls"), this.sub("pending"), this.sub("txids"), this.sub("imports")]) {
      const n = ensurePrivateDir(d);
      if (n) notes.push(n);
    }
    return notes;
  }

  get initialized(): boolean {
    return readPrivate(join(this.dir, "meta.json"), MAX_FILE_BYTES) !== undefined;
  }

  /** Whether the audit log with this tag was already imported. */
  hasImported(tag: string): boolean {
    return fs.existsSync(join(this.sub("imports"), safeName(tag, "import tag")));
  }

  markImported(tag: string, note: string): void {
    createExclusive(this.sub("imports"), safeName(tag, "import tag"), JSON.stringify({ ts: new Date().toISOString(), note }));
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

  /** Which call a txid was credited to. */
  txidOwner(txid: string): string | undefined {
    return this.readJson<{ call_id: string }>(join(this.sub("txids"), safeName(txid, "txid")))?.call_id;
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
 * created and checked, and, the first time the store is ever created, payments imported
 * from this config's audit log. Every read after that goes to disk; nothing is cached.
 */
export function storeFor(config: Pick<Config, "auditDir" | "auditFallbackPath">, chain: Pick<ChainAdapter, "stateDir">): PaymentStore {
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
      return openStore(alt, config);
    }
  }
  if (!store) {
    store = openStore(dir, config);
  }
  return store;
}

/**
 * Open a store: create and check its folders, then import this config's audit log if no
 * process with the same audit paths has done so. Each audit dir is imported once, so a
 * second server on the wallet with its own older audit log brings its keys along too.
 */
function openStore(dir: string, config: Pick<Config, "auditDir" | "auditFallbackPath">): PaymentStore {
  const store = new PaymentStore(dir);
  store.ensureLayout();
  const auditDir = resolve(config.auditDir);
  const tag = sha(`${auditDir}\0${fallbackAuditPath(auditDir, config.auditFallbackPath)}`).slice(0, 32);
  if (!store.hasImported(tag)) {
    const n = importAuditLog(store, config);
    store.markImported(tag, `imported ${n} payments`);
  }
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

/**
 * One-time import of zcash_pay calls that reached their pending row, from the audit log
 * of the process that creates the store. Every write is exclusive, so two processes
 * importing at once write each fact once. Old `not_found` recovery rows came from a
 * truncated history, so they import as `unknown`. Returns how many calls were imported.
 */
export function importAuditLog(store: PaymentStore, target: { auditDir: string; auditFallbackPath?: string }): number {
  const files: string[] = [];
  try {
    for (const f of fs.readdirSync(target.auditDir).sort()) if (f.endsWith(".jsonl")) files.push(join(target.auditDir, f));
  } catch {
    // No audit log yet.
  }
  files.push(fallbackAuditPath(target.auditDir, target.auditFallbackPath));
  type Row = Omit<AuditEntry, "tool" | "status"> & { tool: string; status: string; txid?: string; block_height?: number; note?: string };
  const byCall = new Map<string, { intent?: Row; result?: Row; recovery: Row[] }>();
  for (const f of files) {
    let text: string;
    try {
      const lst = fs.lstatSync(f);
      if (!lst.isFile()) continue;
      text = fs.readFileSync(f, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let row: Row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof row?.call_id !== "string" || !NAME.test(row.call_id)) continue;
      const slot = byCall.get(row.call_id) ?? { recovery: [] };
      if (row.tool === "zcash_pay" && row.status === "pending") slot.intent = row;
      else if (row.tool === "zcash_pay" && row.status !== "replayed") slot.result = row;
      else if (row.tool === "zcash_pay_recovery") slot.recovery.push(row);
      else continue;
      byCall.set(row.call_id, slot);
    }
  }
  let n = 0;
  for (const [callId, c] of byCall) {
    const i = c.intent;
    if (!i || i.amount_zats === undefined) continue;
    n++;
    store.writeIntent({
      call_id: callId,
      ts: i.ts,
      amount_zec: i.amount_zec,
      amount_zats: i.amount_zats,
      recipient: i.recipient,
      memo: i.memo,
      allowlist_hit: i.allowlist_hit,
      cap_zec: i.cap_zec,
      view_key_fingerprint: i.view_key_fingerprint,
      idempotency_key: i.idempotency_key,
      params_sha256: i.params_sha256,
      chain_tip: typeof i.chain_tip === "number" ? i.chain_tip : undefined,
      imported: true,
    });
    if (i.idempotency_key && i.params_sha256) store.bindKey(i.idempotency_key, callId, i.params_sha256);
    const events: CallEvent[] = [];
    const r = c.result;
    if (r?.status === "ok") events.push({ ts: r.ts, call_id: callId, state: "sent", txid: r.mock_txid, by: "import" });
    else if (r?.status === "error" || r?.status === "rejected")
      events.push({ ts: r.ts, call_id: callId, state: "not_sent", code: r.code, error: r.error, by: "import" });
    else if (r?.status === "unknown")
      events.push({ ts: r.ts, call_id: callId, state: "unknown", code: r.code, error: r.error, possible_sends: r.possible_sends, by: "import" });
    for (const rec of c.recovery) {
      if (rec.status === "confirmed" && rec.txid)
        events.push({ ts: rec.ts, call_id: callId, state: "mined", txid: rec.txid, block_height: rec.block_height, note: rec.note, by: "import" });
      else events.push({ ts: rec.ts, call_id: callId, state: "unknown", possible_sends: rec.possible_sends, note: "Imported from an older recovery row, which could not prove the payment was not sent.", by: "import" });
    }
    let i2 = 0;
    for (const e of events) {
      const dir = join(store.dir, "calls", safeName(callId, "call id"));
      createExclusive(dir, `000000000000000-import-${String(i2++).padStart(3, "0")}.json`, JSON.stringify(e));
      if (e.txid) store.claimTxid(e.txid, callId);
    }
    const after = store.readCall(callId)!;
    if (isSettled(after.state)) store.clearPending(callId);
  }
  return n;
}
