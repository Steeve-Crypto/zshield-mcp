import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ChainAdapter } from "../chain/types.js";
import { fingerprintViewKey, writeAuditRow } from "../audit/log.js";
import { assertWithinCap, PolicyError } from "../policy/caps.js";
import { assertRecipientAllowed, isRecipientAllowed, loadAllowlist } from "../policy/allowlist.js";
import { assertPayInputBounded, MAX_MEMO_BYTES, MAX_RECIPIENT_LENGTH, memoProblem } from "../policy/limits.js";
import { boundAuditEntry } from "../audit/log.js";
import { MAX_AMOUNT_LENGTH } from "../policy/amount.js";
import { addressNetwork } from "../chain/network.js";
import type { PayCode } from "../errors.js";
import { SendOutcomeUnknownError } from "../chain/outcome.js";
import type { AuditEntry, Config, MatchConfidence, PayStatus, PossibleSend, TxSummary } from "../types.js";

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

/** Shown with SEND_UNCONFIRMED so a client does not retry blindly. */
export const SEND_UNCONFIRMED_GUIDANCE =
  "The payment may have been broadcast. Do not retry yet. Call zcash_history and look for a sent transaction with this amount; retry only if none appears after the wallet has synced.";

/** How far back a history entry may be and still count as a match for an unknown send. */
export const MATCH_WINDOW_MS = 30 * 60_000;

export interface SendTarget {
  amountZats: bigint;
  recipient: string;
  memo?: string;
}

/**
 * Match one history entry against a send. A match needs a sent, not failed, transaction
 * with an outgoing note to the same recipient for the same amount, and the same memo when
 * one was given. Amount alone never matches. Confidence is high when the memo matched too,
 * medium when no memo was given, and one step lower when the entry has no time yet.
 * Entries older than the window before `startedAt` never match.
 */
export function matchSend(t: TxSummary, target: SendTarget, startedAt: number): PossibleSend | undefined {
  if (!/sent/i.test(t.kind) || t.status === "failed") return undefined;
  const memo = target.memo?.trim();
  const note = (t.outgoing ?? []).find(
    (n) => n.recipient === target.recipient && n.valueZats === target.amountZats && (!memo || n.memo.trim() === memo)
  );
  if (!note) return undefined;
  const matched = ["recipient", "amount", ...(memo ? ["memo"] : [])];
  let confidence: MatchConfidence = memo ? "high" : "medium";
  const ms = t.time ? Date.parse(t.time) : NaN;
  if (Number.isNaN(ms)) {
    confidence = confidence === "high" ? "medium" : "low";
  } else if (ms < startedAt - MATCH_WINDOW_MS) {
    return undefined;
  } else {
    matched.push("time");
  }
  return { txid: t.txid, confidence, matched, status: t.status };
}

/**
 * After an unknown send, look in recent wallet history for the send. Best effort: a failed
 * lookup returns an empty list and never changes the outcome.
 */
export async function findPossibleSends(chain: ChainAdapter, target: SendTarget, startedAt: number): Promise<PossibleSend[]> {
  try {
    const txs = await chain.getHistory(20);
    const out: PossibleSend[] = [];
    for (const t of txs) {
      const m = matchSend(t, target, startedAt);
      if (m) out.push(m);
    }
    return out;
  } catch {
    return [];
  }
}

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
    .describe(`Optional memo, at most ${MAX_MEMO_BYTES} UTF-8 bytes (the Zcash memo size). Sent to the recipient and written to the audit log`),
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
  const startedAt = Date.now();
  let allowlistHit = false;
  let possibleSends: PossibleSend[] | undefined;

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
    possible_txids: possibleSends?.map((p) => p.txid),
    possible_sends: possibleSends,
  });

  let policyPassed = false;
  let intentWriteFailed = false;
  const warnings: string[] = [];
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
    // Record intent before broadcast, fsynced to the main log or the fallback file.
    // If it cannot be made durable anywhere, nothing is sent.
    status = "pending";
    const intent = writeAuditRow(config, entry());
    if (intent.warning) warnings.push(intent.warning);
    if (!intent.durable) {
      intentWriteFailed = true;
      status = "error";
      code = "AUDIT_WRITE_FAILED";
      error = `Audit write failed before send; payment not sent: ${intent.warning}`;
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
        if (e instanceof SendOutcomeUnknownError) {
          status = "unknown";
          code = "SEND_UNCONFIRMED";
          error = `${SEND_UNCONFIRMED_GUIDANCE} Detail: ${redactInput(e.message, input)}`;
          possibleSends = await findPossibleSends(
            chain,
            { amountZats, recipient: input.recipient, memo: input.memo },
            startedAt
          );
        } else {
          status = "error";
          code = "CHAIN_ERROR";
          error = redactInput(e instanceof Error ? e.message : String(e), input);
        }
      }
    }
  }

  // The response carries the same bounded row that goes to disk.
  const audit = boundAuditEntry(entry());
  // writeAuditRow never throws. A send may already have happened, and throwing would hide
  // the txid and invite a retry that pays twice. A failed write is reported with the result.
  const final = writeAuditRow(config, audit);
  if (final.warning) warnings.push(final.warning);
  const auditWarning = warnings.length > 0 ? warnings.join(" ") : undefined;

  if (status !== "ok") {
    return {
      ok: false,
      code,
      text: JSON.stringify(
        {
          ok: false,
          status,
          code,
          message: error,
          error,
          call_id: callId,
          possible_txids: possibleSends?.map((p) => p.txid),
          possible_sends: possibleSends,
          audit,
          audit_warning: auditWarning,
        },
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
