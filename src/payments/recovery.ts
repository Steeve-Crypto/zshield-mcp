import type { ChainAdapter } from "../chain/types.js";
import { writeAuditRow } from "../audit/log.js";
import { matchSend } from "../tools/pay.js";
import type { AuditEntry, Config, MatchConfidence, PossibleSend } from "../types.js";
import { paymentIndexFor, type PaymentRecord } from "./index.js";
import { acquireWalletLock, SEND_QUEUE_WAIT_MAX_MS } from "./lock.js";
import { statusSyncTimeoutMs } from "../chain/live.js";
import type { SyncResult } from "../chain/sync.js";

/**
 * How long after its pending row a send that never showed up counts as not sent. zingo-cli
 * builds transactions that expire 40 blocks (about 50 minutes) after their target height;
 * two hours leaves room for a slow first broadcast.
 */
export const RECOVERY_EXPIRY_MS = 2 * 60 * 60_000;

/** Recovery outcome for a send that has a pending row and no result row. */
export type RecoveryStatus = "confirmed" | "not_found" | "unknown";

export interface RecoveryAuditEntry {
  ts: string;
  tool: "zcash_pay_recovery";
  /** The call_id of the pending row this resolves */
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

/**
 * Decide what happened to one interrupted send. Never sends anything.
 * - confirmed: a mined transaction matches on recipient, amount, and memo when given.
 * - not_found: nothing matches, the wallet is synced, and the expiry window has passed.
 * - unknown: anything else, including a match that is not mined yet.
 */
export async function reconcile(
  record: PaymentRecord,
  chain: ChainAdapter,
  opts: { now?: number; synced: boolean | (() => Promise<boolean>); offline?: boolean }
): Promise<RecoveryAuditEntry> {
  const intent = record.intent as AuditEntry;
  const now = opts.now ?? Date.now();
  const startedAt = Date.parse(intent.ts);
  const base = {
    ts: new Date(now).toISOString(),
    tool: "zcash_pay_recovery" as const,
    call_id: record.callId,
    idempotency_key: record.idempotencyKey ?? (record.intent as AuditEntry).idempotency_key,
  };
  if (intent.amount_zats === undefined) {
    return { ...base, status: "unknown", note: "Pending row has no amount in zatoshis; check by hand." };
  }
  const target = { amountZats: BigInt(intent.amount_zats), recipient: intent.recipient, memo: intent.memo };
  let matches: PossibleSend[];
  let heights = new Map<string, number | undefined>();
  try {
    const txs = await chain.getHistory(50, { offline: opts.offline });
    matches = [];
    for (const t of txs) {
      const m = matchSend(t, target, startedAt);
      if (m) {
        matches.push(m);
        heights.set(t.txid, t.blockHeight);
      }
    }
  } catch (e) {
    return { ...base, status: "unknown", note: `Wallet history could not be read: ${e instanceof Error ? e.message : String(e)}` };
  }
  const mined = matches.filter((m) => m.status === "confirmed");
  if (mined.length === 1) {
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
        mined.length > 1
          ? "More than one mined transaction matches; check by hand."
          : "A matching transaction was found but is not mined yet.",
    };
  }
  if (now - startedAt >= RECOVERY_EXPIRY_MS && !(typeof opts.synced === "function" ? await opts.synced() : opts.synced)) {
    return { ...base, status: "unknown", note: "No match, but the wallet is not synced to the chain tip." };
  }
  if (now - startedAt < RECOVERY_EXPIRY_MS) {
    return { ...base, status: "unknown", note: "No match yet, and the send has not passed its expiry window." };
  }
  return {
    ...base,
    status: "not_found",
    note: "No matching transaction in a synced wallet after the expiry window. It was not sent; a new payment needs a new idempotency key.",
  };
}

/**
 * On startup: find sends with a pending row and no result row (the process stopped
 * mid-send), reconcile each against wallet history, and write one recovery row each.
 * Rows already settled by an earlier recovery (confirmed or not_found) are skipped.
 * Holds the wallet's send lock while it runs, so no send overlaps it and two zingo-cli
 * runs never share the wallet. Never resends. Never throws.
 */
export async function recoverPendingPayments(
  config: Config,
  chain: ChainAdapter,
  opts: { now?: number; maxLagBlocks?: number } = {}
): Promise<RecoveryAuditEntry[]> {
  const index = paymentIndexFor(config);
  const todo = index.unresolved();
  if (todo.length === 0) return [];
  let release: () => void;
  try {
    release = await acquireWalletLock(chain, SEND_QUEUE_WAIT_MAX_MS, "recovery");
  } catch {
    return [];
  }
  try {
    return await recoverLocked(config, chain, todo, opts);
  } finally {
    release();
  }
}

async function recoverLocked(
  config: Config,
  chain: ChainAdapter,
  todo: PaymentRecord[],
  opts: { now?: number; maxLagBlocks?: number }
): Promise<RecoveryAuditEntry[]> {
  const index = paymentIndexFor(config);
  // Sync first, bounded, then read history offline so no read starts a sync of its own.
  const sync = await boundedSync(chain);
  const lagOk = walletSynced(chain, opts.maxLagBlocks ?? config.healthMaxLagBlocks ?? 10);
  const synced = async () => (sync === undefined || sync.complete) && (await lagOk());
  const rows: RecoveryAuditEntry[] = [];
  for (const record of todo) {
    const row = await reconcile(record, chain, { now: opts.now, synced, offline: sync !== undefined });
    writeAuditRow(config, row);
    index.recordRecovery(row);
    rows.push(row);
  }
  return rows;
}

/**
 * A once-only check that the wallet is within `maxLag` blocks of the chain tip. Asks the
 * server only when first called. A chain with no health check (mock) counts as synced.
 */
export function walletSynced(chain: ChainAdapter, maxLag: number): () => Promise<boolean> {
  let answer: Promise<boolean> | undefined;
  return () =>
    (answer ??= (async () => {
      if (!chain.checkHealth) return true;
      try {
        // No sync here: callers run the bounded sync first.
        const h = await chain.checkHealth({ sync: false });
        return h.chainTip - h.walletHeight <= maxLag;
      } catch {
        return false;
      }
    })());
}

/**
 * The bounded sync for status and recovery, STATUS_SYNC_TIMEOUT_MS at most. The caller
 * holds the wallet lock. Undefined for a chain that has no sync (mock).
 */
export async function boundedSync(chain: ChainAdapter): Promise<SyncResult | undefined> {
  if (!chain.syncWallet) return undefined;
  return chain.syncWallet(statusSyncTimeoutMs());
}
