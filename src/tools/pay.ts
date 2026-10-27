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
import { acquireWalletLock, BusyError, SEND_QUEUE_WAIT_DEFAULT_MS } from "../payments/lock.js";
import { paymentIndexFor, paymentParamsHash, type PaymentRecord } from "../payments/index.js";
import { ChainUnreachableError, SendOutcomeUnknownError } from "../chain/outcome.js";
import type { AuditEntry, ChainHealth, Config, MatchConfidence, PayStatus, PossibleSend, TxSummary } from "../types.js";

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
  "The payment may have been broadcast. Do not retry with a new idempotency key. Call zcash_payment_status with this call_id; pay again only if it reports expired.";

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

export const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

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
  idempotency_key: z
    .string()
    .regex(IDEMPOTENCY_KEY_PATTERN, `INVALID_IDEMPOTENCY_KEY: use 1 to ${MAX_IDEMPOTENCY_KEY_LENGTH} letters, digits, dot, underscore, colon, or dash`)
    .optional()
    .describe(
      `Optional key, 1 to ${MAX_IDEMPOTENCY_KEY_LENGTH} characters. A repeat call with the same key and parameters returns the first outcome and never pays again; different parameters return IDEMPOTENCY_CONFLICT`
    ),
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

/** Fee assumed by the pre-send check: the ZIP-317 minimum for a two-action shielded send. */
export const ESTIMATED_FEE_ZATS = 10_000n;
/** How many blocks the wallet may be behind the chain tip and still send. */
export const HEALTH_MAX_LAG_DEFAULT = 10;

/** Returns why a live send should not start, or undefined when the wallet looks ready. */
export async function preSendProblem(
  check: () => Promise<ChainHealth>,
  amountZats: bigint,
  maxLagBlocks: number
): Promise<{ code: PayCode; message: string } | undefined> {
  let health: ChainHealth;
  try {
    health = await check();
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    if (e instanceof ChainUnreachableError) return { code: "CHAIN_UNREACHABLE", message: `${detail}. Nothing was sent.` };
    return { code: "CHAIN_ERROR", message: `Pre-send check failed: ${detail}. Nothing was sent.` };
  }
  const lag = health.chainTip - health.walletHeight;
  if (lag > maxLagBlocks) {
    return {
      code: "WALLET_NOT_SYNCED",
      message: `Wallet is at height ${health.walletHeight}, ${lag} blocks behind the chain tip ${health.chainTip} (limit ${maxLagBlocks}). Sync the wallet, then try again. Nothing was sent.`,
    };
  }
  const needed = amountZats + ESTIMATED_FEE_ZATS;
  if (health.spendableZats < needed && health.synced === false) {
    // A sync that did not finish leaves new blocks unscanned, and zingo-cli then reports
    // too little spendable (often 0). That is not proof the funds are missing.
    return {
      code: "WALLET_NOT_SYNCED",
      message: `The wallet sync did not finish (${health.syncDetail ?? "no detail"}), and the spendable balance reads ${health.spendableZats} zats, below the ${needed} zats this payment needs. It may be low only because the sync is incomplete. Try again once the wallet has synced. Nothing was sent.`,
    };
  }
  if (health.spendableZats < needed) {
    return {
      code: "INSUFFICIENT_FUNDS",
      message: `Spendable balance is ${health.spendableZats} zats; this payment needs about ${needed} zats including the fee. Nothing was sent.`,
    };
  }
  return undefined;
}

/** Fingerprint of each adapter's wallet once read, so refused calls can carry it without running zingo-cli. */
const knownFingerprints = new WeakMap<ChainAdapter, string>();

export interface PayDeps {
  config: Config;
  chain: ChainAdapter;
}

export interface PayResult {
  ok: boolean;
  code?: PayCode;
  text: string;
  audit: AuditEntry;
  auditWarning?: string;
}

/**
 * zcash_pay. With an idempotency key: a key already bound to the same parameters returns
 * that call's outcome, or its pending status, and sends nothing. A key bound to different
 * parameters is refused with IDEMPOTENCY_CONFLICT. A new key is reserved for this call and
 * bound for good once the pending row is written.
 */
