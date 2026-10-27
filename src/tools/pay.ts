import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ChainAdapter } from "../chain/types.js";
import { appendAuditEntry, fingerprintViewKey } from "../audit/log.js";
import { assertWithinCap, PolicyError } from "../policy/caps.js";
import { assertRecipientAllowed, isRecipientAllowed, loadAllowlist } from "../policy/allowlist.js";
import { assertPayInputBounded, MAX_MEMO_BYTES, MAX_RECIPIENT_LENGTH, memoProblem } from "../policy/limits.js";
import { boundAuditEntry } from "../audit/log.js";
import type { AuditEntry, Config, PayStatus } from "../types.js";

export const payInputSchema = z.object({
  amount_zec: z
    .union([z.string(), z.number()])
    .describe('Amount of ZEC to pay as a decimal string like "0.05" or a number, at most 8 decimals (must be <= spending cap)'),
  recipient: z
    .string()
    .max(MAX_RECIPIENT_LENGTH, `INVALID_RECIPIENT: recipient is longer than ${MAX_RECIPIENT_LENGTH} characters`)
    .describe(`Recipient address, at most ${MAX_RECIPIENT_LENGTH} characters; must be on the allow-list`),
  memo: z
    .string()
    .max(MAX_MEMO_BYTES)
    .refine((m) => memoProblem(m) === undefined, `INVALID_MEMO: memo is longer than ${MAX_MEMO_BYTES} bytes`)
    .optional()
    .describe(`Optional memo, at most ${MAX_MEMO_BYTES} UTF-8 bytes (the Zcash memo size)`),
});

export type PayInput = z.infer<typeof payInputSchema>;

/**
 * Chain errors can quote zingo-cli output, which may repeat the recipient or memo.
 * Replace them so caller strings never come back inside an error message.
 */
export function redactInput(message: string, input: { recipient: string; memo?: string }): string {
  let out = message;
  for (const [value, label] of [
    [input.recipient, "[recipient]"],
    [input.memo, "[memo]"],
  ] as const) {
    if (value && value.length >= 4) out = out.split(value).join(label);
  }
  return out;
}

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
  let amountZats: bigint | undefined;
  let viewKeyFingerprint = fingerprintViewKey("none", config.viewKeyFingerprintSalt);

  const entry = (): AuditEntry => ({
    ts: new Date().toISOString(),
    tool: "zcash_pay",
    call_id: callId,
    amount_zec: input.amount_zec,
    amount_zats: amountZats?.toString(),
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
    // Bound caller strings first. The schema enforces the same limits for MCP calls; this
    // covers direct callers and keeps oversized values out of errors and audit rows.
    assertPayInputBounded(input.recipient, input.memo);
    const allowlist = loadAllowlist(config.allowlistPath);
    allowlistHit = isRecipientAllowed(input.recipient, allowlist);
    amountZats = assertWithinCap(input.amount_zec, config.spendingCapZec);
    assertRecipientAllowed(input.recipient, allowlist);

    if (config.chainMode === "live" && chain.mode !== "live") {
      throw new Error("CHAIN_MODE=live but adapter is not live");
    }
    policyPassed = true;
  } catch (e) {
    status = e instanceof PolicyError ? "rejected" : "error";
    error = e instanceof Error ? e.message : String(e);
  }

  if (policyPassed && amountZats !== undefined) {
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
          amountZats,
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
        error = redactInput(e instanceof Error ? e.message : String(e), input);
      }
    }
  }

  // The response carries the same bounded row that goes to disk.
  const audit = boundAuditEntry(entry());
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
        amount_zats: amountZats?.toString(),
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
