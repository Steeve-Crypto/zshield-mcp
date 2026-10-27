import { z } from "zod";
import { TESTNET_EXPLORER } from "../chain/live.js";
import type { ChainAdapter } from "../chain/types.js";
import { recentRefusal, recentRefusalByKey, storeFor, type CallRecord, type PaymentStore } from "../payments/store.js";
import { boundedSync, chainEvidence, countRivals, reconcile, recordReconcile, RECOVERY_EXPIRY_MS } from "../payments/recovery.js";
import { acquireWalletLock, BusyError, type WalletLock } from "../payments/lock.js";
import { inFlightCall, placedInTime } from "./pay.js";
import type { Config, PossibleSend } from "../types.js";
import type { SyncResult } from "../chain/sync.js";
import { ReadRejection, runReadTool, type ReadDeps } from "./read.js";

/** Where a zcash_pay call stands. */
export type PaymentState = "pending" | "broadcast" | "mined" | "expired" | "failed" | "unknown";

export const paymentStatusInputSchema = z.object({
  // Kept loose here so a bad lookup reaches executePaymentStatus and is audited as a rejection.
  call_id: z.string().optional().describe("The call_id a zcash_pay response returned."),
  idempotency_key: z.string().optional().describe("The idempotency_key passed to zcash_pay. Give this or call_id, not both."),
});

export type PaymentStatusInput = z.infer<typeof paymentStatusInputSchema>;

export interface PaymentStatus {
  call_id: string;
  idempotency_key?: string;
  state: PaymentState;
  txid?: string;
  block_height?: number;
  confirmations?: number;
  wallet_height?: number;
  amount_zats?: string;
  code?: string;
  possible_sends?: PossibleSend[];
  message: string;
  /**
   * Set when the wallet could not be synced first (the sync timed out, or a send held the
   * wallet). The state is the last one the wallet knew; wallet_height says how far it got.
   */
  stale?: boolean;
  sync_note?: string;
}

type Lookup =
  | { callId: string; key?: string; record: CallRecord; store: PaymentStore }
  | { callId: string; key?: string; inFlight: true }
  | { callId: string; key?: string; refused: { code?: string; error?: string; amount_zats?: string } };

/** Find the call in the wallet's payment store: one or two small file reads, never a scan. */
function lookup(config: Config, chain: ChainAdapter, input: PaymentStatusInput): Lookup {
  const byCall = typeof input.call_id === "string" && input.call_id !== "";
  const byKey = typeof input.idempotency_key === "string" && input.idempotency_key !== "";
  if (byCall === byKey) {
    throw new ReadRejection("INVALID_LOOKUP", "Give exactly one of call_id or idempotency_key.");
  }
  const store = storeFor(config, chain);
  if (byCall) {
    const callId = input.call_id!;
    const record = store.readCall(callId);
    if (record) return { callId, key: record.intent?.idempotency_key, record, store };
    const refused = recentRefusal(callId);
    if (refused) return { callId, refused };
    throw new ReadRejection("PAYMENT_NOT_FOUND", "No zcash_pay call with this call_id for this wallet.");
  }
  const key = input.idempotency_key!;
  const bound = store.readKey(key);
  if (bound) {
    const record = store.readCall(bound.call_id);
    if (record) return { callId: bound.call_id, key, record, store };
    return { callId: bound.call_id, key, inFlight: true };
  }
  const flying = inFlightCall(store, key);
  if (flying) return { callId: flying, key, inFlight: true };
  const refused = recentRefusalByKey(key);
  if (refused) return { callId: refused.callId, key, refused: refused.r };
  throw new ReadRejection("PAYMENT_NOT_FOUND", "No zcash_pay call with this idempotency_key for this wallet.");
}

