import { z } from "zod";
import { TESTNET_EXPLORER } from "../chain/live.js";
import type { ChainAdapter } from "../chain/types.js";
import { paymentIndexFor, type PaymentRecord } from "../payments/index.js";
import { reconcile, RECOVERY_EXPIRY_MS, walletSynced } from "../payments/recovery.js";
import type { AuditEntry, Config, PossibleSend } from "../types.js";
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
}

function lookup(config: Config, input: PaymentStatusInput): { callId: string; record?: PaymentRecord; key?: string } {
  const byCall = typeof input.call_id === "string" && input.call_id !== "";
  const byKey = typeof input.idempotency_key === "string" && input.idempotency_key !== "";
  if (byCall === byKey) {
    throw new ReadRejection("INVALID_LOOKUP", "Give exactly one of call_id or idempotency_key.");
  }
  const index = paymentIndexFor(config);
  if (byCall) {
    const record = index.byCallId(input.call_id!);
    if (!record) throw new ReadRejection("PAYMENT_NOT_FOUND", "No zcash_pay call with this call_id in the audit log.");
    return { callId: record.callId, record, key: record.idempotencyKey ?? record.intent?.idempotency_key };
  }
  const hit = index.byIdempotencyKey(input.idempotency_key!);
  if (!hit) throw new ReadRejection("PAYMENT_NOT_FOUND", "No zcash_pay call with this idempotency_key in the audit log.");
  return { callId: hit.callId, record: hit.record, key: input.idempotency_key };
}

/** Look a known txid up in wallet history: mined, broadcast, or failed. */
async function byTxid(chain: ChainAdapter, txid: string, sentAt: number, now: number): Promise<Partial<PaymentStatus> & { state: PaymentState; message: string }> {
  const tx = (await chain.getHistory(50)).find((t) => t.txid === txid);
  if (!tx) {
    return now - sentAt < RECOVERY_EXPIRY_MS
      ? { state: "broadcast", txid, message: "Sent; not in the wallet's history yet." }
      : { state: "unknown", txid, message: "Sent, but not in the wallet's recent history. Check the explorer." };
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

/** Work out where one call stands. Read-only: never sends, never writes a pay row. */
export async function paymentStatus(
  config: Config,
  chain: ChainAdapter,
  input: PaymentStatusInput,
  now = Date.now()
): Promise<PaymentStatus> {
  const { callId, record, key } = lookup(config, input);
  const base = { call_id: callId, idempotency_key: key };
  // Reserved by a call still running in this process.
  if (!record) return { ...base, state: "pending", message: "The payment is being sent now." };
  const result = record.result;
  const intent = record.intent as AuditEntry | undefined;
  const amount = (result ?? intent)?.amount_zats;
  const started = Date.parse((intent ?? result)!.ts);

  if (result?.status === "rejected" || result?.status === "error") {
    return {
      ...base,
      state: "failed",
      amount_zats: amount,
      code: result.code,
      message: `Not sent: ${result.error ?? result.code ?? result.status}.`,
    };
  }
  if (result?.status === "ok" && result.mock_txid) {
    return { ...base, amount_zats: amount, ...(await byTxid(chain, result.mock_txid, started, now)) };
  }
  if (record.recovery?.status === "confirmed" && record.recovery.txid) {
    return { ...base, amount_zats: amount, ...(await byTxid(chain, record.recovery.txid, started, now)) };
  }
  if (record.recovery?.status === "not_found") {
    return { ...base, state: "expired", amount_zats: amount, message: record.recovery.note };
  }
  if (!intent) return { ...base, state: "unknown", amount_zats: amount, code: result?.code, message: "No pending row to check against." };

  // Outcome not recorded (SEND_UNCONFIRMED, or the process stopped mid-send): look for it.
  const r = await reconcile(record, chain, { now, synced: walletSynced(chain, config.healthMaxLagBlocks ?? 10) });
  const common = { ...base, amount_zats: amount, code: result?.code };
  if (r.status === "confirmed" && r.txid) return { ...common, ...(await byTxid(chain, r.txid, started, now)) };
  if (r.status === "not_found") return { ...common, state: "expired", message: r.note };
  const candidates = r.possible_sends ?? [];
  if (candidates.length === 1 && candidates[0].status !== "failed") {
    return { ...common, state: "broadcast", txid: candidates[0].txid, possible_sends: candidates, message: r.note };
  }
  return {
    ...common,
    state: candidates.length === 0 && now - started < RECOVERY_EXPIRY_MS ? "pending" : "unknown",
    possible_sends: candidates.length ? candidates : undefined,
    message: r.note,
  };
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
