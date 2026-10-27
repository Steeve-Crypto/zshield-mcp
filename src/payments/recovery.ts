import type { ChainAdapter } from "../chain/types.js";
import { writeAuditRow } from "../audit/log.js";
import { lookalikeSends, MATCH_AFTER_MS, MATCH_SKEW_MS, matchHistory, placedInTime } from "../tools/pay.js";
import type { Config, MatchConfidence, PossibleSend } from "../types.js";
import { acquireWalletLock, BusyError, type WalletLock } from "./lock.js";
import { isSettled, storeFor, type CallEvent, type CallRecord, type CallState, type PaymentStore } from "./store.js";
import { statusSyncTimeoutMs } from "../chain/live.js";
import type { SyncResult } from "../chain/sync.js";

/**
 * Mock mode only (no chain to ask): how long after its intent a send that never showed
 * up counts as not sent. Live mode needs proof by block height instead.
 */
export const RECOVERY_EXPIRY_MS = 2 * 60 * 60_000;
/** zingo-cli builds transactions that expire this many blocks after the tip it saw. */
export const TX_EXPIRY_BLOCKS = 40;
/** Extra blocks past expiry before a missing send counts as proven not sent. */
export const EXPIRY_MARGIN_BLOCKS = 10;

/** Startup recovery handles at most this many calls per run, so one lock hold stays short. */
export const RECOVERY_MAX_CALLS = 100;
/** Once this long has passed, recovery stops after the call it is on and lets go of the lock. */
export const RECOVERY_BUDGET_MS = 120_000;
/** Recovery's own sync never runs longer than this, whatever STATUS_SYNC_TIMEOUT_MS says. */
export const RECOVERY_SYNC_MAX_MS = 120_000;
/** How long one attempt to take the wallet lock waits, and how many attempts recovery makes. */
export const RECOVERY_LOCK_WAIT_MS = 60_000;
export const RECOVERY_LOCK_ATTEMPTS = 5;
export const RECOVERY_LOCK_PAUSE_MS = 5_000;

/** Recovery outcome for a call with no settled result. */
export type RecoveryStatus = "confirmed" | "not_found" | "unknown";

export interface RecoveryAuditEntry {
  ts: string;
  tool: "zcash_pay_recovery";
  /** The call_id this resolves */
  call_id: string;
  status: RecoveryStatus;
  /** The matching transaction, when one was found */
  txid?: string;
  /** Mined height, when confirmed */
  block_height?: number;
  confidence?: MatchConfidence;
  /** Every candidate, when there was more than one or it was not yet mined */
  possible_sends?: PossibleSend[];
  idempotency_key?: string;
  /** Why the status was chosen */
  note: string;
}

/** What the wallet can prove about the chain right now. */
export interface ChainEvidence {
  /** The bounded sync finished and the wallet is within the lag limit of the tip */
  synced: boolean;
  /** The wallet's scanned height, when known */
  walletHeight?: number;
}

export interface ReconcileOptions {
  now?: number;
  offline?: boolean;
  /** Asked only when nothing matched, to decide whether "not sent" is proven */
  evidence: () => Promise<ChainEvidence>;
  /** Owner of a txid already credited to a call */
  claimedBy?: (txid: string) => string | undefined;
  /** Live rules: expiry needs proof by height. False for mock chains, which use time. */
  live: boolean;
  /**
   * How many other unsettled calls could own the same transaction (same recipient,
   * amount, and memo, started close in time). With any, a match is never confirmed: one
   * transaction cannot be told apart between identical payments.
   */
  rivals?: number;
}

