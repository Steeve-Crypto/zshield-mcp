import { z } from "zod";
import type { ChainAdapter } from "../chain/types.js";
import { appendAuditEntry, fingerprintViewKey } from "../audit/log.js";
import { assertWithinCap, PolicyError } from "../policy/caps.js";
import { assertRecipientAllowed, isRecipientAllowed, loadAllowlist } from "../policy/allowlist.js";
import type { AuditEntry, Config, PayStatus } from "../types.js";

export const payInputSchema = z.object({
  amount_zec: z
    .union([z.string(), z.number()])
    .describe('Amount of ZEC to pay as a decimal string like "0.05" or a number, at most 8 decimals (must be <= spending cap)'),
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
): Promise<{ ok: boolean; text: string; audit: AuditEntry }> {
  const { config, chain } = deps;
  let allowlistHit = false;

  let status: PayStatus = "ok";
  let error: string | undefined;
  let mockTxid: string | undefined;
  let amountZats: bigint | undefined;
  let viewKeyFingerprint = fingerprintViewKey("none", config.viewKeyFingerprintSalt);

  try {
    const allowlist = loadAllowlist(config.allowlistPath);
    allowlistHit = isRecipientAllowed(input.recipient, allowlist);
    amountZats = assertWithinCap(input.amount_zec, config.spendingCapZec);
    assertRecipientAllowed(input.recipient, allowlist);

    if (config.chainMode === "live" && chain.mode !== "live") {
      throw new Error("CHAIN_MODE=live but adapter is not live");
    }

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
  } catch (e) {
    status = e instanceof PolicyError ? "rejected" : "error";
    error = e instanceof Error ? e.message : String(e);
  }

  const audit: AuditEntry = {
    ts: new Date().toISOString(),
    tool: "zcash_pay",
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
  };

  appendAuditEntry(config.auditDir, audit);

  if (status !== "ok") {
    return {
      ok: false,
      text: JSON.stringify({ ok: false, status, error, audit }, null, 2),
      audit,
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
      },
      null,
      2
    ),
    audit,
  };
}
