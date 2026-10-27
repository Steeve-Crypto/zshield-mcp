import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ChainAdapter } from "../chain/types.js";
import { appendAuditEntry, fingerprintViewKey } from "../audit/log.js";
import { assertWithinCap, PolicyError } from "../policy/caps.js";
import { assertRecipientAllowed, isRecipientAllowed, loadAllowlist } from "../policy/allowlist.js";
import { assertPayInputBounded, MAX_MEMO_BYTES, MAX_RECIPIENT_LENGTH, memoProblem } from "../policy/limits.js";
import { boundAuditEntry } from "../audit/log.js";
import { MAX_AMOUNT_LENGTH } from "../policy/amount.js";
import { addressNetwork } from "../chain/network.js";
import type { PayCode } from "../errors.js";
import type { AuditEntry, Config, PayStatus } from "../types.js";

/**
 * Live mode is testnet only, so a mainnet or unrecognized recipient is refused by policy
 * before any audit intent row or CLI call. The live adapter checks again as a backstop.
 */
function assertNetworkAllowed(recipient: string, config: Config): void {
  if (config.chainMode !== "live") return;
  const net = addressNetwork(recipient);
  if (net === "mainnet") {
    throw new PolicyError("MAINNET_REFUSED", "Mainnet address refused; this server only pays on testnet.");
  }
  if (net !== "testnet") {
    throw new PolicyError("INVALID_ADDRESS", "Unrecognized address network.");
  }
}

class ViewKeyUnavailable extends Error {}

export const payInputSchema = z.object({
  amount_zec: z
    .union([z.string().max(MAX_AMOUNT_LENGTH), z.number()])
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
): Promise<{ ok: boolean; code?: PayCode; text: string; audit: AuditEntry; auditWarning?: string }> {
  const { config, chain } = deps;
  const callId = randomUUID();
  let allowlistHit = false;

  let status: PayStatus = "ok";
  let error: string | undefined;
  let code: PayCode | undefined;
  let mockTxid: string | undefined;
  let amountZats: bigint | undefined;
  // One fingerprint per wallet: a salted hash of its UFVK, written on every row of the call.
  let viewKeyFingerprint: string | null = null;
  let viewKeyError: string | undefined;
  try {
    viewKeyFingerprint = fingerprintViewKey(await chain.getViewingKey(), config.viewKeyFingerprintSalt);
  } catch (e) {
    viewKeyError = e instanceof Error ? e.message : String(e);
  }

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
    code,
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
    // Order decides which code wins when several rules fail.
    amountZats = assertWithinCap(input.amount_zec, config.spendingCapZec);
    assertNetworkAllowed(input.recipient, config);
    assertRecipientAllowed(input.recipient, allowlist);

    if (config.chainMode === "live" && chain.mode !== "live") {
      throw new Error("CHAIN_MODE=live but adapter is not live");
    }
    if (viewKeyFingerprint === null) {
      throw new ViewKeyUnavailable(`Wallet viewing key could not be read, so the payment was not sent: ${viewKeyError}`);
    }
    policyPassed = true;
  } catch (e) {
    if (e instanceof PolicyError) {
      status = "rejected";
      code = e.code;
    } else if (e instanceof ViewKeyUnavailable) {
      status = "error";
      code = "VIEWKEY_UNAVAILABLE";
    } else {
      status = "error";
      code = "CONFIG_ERROR";
    }
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
      code = "AUDIT_WRITE_FAILED";
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
        status = "ok";
      } catch (e) {
        status = "error";
        code = "CHAIN_ERROR";
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
      code,
      text: JSON.stringify(
        { ok: false, status, code, message: error, error, call_id: callId, audit, audit_warning: auditWarning },
        null,
        2
      ),
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
        call_id: callId,
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