/** The other unsettled calls that a transaction matching `record` could equally belong to. */
export function countRivals(store: PaymentStore, record: CallRecord): number {
  const a = record.intent;
  if (!a) return 0;
  let n = 0;
  for (const id of store.pendingCalls()) {
    if (id === record.callId) continue;
    const other = store.readCall(id);
    const b = other?.intent;
    if (!other || !b || isSettled(other.state)) continue;
    if (b.recipient !== a.recipient || b.amount_zats !== a.amount_zats || (b.memo ?? "").trim() !== (a.memo ?? "").trim()) continue;
    const gap = Math.abs(Date.parse(b.ts) - Date.parse(a.ts));
    if (Number.isNaN(gap) || gap <= MATCH_AFTER_MS + MATCH_SKEW_MS) n++;
  }
  return n;
}

/**
 * Decide what happened to one unsettled send. Never sends anything. Reads the whole
 * wallet history, never a recent slice.
 * - confirmed: exactly one mined transaction matches on recipient, amount, and memo when given.
 * - not_found: nothing matches and the payment is proven never sent: live, the wallet is
 *   synced, the whole history was read, and the wallet has scanned past the height where
 *   the transaction would have expired. Mock: the expiry window has passed.
 * - unknown: anything else. Without proof, the answer stays unknown.
 */
export async function reconcile(record: CallRecord, chain: ChainAdapter, opts: ReconcileOptions): Promise<RecoveryAuditEntry> {
  const intent = record.intent;
  const now = opts.now ?? Date.now();
  const base = {
    ts: new Date(now).toISOString(),
    tool: "zcash_pay_recovery" as const,
    call_id: record.callId,
    idempotency_key: intent?.idempotency_key,
  };
  if (!intent || intent.amount_zats === undefined) {
    return { ...base, status: "unknown", note: "The call has no recorded amount in zatoshis; check by hand." };
  }
  const startedAt = Date.parse(intent.ts);
  const target = { amountZats: BigInt(intent.amount_zats), recipient: intent.recipient, memo: intent.memo, notBeforeHeight: intent.chain_tip };
  let matches: PossibleSend[];
  let lookalikes: PossibleSend[] = [];
  const heights = new Map<string, number | undefined>();
  try {
    const txs = await chain.getHistory(Infinity, { offline: opts.offline });
    for (const t of txs) heights.set(t.txid, t.blockHeight);
    matches = matchHistory(txs, target, startedAt, opts.claimedBy, record.callId);
    if (matches.length === 0) {
      lookalikes = lookalikeSends(txs, target, startedAt, opts.claimedBy, record.callId).map((t) => ({
        txid: t.txid, confidence: "low" as const, matched: ["amount"], status: t.status,
      }));
    }
  } catch (e) {
    return { ...base, status: "unknown", note: `Wallet history could not be read: ${e instanceof Error ? e.message : String(e)}` };
  }
  const mined = matches.filter((m) => m.status === "confirmed");
  if (mined.length === 1 && matches.length === 1 && !opts.rivals && placedInTime(mined[0])) {
    const m = mined[0];
    return {
      ...base,
      status: "confirmed",
      txid: m.txid,
      block_height: heights.get(m.txid),
      confidence: m.confidence,
      note: `Mined transaction matches on ${m.matched.join(", ")}.`,
    };
  }
  if (matches.length > 0) {
    return {
      ...base,
      status: "unknown",
      possible_sends: matches,
      note:
        matches.length > 1
          ? "More than one transaction matches; check by hand. Do not pay again."
          : opts.rivals
            ? "Another unsettled payment is identical (same recipient, amount, and memo), so this transaction cannot be told apart. Check by hand. Do not pay again."
            : mined.length === 1 && !placedInTime(mined[0])
              ? "A matching mined transaction has no time and no height that places it after this call started. Check by hand. Do not pay again."
              : "A matching transaction was found but is not mined yet. Do not pay again.",
    };
  }
  if (lookalikes.length > 0) {
    return {
      ...base,
      status: "unknown",
      possible_sends: lookalikes,
      note: "No transaction matches the recipient and memo, but a sent transaction of the same amount near this time belongs to no call. It could be this send, listed in a different form. Check by hand. Do not pay again.",
    };
  }
  if (!opts.live) {
    if (now - startedAt < RECOVERY_EXPIRY_MS) {
      return { ...base, status: "unknown", note: "No match yet, and the send has not passed its expiry window." };
    }
    return { ...base, status: "not_found", note: NOT_SENT_NOTE };
  }
  const ev = await opts.evidence();
  if (!ev.synced) {
    return { ...base, status: "unknown", note: "No match, but the wallet is not synced to the chain tip, so it cannot prove the payment was not sent." };
  }
  if (intent.chain_tip === undefined) {
    return { ...base, status: "unknown", note: "No match, but this call has no recorded chain height, so expiry cannot be proven. Check by hand." };
  }
  const provenAt = intent.chain_tip + TX_EXPIRY_BLOCKS + EXPIRY_MARGIN_BLOCKS;
  if (ev.walletHeight === undefined || ev.walletHeight <= provenAt) {
    return {
      ...base,
      status: "unknown",
      note: `No match yet. The payment can only be proven not sent once the wallet has scanned past the expiry height plus margin, ${provenAt}${ev.walletHeight !== undefined ? ` (now ${ev.walletHeight})` : ""}.`,
    };
  }
  return { ...base, status: "not_found", note: NOT_SENT_NOTE };
}

