import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ChainAdapter } from "../chain/types.js";
import { appendAuditEntry, fingerprintViewKey } from "../audit/log.js";
import { assertWithinCap, PolicyError } from "../policy/caps.js";
import { assertRecipientAllowed, isRecipientAllowed, loadAllowlist } from "../policy/allowlist.js";
import type { AuditEntry, Config, PayStatus } from "../types.js";

export const payInputSchema = z.object({
  amount_zec: z.number().describe("Amount of ZEC to pay (must be <= spending cap)"),
  recipient: z.string().describe("Recipient address; must be on the allow-list"),
  memo: z.string().max(512).optional().describe("Optional memo (mock only)"),
});

export type PayInput = z.infer<typeof payInputSchema>;

export interface PayDeps {
  config: Config;
  chain: ChainAdapter;
}

export async function executePay(
  input: PayInput,
  deps: PayDeps
): Promise<{ ok: boolean; text: string; audit: AuditEntry; auditWarning?: string }> {
  const { config, chain } = deps;
  const callId = randomUUID();
  let allowlistHit = false;

  let status: PayStatus = "ok";
  let error: string | undefined;
  let mockTxid: string | undefined;
  let viewKeyFingerprint = fingerprintViewKey("none", config.viewKeyFingerprintSalt);

  const entry = (): AuditEntry => ({
    ts: new Date().toISOString(),
    tool: "zcash_pay",
    call_id: callId,
    amount_zec: input.amount_zec,
    recipient: input.recipient,
    allowlist_hit: allowlistHit,
    cap_zec: config.spendingCapZec,
    status,
    mock_txid: mockTxid,
    view_key_fingerprint: viewKeyFingerprint,
    error,
    memo: input.memo,
  });

  let policyPassed = false;
  let intentWriteFailed = false;
  try {
    const allowlist = loadAllowlist(config.allowlistPath);
    allowlistHit = isRecipientAllowed(input.recipient, allowlist);
    assertWithinCap(input.amount_zec, config.spendingCapZec);
    assertRecipientAllowed(input.recipient, allowlist);

    if (config.chainMode === "live" && chain.mode !== "live") {
      throw new Error("CHAIN_MODE=live but adapter is not live");
    }
    policyPassed = true;
  } catch (e) {
    status = e instanceof PolicyError ? "rejected" : "error";
    error = e instanceof Error ? e.message : String(e);
  }

  if (policyPassed) {
    // Record intent before broadcast. If this write fails, nothing is sent.
    status = "pending";
    try {
      appendAuditEntry(config.auditDir, entry());
    } catch (e) {
      intentWriteFailed = true;
      status = "error";
      error = `Audit write failed before send; payment not sent: ${e instanceof Error ? e.message : String(e)}`;
    }

    if (!intentWriteFailed) {
      try {
        const receipt = await chain.pay({
          amountZec: input.amount_zec,
          recipient: input.recipient,
          memo: input.memo,
        });

        mockTxid = receipt.txid;
        viewKeyFingerprint = fingerprintViewKey(
          receipt.viewKeyMaterial,
          config.viewKeyFingerprintSalt
        );
        status = "ok";
      } catch (e) {
        status = "error";
        error = e instanceof Error ? e.message : String(e);
      }
    }
  }

  const audit = entry();
  let auditWarning: string | undefined;
  try {
    appendAuditEntry(config.auditDir, audit);
  } catch (e) {
    // Never throw here. A send may already have happened, and throwing would hide the txid
    // and invite a retry that pays twice. Report the failed write alongside the result instead.
    // When the intent write already failed, nothing was sent and that error is already reported.
    if (!intentWriteFailed) {
      auditWarning = `Result audit row could not be written: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  if (status !== "ok") {
    return {
      ok: false,
      text: JSON.stringify({ ok: false, status, error, audit, audit_warning: auditWarning }, null, 2),
      audit,
      auditWarning,
    };
  }

  return {
    ok: true,
    text: JSON.stringify(
      {
        ok: true,
        status: "ok",
        txid: mockTxid,
        amount_zec: input.amount_zec,
        recipient: input.recipient,
        mode: config.chainMode,
        view_key_fingerprint: viewKeyFingerprint,
        audit_warning: auditWarning,
      },
      null,
      2
    ),
    audit,
    auditWarning,
  };
}