export async function executePay(input: PayInput, deps: PayDeps): Promise<PayResult> {
  const callId = randomUUID();
  const key = input.idempotency_key;
  if (key === undefined) return runPay(input, deps, callId, {});
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    // Direct callers skip the schema; refuse the same way.
    return refuseKey(input, deps, callId, "INVALID_IDEMPOTENCY_KEY", `idempotency_key must be 1 to ${MAX_IDEMPOTENCY_KEY_LENGTH} letters, digits, dot, underscore, colon, or dash`);
  }
  const index = paymentIndexFor(deps.config);
  const paramsSha256 = paymentParamsHash(input);
  const prior = index.byIdempotencyKey(key);
  if (prior) {
    if (prior.paramsSha256 !== paramsSha256) {
      return refuseKey(
        input,
        deps,
        callId,
        "IDEMPOTENCY_CONFLICT",
        `idempotency_key was already used by call ${prior.callId} with different parameters. Nothing was sent.`
      );
    }
    return replay(input, deps, callId, prior.callId, prior.record);
  }
  index.reserve(key, callId, paramsSha256);
  try {
    return await runPay(input, deps, callId, { idempotency_key: key, params_sha256: paramsSha256 });
  } finally {
    index.release(key, callId);
  }
}

function baseRow(input: PayInput, config: Config, callId: string): AuditEntry {
  return {
    ts: new Date().toISOString(),
    tool: "zcash_pay",
    call_id: callId,
    amount_zec: input.amount_zec,
    recipient: input.recipient,
    allowlist_hit: false,
    cap_zec: config.spendingCapZec,
    status: "rejected",
    view_key_fingerprint: null,
    memo: input.memo,
  };
}

/** Write a row for a call that ends without touching policy or the chain. Never throws. */
function finish(config: Config, row: AuditEntry): { audit: AuditEntry; auditWarning?: string } {
  const audit = boundAuditEntry(row);
  const written = writeAuditRow(config, audit);
  paymentIndexFor(config).record(audit as unknown as Record<string, unknown>);
  return { audit, auditWarning: written.warning };
}

function refuseKey(input: PayInput, deps: PayDeps, callId: string, code: PayCode, message: string): PayResult {
  const { audit, auditWarning } = finish(deps.config, {
    ...baseRow(input, deps.config, callId),
    status: "rejected",
    code,
    error: message,
    // Only a hash of an invalid key, so an oversized one stays out of the log.
    idempotency_key: code === "INVALID_IDEMPOTENCY_KEY" ? undefined : input.idempotency_key,
  });
  return {
    ok: false,
    code,
    text: JSON.stringify(
      { ok: false, status: "rejected", code, message, error: message, call_id: callId, audit, audit_warning: auditWarning },
      null,
      2
    ),
    audit,
    auditWarning,
  };
}

/** Same key, same parameters: report the first call's outcome. Nothing is sent. */
function replay(input: PayInput, deps: PayDeps, callId: string, originalCallId: string, record?: PaymentRecord): PayResult {
  const { config } = deps;
  const result = record?.result;
  // Copy what the first call learned, so the replay row is not read as a refused call.
  const first = result ?? record?.intent;
  const { audit, auditWarning } = finish(config, {
    ...baseRow(input, config, callId),
    allowlist_hit: first?.allowlist_hit ?? false,
    view_key_fingerprint: first?.view_key_fingerprint ?? null,
    status: "replayed",
    idempotency_key: input.idempotency_key,
    replay_of: originalCallId,
  });
  const common = { call_id: originalCallId, idempotency_key: input.idempotency_key, idempotent_replay: true };
  if (result?.status === "ok") {
    return {
      ok: true,
      audit,
      auditWarning,
      text: JSON.stringify(
        {
          ok: true,
          status: "ok",
          ...common,
          txid: result.mock_txid,
          amount_zec: result.amount_zec,
          amount_zats: result.amount_zats,
          recipient: result.recipient,
          mode: config.chainMode,
          view_key_fingerprint: result.view_key_fingerprint,
          audit_warning: auditWarning,
        },
        null,
        2
      ),
    };
  }
  if (result) {
    const code = result.code as PayCode | undefined;
    return {
      ok: false,
      code,
      audit,
      auditWarning,
      text: JSON.stringify(
        {
          ok: false,
          status: result.status,
          code,
          message: result.error,
          error: result.error,
          ...common,
          possible_txids: result.possible_txids,
          possible_sends: result.possible_sends,
          audit_warning: auditWarning,
        },
        null,
        2
      ),
    };
  }
  // In flight in this process, or a pending row with no result (the process stopped mid-send).
  const message =
    "A payment with this idempotency key was started and has no recorded result yet. It was not sent again. Call zcash_payment_status with this idempotency_key.";
  return {
    ok: false,
    code: "PAYMENT_PENDING",
    audit,
    auditWarning,
    text: JSON.stringify(
      { ok: false, status: "pending", code: "PAYMENT_PENDING", message, error: message, ...common, audit_warning: auditWarning },
      null,
      2
    ),
  };
}