const NOT_SENT_NOTE =
  "No matching transaction in the whole history of a synced wallet, scanned past the expiry height. It was not sent; a new payment needs a new idempotency key.";

/** The store event a recovery result moves the call to. */
export function eventFor(row: RecoveryAuditEntry, by: CallEvent["by"]): CallEvent {
  const state: CallState = row.status === "confirmed" ? "mined" : row.status === "not_found" ? "expired" : "unknown";
  return {
    ts: row.ts,
    call_id: row.call_id,
    state,
    txid: row.txid,
    block_height: row.block_height,
    possible_sends: row.possible_sends,
    note: row.note,
    by,
  };
}

/** Record a reconcile result in the store: claim the txid and move the call forward. */
export function recordReconcile(store: PaymentStore, row: RecoveryAuditEntry, by: CallEvent["by"]): CallRecord {
  if (row.status === "confirmed" && row.txid && !store.claimTxid(row.txid, row.call_id)) {
    // Credited to another call since the history was read: this call cannot have it.
    return store.advance({ ...eventFor({ ...row, status: "unknown", txid: undefined, note: "The matching transaction belongs to another call." }, by) });
  }
  return store.advance(eventFor(row, by));
}

export interface RecoveryOptions {
  now?: number;
  maxLagBlocks?: number;
  /** Calls per run. Default RECOVERY_MAX_CALLS. */
  maxCalls?: number;
  /** Milliseconds before the run stops taking new calls. Default RECOVERY_BUDGET_MS. */
  budgetMs?: number;
  lockWaitMs?: number;
  lockAttempts?: number;
  lockPauseMs?: number;
}

/**
 * On startup: reconcile up to RECOVERY_MAX_CALLS calls with a pending marker (the process stopped mid-send,
 * or the outcome was unknown). Holds the wallet lease while it runs, so no send overlaps
 * it, and re-reads each call fresh before deciding, so a call another process settled is
 * skipped. Writes one recovery audit row per call it decides. Never resends. Never throws.
 */
export async function recoverPendingPayments(
  config: Config,
  chain: ChainAdapter,
  opts: RecoveryOptions = {}
): Promise<RecoveryAuditEntry[]> {
  let store: PaymentStore;
  let todo: string[];
  try {
    store = storeFor(config, chain);
    todo = store.pendingCalls();
  } catch {
    return [];
  }
  if (todo.length === 0) return [];
  // A bounded wait per attempt, with the in-process queue released in between, so a long
  // send in another process neither stalls this server's own payments nor lets recovery
  // wait without end.
  let lock: WalletLock | undefined;
  const attempts = Math.max(1, opts.lockAttempts ?? RECOVERY_LOCK_ATTEMPTS);
  for (let i = 0; i < attempts && !lock; i++) {
    try {
      lock = await acquireWalletLock(store, opts.lockWaitMs ?? RECOVERY_LOCK_WAIT_MS, "recovery");
    } catch (e) {
      if (!(e instanceof BusyError)) return [];
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, opts.lockPauseMs ?? RECOVERY_LOCK_PAUSE_MS));
    }
  }
  if (!lock) return [];
  try {
    return await recoverLocked(config, chain, store, lock, todo, opts);
  } catch {
    return [];
  } finally {
    lock.release();
  }
}