/** Look a known txid up in the whole wallet history: mined, broadcast, or failed. */
async function byTxid(
  chain: ChainAdapter,
  txid: string,
  sentAt: number,
  now: number,
  offline: boolean
): Promise<Partial<PaymentStatus> & { state: PaymentState; message: string }> {
  const tx = (await chain.getHistory(Infinity, { offline })).find((t) => t.txid === txid);
  if (!tx) {
    return now - sentAt < RECOVERY_EXPIRY_MS
      ? { state: "broadcast", txid, message: "Sent; not in the wallet's history yet." }
      : { state: "unknown", txid, message: "Sent, but not in the wallet's history. Check the explorer. Do not pay again." };
  }
  if (tx.status === "failed") return { state: "failed", txid, message: "The wallet marks this transaction failed." };
  if (tx.status !== "confirmed") return { state: "broadcast", txid, message: `Sent; the wallet reports it as ${tx.status}.` };
  let walletHeight: number | undefined;
  try {
    walletHeight = await chain.walletHeight?.();
  } catch {
    walletHeight = undefined;
  }
  const confirmations =
    walletHeight !== undefined && tx.blockHeight !== undefined ? Math.max(walletHeight - tx.blockHeight + 1, 0) : undefined;
  return {
    state: "mined",
    txid,
    block_height: tx.blockHeight,
    confirmations,
    wallet_height: walletHeight,
    message: tx.blockHeight !== undefined ? `Mined at height ${tx.blockHeight}.` : "Mined.",
  };
}

/**
 * Work out where one call stands. Never sends and never writes an audit row. It may move
 * the call forward in the payment store (to mined, or to expired once proven), the same
 * forward-only moves recovery makes.
 */
export async function paymentStatus(
  config: Config,
  chain: ChainAdapter,
  input: PaymentStatusInput,
  now = Date.now()
): Promise<PaymentStatus> {
  const found = lookup(config, chain, input);
  const base = { call_id: found.callId, idempotency_key: found.key };
  if ("inFlight" in found) return { ...base, state: "pending", message: "The payment is being sent now." };
  if ("refused" in found) {
    const r = found.refused;
    return { ...base, state: "failed", amount_zats: r.amount_zats, code: r.code, message: `Not sent: ${r.error ?? r.code ?? "refused"}.` };
  }
  const settled = settledStatus(found.record, base);
  if (settled) return settled;
  if (!chain.syncWallet) return fromChain(config, chain, found.store, found.record, base, now, undefined);

  // Live: sync first, bounded by STATUS_SYNC_TIMEOUT_MS, so a mined payment reads as
  // mined. Only while no send holds the wallet; never wait for one.
  let lock: WalletLock | undefined;
  try {
    lock = await acquireWalletLock(found.store, 0, "zcash_payment_status");
  } catch (e) {
    if (!(e instanceof BusyError)) throw e;
  }
  try {
    const sync = lock ? await boundedSync(chain) : undefined;
    // Re-read: another process may have settled the call while this one synced.
    const record = found.store.readCall(found.callId) ?? found.record;
    const s = settledStatus(record, base) ?? (await fromChain(config, chain, found.store, record, base, now, sync ?? { complete: false, elapsedMs: 0, detail: "not synced" }));
    if (sync?.complete) return s;
    let walletHeight = s.wallet_height;
    if (walletHeight === undefined) {
      try {
        walletHeight = await chain.walletHeight?.();
      } catch {
        walletHeight = undefined;
      }
    }
    return {
      ...s,
      stale: true,
      wallet_height: walletHeight,
      sync_note: lock
        ? `Wallet sync did not finish: ${sync?.detail ?? "no detail"}. This is the last state the wallet knew.`
        : "Another send or sync holds the wallet, so it was not synced. This is the last state the wallet knew.",
    };
  } finally {
    lock?.release();
  }
}

const FAILED_NOTE = "The wallet marked this transaction failed.";

function failedStatus(base: { call_id: string; idempotency_key?: string }, amount: string | undefined, txid: string | undefined, message: string): PaymentStatus {
  return { ...base, state: "failed", txid, amount_zats: amount, code: "PAYMENT_FAILED", message };
}

/** The answer for a call whose state needs no chain read: not sent, or proven expired. */
function settledStatus(record: CallRecord, base: { call_id: string; idempotency_key?: string }): PaymentStatus | undefined {
  const amount = record.intent?.amount_zats;
  if (record.state === "not_sent") {
    const top = record.top;
    return { ...base, state: "failed", amount_zats: amount, code: top?.code, message: `Not sent: ${top?.error ?? top?.code ?? "refused"}.` };
  }
  if (record.state === "expired") {
    return { ...base, state: "expired", amount_zats: amount, code: "PAYMENT_EXPIRED", message: record.top?.note ?? "Proven not sent." };
  }
  return undefined;
}