async function runPay(
  input: PayInput,
  deps: PayDeps,
  callId: string,
  keyFields: Pick<AuditEntry, "idempotency_key" | "params_sha256">
): Promise<PayResult> {
  const { config, chain } = deps;
  const index = paymentIndexFor(config);
  const startedAt = Date.now();
  let allowlistHit = false;
  let possibleSends: PossibleSend[] | undefined;

  let status: PayStatus = "ok";
  let error: string | undefined;
  let code: PayCode | undefined;
  let mockTxid: string | undefined;
  let amountZats: bigint | undefined;
  // One fingerprint per wallet: a salted hash of its UFVK, written on every row of the call.
  // Reading the key can run zingo-cli, so it waits until every cheap check has passed.
  // Rows for calls refused before that use the fingerprint from an earlier call, if any.
  let viewKeyFingerprint: string | null = knownFingerprints.get(chain) ?? null;
  let viewKeyError: string | undefined;

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
    ...keyFields,
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
    // Last, and only once everything above passed: read the viewing key.
    try {
      viewKeyFingerprint = fingerprintViewKey(await chain.getViewingKey(), config.viewKeyFingerprintSalt);
      knownFingerprints.set(chain, viewKeyFingerprint);
    } catch (e) {
      viewKeyFingerprint = null;
      viewKeyError = e instanceof Error ? e.message : String(e);
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

  // One send at a time per wallet. Later calls queue for a bounded time, then get BUSY.
  let release: (() => void) | undefined;
  if (policyPassed && amountZats !== undefined) {
    try {
      release = await acquireWalletLock(chain, config.sendQueueWaitMs ?? SEND_QUEUE_WAIT_DEFAULT_MS, "zcash_pay");
    } catch (e) {
      policyPassed = false;
      status = "error";
      if (e instanceof BusyError) {
        code = "BUSY";
        error = e.message;
      } else {
        code = "CHAIN_ERROR";
        error = `The wallet lock could not be taken: ${e instanceof Error ? e.message : String(e)}. Nothing was sent.`;
      }
    }
  }

  let audit: AuditEntry;
  let final: ReturnType<typeof writeAuditRow>;
  try {
    // Another process on this wallet may have bound the key since this call started.
    // Holding the wallet lock, re-read the audit log; if the key is taken, this call
    // becomes a replay or a conflict and sends nothing.
    if (release && keyFields.idempotency_key) {
      index.reload();
      const other = index.byIdempotencyKey(keyFields.idempotency_key);
      if (other && other.callId !== callId) {
        release();
        release = undefined;
        return other.paramsSha256 === keyFields.params_sha256
          ? replay(input, deps, callId, other.callId, other.record)
          : refuseKey(
              input,
              deps,
              callId,
              "IDEMPOTENCY_CONFLICT",
              `idempotency_key was already used by call ${other.callId} with different parameters. Nothing was sent.`
            );
      }
    }

    // Live mode: check the wallet and server before writing the intent. A failure here
    // sends nothing and leaves no pending row.
    if (policyPassed && amountZats !== undefined && config.chainMode === "live" && chain.checkHealth) {
      const problem = await preSendProblem(() => chain.checkHealth!(), amountZats, config.healthMaxLagBlocks ?? HEALTH_MAX_LAG_DEFAULT);
      if (problem) {
        policyPassed = false;
        status = "error";
        code = problem.code;
        error = problem.message;
      }
    }

    if (policyPassed && amountZats !== undefined) {
      // Record intent before broadcast, fsynced to the main log or the fallback file.
      // If it cannot be made durable anywhere, nothing is sent.
      status = "pending";
      const intentRow = boundAuditEntry(entry());
      const intent = writeAuditRow(config, intentRow);
      // Bind the idempotency key only to an intent that reached disk.
      if (intent.durable) index.record(intentRow as unknown as Record<string, unknown>);
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
    audit = boundAuditEntry(entry());
    // writeAuditRow never throws. A send may already have happened, and throwing would hide
    // the txid and invite a retry that pays twice. A failed write is reported with the result.
    final = writeAuditRow(config, audit);
    index.record(audit as unknown as Record<string, unknown>);
  } finally {
    release?.();
  }
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
          idempotency_key: input.idempotency_key,
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
        idempotency_key: input.idempotency_key,
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