async function recoverLocked(
  config: Config,
  chain: ChainAdapter,
  store: PaymentStore,
  lock: WalletLock,
  todo: string[],
  opts: RecoveryOptions
): Promise<RecoveryAuditEntry[]> {
  // Sync first, bounded, then read history offline so no read starts a sync of its own.
  const sync = await boundedSync(chain, RECOVERY_SYNC_MAX_MS);
  const evidence = chainEvidence(chain, sync, opts.maxLagBlocks ?? config.healthMaxLagBlocks ?? 10);
  // One history read for the whole run: the wallet does not change while the lease is
  // held, and N pending calls should not mean N full reads.
  let history: ReturnType<ChainAdapter["getHistory"]> | undefined;
  const once: ChainAdapter = Object.create(chain, {
    getHistory: { value: (limit: number, o?: { offline?: boolean }) => (history ??= chain.getHistory(limit, o)) },
  });
  const rows: RecoveryAuditEntry[] = [];
  const budgetMs = opts.budgetMs ?? RECOVERY_BUDGET_MS;
  const started = Date.now();
  for (const callId of todo.slice(0, opts.maxCalls ?? RECOVERY_MAX_CALLS)) {
    // Let timers run, the lease heartbeat among them, between calls.
    await new Promise<void>((r) => setImmediate(r));
    if (rows.length > 0 && Date.now() - started >= budgetMs) break;
    try {
      lock.assertHeld();
    } catch {
      break;
    }
    const record = store.readCall(callId);
    if (!record || isSettled(record.state)) {
      store.clearPending(callId);
      continue;
    }
    const row = await reconcile(record, once, {
      now: opts.now,
      offline: sync !== undefined,
      evidence,
      claimedBy: (txid) => store.txidOwner(txid),
      live: chain.checkHealth !== undefined,
      rivals: countRivals(store, record),
    });
    const before = store.readCall(callId);
    const after = recordReconcile(store, row, "recovery");
    // One audit row per decision that moved the call, so repeated runs stay quiet.
    if (!before || after.state !== before.state || after.blockHeight !== before.blockHeight || row.status === "unknown") {
      writeAuditRow(config, row);
    }
    rows.push(row);
  }
  return rows;
}

/**
 * A once-only read of what the wallet can prove: synced (the bounded sync finished, or
 * the chain has none, and the wallet is within `maxLag` blocks of the tip) and its height.
 */
export function chainEvidence(chain: ChainAdapter, sync: SyncResult | undefined, maxLag: number): () => Promise<ChainEvidence> {
  let answer: Promise<ChainEvidence> | undefined;
  return () =>
    (answer ??= (async () => {
      if (!chain.checkHealth) return { synced: true };
      if (sync !== undefined && !sync.complete) return { synced: false };
      try {
        // No sync here: callers run the bounded sync first.
        const h = await chain.checkHealth({ sync: false });
        return { synced: h.chainTip - h.walletHeight <= maxLag, walletHeight: h.walletHeight };
      } catch {
        return { synced: false };
      }
    })());
}

/**
 * The bounded sync for status and recovery, STATUS_SYNC_TIMEOUT_MS at most. The caller
 * holds the wallet lock. Undefined for a chain that has no sync (mock).
 */
export async function boundedSync(chain: ChainAdapter, maxMs = Infinity): Promise<SyncResult | undefined> {
  if (!chain.syncWallet) return undefined;
  return chain.syncWallet(Math.min(statusSyncTimeoutMs(), maxMs));
}