async function fromChain(
  config: Config,
  chain: ChainAdapter,
  store: PaymentStore,
  record: CallRecord,
  base: { call_id: string; idempotency_key?: string },
  now: number,
  sync: SyncResult | undefined
): Promise<PaymentStatus> {
  // Live reads are offline: the bounded sync, if any, already ran under the lock.
  const offline = chain.syncWallet !== undefined;
  const intent = record.intent;
  const amount = intent?.amount_zats;
  const started = intent ? Date.parse(intent.ts) : now;
  const common = { ...base, amount_zats: amount, code: record.top?.code };

  if (record.txid && (record.state === "sent" || record.state === "mined" || record.state === "failed")) {
    const s = await byTxid(chain, record.txid, started, now, offline);
    if (s.state === "failed" && record.state === "sent") {
      // The wallet now marks a transaction this server reported as sent as failed. Record
      // it, so a replay of the same key reports it too instead of a success.
      safely(() => store.advance({ ts: new Date(now).toISOString(), call_id: record.callId, state: "failed", txid: record.txid, code: "PAYMENT_FAILED", note: s.message, by: "status" }));
    }
    if (record.state === "failed" && s.state !== "failed" && s.state !== "mined") {
      return failedStatus(base, amount, record.txid, `${record.top?.note ?? FAILED_NOTE} The wallet now reports it as ${s.state}; the failed record stays. Check the explorer. Do not pay again with this key.`);
    }
    if (s.state === "failed" && record.state !== "mined") return failedStatus(base, amount, record.txid, s.message);
    if (s.state === "mined") safely(() => store.advance({ ts: new Date(now).toISOString(), call_id: record.callId, state: "mined", txid: record.txid, block_height: s.block_height, by: "status" }));
    if (record.state === "mined" && s.state !== "mined") {
      // Seen mined before. A read that no longer shows it (a reorg, or a wallet rescan)
      // never moves the call back; report what was recorded and why it may look different.
      return {
        ...base,
        amount_zats: amount,
        state: "mined",
        txid: record.txid,
        block_height: record.blockHeight,
        message: `Mined${record.blockHeight !== undefined ? ` at height ${record.blockHeight}` : ""} when last seen; the wallet now reports it as ${s.state}. Check the explorer. Do not pay again.`,
      };
    }
    // A txid the send itself returned was broadcast; never report it as anything less.
    return { ...base, amount_zats: amount, ...s };
  }
  if (!intent) return { ...common, state: "unknown", message: "No intent recorded to check against. Do not pay again." };

  // Outcome not recorded (SEND_UNCONFIRMED, or the process stopped mid-send): look for it.
  const rivals = safely(() => countRivals(store, record)) ?? 1;
  const r = await reconcile(record, chain, {
    now,
    offline,
    evidence: chainEvidence(chain, offline ? sync : undefined, config.healthMaxLagBlocks ?? 10, () => safely(() => store.readTipMark())),
    claimedBy: (txid) => safeOwner(store, txid),
    live: chain.checkHealth !== undefined,
    rivals,
  });
  const after = safely(() => recordReconcile(store, r, "status"));
  if (r.status === "confirmed" && r.txid && (!after || after.txid === r.txid)) {
    return { ...common, ...(await byTxid(chain, r.txid, started, now, offline)) };
  }
  if (r.status === "not_found") return { ...common, state: "expired", code: "PAYMENT_EXPIRED", message: r.note };
  const candidates = r.possible_sends ?? [];
  if (candidates.length === 1 && candidates[0].status !== "failed" && placedInTime(candidates[0]) && !rivals) {
    return { ...common, state: "broadcast", txid: candidates[0].txid, possible_sends: candidates, message: r.note };
  }
  return {
    ...common,
    state: candidates.length === 0 && record.state === "pending" && now - started < RECOVERY_EXPIRY_MS ? "pending" : "unknown",
    possible_sends: candidates.length ? candidates : undefined,
    message: r.note,
  };
}

function safely<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

function safeOwner(store: PaymentStore, txid: string): string | undefined {
  return safely(() => store.txidOwner(txid));
}

/** Read-only: where a zcash_pay call stands, by call_id or idempotency_key. */
export async function executePaymentStatus(input: PaymentStatusInput, deps: ReadDeps) {
  const live = deps.config.chainMode === "live";
  let ref: string | undefined;
  return runReadTool<PaymentStatus>(
    "zcash_payment_status",
    deps.config,
    async () => {
      const s = await paymentStatus(deps.config, deps.chain, input);
      ref = s.call_id;
      return s;
    },
    (s) => ({ ...s, explorer_url: live && s.txid ? `${TESTNET_EXPLORER}${s.txid}` : undefined }),
    () => (ref ? { ref_call_id: ref } : {})
  );
}
