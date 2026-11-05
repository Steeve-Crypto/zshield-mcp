import { assertApproval } from "./approval.js";
import { reserveSpending } from "./budget.js";
import { assertPaymentsEnabled } from "./pause.js";
import { fingerprintViewKey, writeAuditRow } from "../audit/log.js";
import { assertFingerprintSalt } from "../config.js";
import { assertTestnetAddress } from "../chain/network.js";
import { findTransaction, type ChainAdapter } from "../chain/types.js";
import { assertWithinCap } from "../policy/caps.js";
import { assertRecipientAllowed, loadAllowlist } from "../policy/allowlist.js";
import { assertPayInputBounded } from "../policy/limits.js";
import type { Config } from "../types.js";
import type { RecoveryAuditEntry } from "./recovery.js";
import { isSettled, paymentParamsHash, type CallRecord, type PaymentStore } from "./store.js";
import type { WalletLock } from "./lock.js";

/** Never constructs a new transaction. An ambiguous retry remains the SAME signed tx. */
export const RESUME_TIMEOUT_MS = 30_000;
export interface ResumeResult { row: RecoveryAuditEntry; attempted: boolean }

export function hasTransmitAuthorization(record: CallRecord): boolean {
  return record.events.some(e => e.transmit_authorized === true);
}

/**
 * Caller holds the exclusive wallet lock. Only a verified, still-calculated transaction
 * bound to this intent can be transmitted. No chain absence or error proves not_sent.
 * `explicit` permits a caller to authorize resuming an older two-step record.
 */
export async function resumeOriginal(
  config: Config, chain: ChainAdapter, store: PaymentStore, lock: WalletLock,
  record: CallRecord, explicit = false,
): Promise<ResumeResult> {
  const txid = record.stagedTxid;
  const intent = record.intent;
  const base = { ts: new Date().toISOString(), tool: "zcash_pay_recovery" as const,
    call_id: record.callId, idempotency_key: intent?.idempotency_key, txid };
  let attempted = false;
  const unknown = (note: string): ResumeResult => ({ attempted, row: { ...base, status: "unknown", note } });
  try {
    lock.assertHeld();
    if (isSettled(record.state)) return unknown("The original call is already settled; no transmission attempted.");
    if (config.chainMode !== "live" || config.chainNetwork !== "testnet" || chain.mode !== "live" || !chain.resumeSigned) {
      return unknown("This adapter cannot resume an exact signed testnet transaction.");
    }
    if (!intent?.two_step || !txid || (record.txid !== undefined && record.txid !== txid) || !/^[0-9a-f]{64}$/.test(txid) || store.txidOwner(txid) !== record.callId) {
      return unknown("There is no exclusively owned, staged transaction to resume. No replacement was built.");
    }
    if (!explicit && !hasTransmitAuthorization(record)) return unknown("Transmit was not authorized for this call.");
    // A fresh explicit request cannot revive a call already proven not_sent; the settled
    // check above preserves that proof. Original bindings are never reset or reassigned.
    const binding = intent.idempotency_key ? store.readKey(intent.idempotency_key) : undefined;
    if (!binding || binding.call_id !== record.callId || binding.params_sha256 !== paymentParamsHash(intent)) {
      return unknown("The original idempotency binding does not match its intent.");
    }
    assertFingerprintSalt(config);
    assertPayInputBounded(intent.recipient, intent.memo);
    assertTestnetAddress(intent.recipient);
    const amount = assertWithinCap(intent.amount_zec, config.spendingCapZec);
    if (amount.toString() !== intent.amount_zats) return unknown("The original amount fields disagree.");
    assertRecipientAllowed(intent.recipient, loadAllowlist(config.allowlistPath));
    const fingerprint = fingerprintViewKey(await chain.getViewingKey(), config.viewKeyFingerprintSalt);
    if (!intent.view_key_fingerprint || fingerprint !== intent.view_key_fingerprint) {
      return unknown("The wallet fingerprint differs from the original authorization.");
    }
    const entries = await findTransaction(chain, txid, { offline: true });
    if (entries.length !== 1 || entries[0].txid !== txid || entries[0].verified !== true) {
      return unknown("The wallet cannot verify exactly one original transaction. No replacement was built.");
    }
    const entry = entries[0];
    const outputs = entry.outgoing;
    if (entry.kind !== "sent" || entry.valueZats !== amount || outputs?.length !== 1 ||
        !(outputs[0].recipient === intent.recipient || outputs[0].unifiedAddress === intent.recipient) ||
        outputs[0].valueZats !== amount || outputs[0].memo !== (intent.memo ?? "")) {
      return unknown("The wallet transaction outputs do not match the original intent.");
    }
    if (entry.status === "confirmed") return { attempted, row: { ...base, status: "confirmed", block_height: entry.blockHeight, confidence: "high", note: "The original transaction is already mined; nothing retransmitted." } };
    if (entry.status === "transmitted" || entry.status === "mempool") return { attempted, row: { ...base, status: "broadcast", confidence: "high", note: "The original transaction is already transmitted; nothing retransmitted." } };
    if (entry.status !== "calculated") return unknown("The original transaction is not in a resumable calculated state. No replacement was built.");
    assertPaymentsEnabled(store);
    assertApproval(config, store, intent.idempotency_key!, paymentParamsHash(intent), fingerprint);
    // Record financial evidence BEFORE a possible network mutation. A failed write or
    // capacity refusal must not be bypassed by calling this a diagnostic replay.
    const audit = writeAuditRow(config, { ...base, status: "unknown", note: "Resuming only the originally signed transaction by exact txid; no replacement transaction authorized." });
    if (!audit.durable) return unknown("Audit evidence could not be persisted; no resume attempted.");
    reserveSpending(config, store, lock, record.callId, amount, paymentParamsHash(intent), intent.idempotency_key!);
    if (!hasTransmitAuthorization(record)) store.authorizeTransmit(record.callId, new Date().toISOString());
    lock.assertHeld();
    attempted = true;
    await chain.resumeSigned(txid, { fence: () => { lock.assertHeld(); assertPaymentsEnabled(store); assertApproval(config, store, intent.idempotency_key!, paymentParamsHash(intent), fingerprint); reserveSpending(config, store, lock, record.callId, amount, paymentParamsHash(intent), intent.idempotency_key!); }, timeoutMs: RESUME_TIMEOUT_MS });
    return { attempted, row: { ...base, status: "broadcast", confidence: "high", note: "Resumed the original signed transaction by exact txid. No replacement was built." } };
  } catch {
    // Even a proven refusal of THIS retry says nothing about the FIRST attempt.
    return unknown("The original transaction remains unresolved after the resume attempt. Retry the same key with resume=true, or check payment_status. Never substitute a new payment key.");
  }
}
