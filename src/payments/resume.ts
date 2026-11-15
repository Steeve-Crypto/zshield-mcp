import { assertApproval } from "./approval.js";
import { authorizeCharged, checkSpending, paymentIdentity } from "./budget.js";
import { assertPaymentsEnabled } from "./pause.js";
import { fingerprintViewKey, writeAuditRow } from "../audit/log.js";
import { assertFingerprintSalt } from "../config.js";
import { assertNetworkAddress } from "../chain/network.js";
import { findTransaction, type ChainAdapter } from "../chain/types.js";
import { assertWithinCap, PolicyError } from "../policy/caps.js";
import { assertRecipientAllowed, loadAllowlist } from "../policy/allowlist.js";
import { assertPayInputBounded } from "../policy/limits.js";
import type { Config } from "../types.js";
import type { RecoveryAuditEntry } from "./recovery.js";
import { isSettled, mayHaveBroadcast, paymentParamsHash, type CallRecord, type PaymentStore } from "./store.js";
import type { WalletLock } from "./lock.js";

/** Never constructs a new transaction. An ambiguous retry remains the SAME signed tx. */
export const RESUME_TIMEOUT_MS = 30_000;
class ResumeAuditError extends Error {}
export interface ResumeResult { row: RecoveryAuditEntry; attempted: boolean }

export function hasTransmitAuthorization(record: CallRecord): boolean {
  return record.events.some(e => e.transmit_authorized === true);
}

/**
 * Caller holds the exclusive wallet lock. Only a verified, still-calculated transaction
 * bound to this intent can be transmitted. No chain absence or error proves not_sent.
 * `explicit` permits legacy two-step recovery, never revival of tracked non-sends.
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
    if (config.chainMode !== "live" || !["testnet", "mainnet"].includes(config.chainNetwork ?? "") || chain.mode !== "live" || !chain.resumeSigned) {
      return unknown("This adapter cannot resume an exact signed transaction.");
    }
    if (!intent?.two_step || !txid || (record.txid !== undefined && record.txid !== txid) || !/^[0-9a-f]{64}$/.test(txid) || store.txidOwner(txid) !== record.callId) {
      return unknown("There is no exclusively owned, staged transaction to resume. No replacement was built.");
    }
    // The same proof that permits a replacement must forbid later revival.
    if (!mayHaveBroadcast(record)) return unknown("This call has no possible broadcast and cannot be revived; no transmission attempted.");
    const current = (): CallRecord => {
      const now = store.readCall(record.callId);
      if (!now || now.intent?.amount_zats !== intent.amount_zats) throw new ResumeAuditError("The original call is no longer eligible for transmission.");
      return now;
    };
    const assertNoOtherSend = () => {
      lock.assertHeld();
      const current = store.readCall(record.callId);
      if (!current || isSettled(current.state) || !mayHaveBroadcast(current)) {
        throw new ResumeAuditError("The original call is no longer eligible for transmission.");
      }
      const other = store.unresolvedSend(record.callId);
      if (other) throw new ResumeAuditError(`Unresolved payment ${other.callId} blocks this resume; resolve it first.`);
    };
    assertNoOtherSend();
    if (!explicit && !hasTransmitAuthorization(record)) return unknown("Transmit was not authorized for this call.");
    // A fresh explicit request cannot revive a call already proven not_sent; the settled
    // check above preserves that proof. Original bindings are never reset or reassigned.
    const binding = intent.idempotency_key ? store.readKey(intent.idempotency_key) : undefined;
    if (!binding || binding.call_id !== record.callId || binding.params_sha256 !== paymentParamsHash(intent)) {
      return unknown("The original idempotency binding does not match its intent.");
    }
    assertFingerprintSalt(config);
    assertPayInputBounded(intent.recipient, intent.memo);
    if ((intent.network ?? "testnet") !== config.chainNetwork) return unknown("Original payment belongs to a different network.");
    assertNetworkAddress(intent.recipient, config.chainNetwork!);
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
    const fees = record.events.filter(e => e.calculated_fee_zats !== undefined).map(e => e.calculated_fee_zats!);
    const originalFee = fees.length === 1 && /^[1-9][0-9]{0,15}$/.test(fees[0]) ? BigInt(fees[0]) : undefined;
    if (config.totalSpendingCapZec !== undefined && originalFee !== entry.feeZats) return unknown("The original durable fee does not match the wallet transaction.");
    // Read only before the final fence: a refusal here or at the fence charges nothing,
    // and a payment already charged (by an earlier attempt or by the historical migration)
    // is recognized by its stored idempotency identity, never charged twice (F-89).
    const identity = paymentIdentity(intent, record.callId);
    if (config.totalSpendingCapZec !== undefined && originalFee === undefined) {
      throw new PolicyError("SPENDING_BUDGET_REFUSED", "A positive verified transaction fee is required before transmission.");
    }
    checkSpending(config, store, lock, amount, originalFee ?? 0n, identity.paramsHash, identity.key);
    lock.assertHeld();
    await chain.resumeSigned(txid, { fence: () => {
      assertNoOtherSend();
      assertPaymentsEnabled(store);
      assertApproval(config, store, intent.idempotency_key!, paymentParamsHash(intent), fingerprint);
      assertRecipientAllowed(intent.recipient, loadAllowlist(config.allowlistPath));
      checkSpending(config, store, lock, amount, originalFee ?? 0n, identity.paramsHash, identity.key);
      // The single charge point, after the final gates with the backend lock held: one
      // durable event is both the transmit authorization and the principal and fee
      // charge. A payment already counted (by its first attempt or the historical
      // migration) and already authorized writes nothing and is never charged twice
      // (F-72, F-89). A refusal here writes nothing at all (F-59).
      authorizeCharged(config, store, lock, current(), amount, originalFee, true);
      // A visible record is not a durable one: an earlier attempt may have published its
      // authorization, staging or txid claim and then failed the directory fsync. Make
      // every record this transmit relies on durable now, or transmit nothing (F-37).
      store.syncCall(record.callId);
      // Protected financial evidence only once the authorization is durable, after every
      // gate of THIS attempt passed, immediately before the network mutation. Any failure
      // before this point leaves the protected payment journal untouched (F-59).
      const audit = writeAuditRow(config, { ...base, status: "unknown", note: "Resuming only the originally signed transaction by exact txid; no replacement transaction authorized." });
      if (!audit.durable) throw new ResumeAuditError("Audit evidence could not be persisted; no resume attempted.");
      lock.assertHeld();
      attempted = true;
    }, timeoutMs: RESUME_TIMEOUT_MS });
    return { attempted, row: { ...base, status: "broadcast", confidence: "high", note: "Resumed the original signed transaction by exact txid. No replacement was built." } };
  } catch (e) {
    // Policy refusals of THIS attempt are exact and must not look like a benign replay.
    if (e instanceof PolicyError) throw e;
    if (e instanceof ResumeAuditError) return unknown(e.message);
    // Even a proven refusal of THIS retry says nothing about the FIRST attempt.
    return unknown("The original transaction remains unresolved after the resume attempt. Retry the same key with resume=true, or check payment_status. Never substitute a new payment key.");
  }
}
