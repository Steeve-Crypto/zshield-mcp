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
import { acquireWalletLock, BusyError, SEND_QUEUE_WAIT_DEFAULT_MS, type WalletLock } from "../payments/lock.js";
import { LeaseLostError } from "../payments/filelock.js";
import { expiryAnchor, TIP_TOLERANCE_BLOCKS, tipProblem } from "../payments/tip.js";
import {
  paymentParamsHash,
  rememberRefusal,
  storeFor,
  type CallIntent,
  type CallRecord,
  type CallState,
  type PaymentStore,
} from "../payments/store.js";
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

function safelyRead<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/** The wallet lease was lost at the last moment before the wallet process would start. */
class FenceError extends Error {}

/** Shown with SEND_UNCONFIRMED so a client does not retry blindly. */
export const SEND_UNCONFIRMED_GUIDANCE =
  "The payment may have been broadcast. Do not pay again. Call zcash_payment_status with this call_id; it reports expired only once the wallet proves the payment was never sent.";

/** Clock skew allowed between this host and a wallet entry's time, before the call started. */
export const MATCH_SKEW_MS = 5 * 60_000;
/** How long after the call started a wallet entry can still be its send. */
export const MATCH_AFTER_MS = 3 * 60 * 60_000;
/** Kept for callers of the old name: the skew before the start. */
export const MATCH_WINDOW_MS = MATCH_SKEW_MS;

export interface SendTarget {
  amountZats: bigint;
  recipient: string;
  memo?: string;
  /**
   * The chain height recorded when the call started. A mined transaction below it, less
   * REORG_SLACK_BLOCKS, cannot be this call's send.
   */
  notBeforeHeight?: number;
}

/** Blocks a recorded tip may exceed the height a new transaction lands at, after a reorg. */
export const REORG_SLACK_BLOCKS = 5;

/**
 * Match one history entry against a send. A match needs a sent, not failed, transaction
 * with an outgoing note to the same recipient for the same amount and the same memo: a
 * send with no memo only matches a note with none, so it never takes a transaction that
 * carries someone's message. Amount alone never matches.
 * The entry must also fit the call in time. With a time, it must fall between the start
 * (less clock skew) and MATCH_AFTER_MS after it. Without one, a mined entry must sit at or
 * above the height recorded at the start; an entry that cannot be placed in time is only a
 * low confidence candidate and is never confirmed on its own.
 */
export function matchSend(t: TxSummary, target: SendTarget, startedAt: number): PossibleSend | undefined {
  if (!/sent/i.test(t.kind) || t.status === "failed") return undefined;
  // Memos are exact: accepted memos have no edge whitespace, and the listing parser trims
  // the edges it prints, so the two compare as plain strings. A call with an older memo
  // that has edge whitespace cannot match, and stays unknown.
  const memo = target.memo ?? "";
  const note = (t.outgoing ?? []).find(
    (n) => (n.recipient === target.recipient || n.unifiedAddress === target.recipient) && n.valueZats === target.amountZats && n.memo === memo
  );
  if (!note) return undefined;
  const matched = ["recipient", "amount", ...(memo ? ["memo"] : [])];
  let confidence: MatchConfidence = memo ? "high" : "medium";
  const ms = t.time ? Date.parse(t.time) : NaN;
  const minHeight = target.notBeforeHeight === undefined ? undefined : target.notBeforeHeight - REORG_SLACK_BLOCKS;
  if (!Number.isNaN(ms)) {
    if (ms < startedAt - MATCH_SKEW_MS || ms > startedAt + MATCH_AFTER_MS) return undefined;
    matched.push("time");
  } else if (t.blockHeight !== undefined && minHeight !== undefined) {
    if (t.blockHeight < minHeight) return undefined;
    matched.push("height");
  } else {
    confidence = confidence === "high" ? "medium" : "low";
  }
  return { txid: t.txid, confidence, matched, status: t.status };
}

/**
 * A sent entry that could be this call's send if the recipient or memo were written
 * differently: the same amount, not failed, and not placed outside the call's time. Used
 * to refuse "never sent" while one exists that no call owns, so a wallet that lists a
 * recipient in a form this code does not know can never turn a real send into "not sent".
 */
export function lookalikeSends(
  txs: TxSummary[],
  target: SendTarget,
  startedAt: number,
  claimedBy?: (txid: string) => string | undefined,
  callId?: string
): TxSummary[] {
  const minHeight = target.notBeforeHeight === undefined ? undefined : target.notBeforeHeight - REORG_SLACK_BLOCKS;
  return txs.filter((t) => {
    if (!/sent/i.test(t.kind) || t.status === "failed") return false;
    if (t.valueZats !== target.amountZats && !(t.outgoing ?? []).some((n) => n.valueZats === target.amountZats)) return false;
    const owner = claimedBy?.(t.txid);
    if (owner && owner !== callId) return false;
    const ms = t.time ? Date.parse(t.time) : NaN;
    if (!Number.isNaN(ms)) return ms >= startedAt - MATCH_SKEW_MS && ms <= startedAt + MATCH_AFTER_MS;
    if (t.blockHeight !== undefined && minHeight !== undefined) return t.blockHeight >= minHeight;
    return true;
  });
}

/** Whether a match is placed in time, by its timestamp or its mined height. */
export function placedInTime(m: PossibleSend): boolean {
  return m.matched.includes("time") || m.matched.includes("height");
}

/**
 * Every entry in `txs` that matches the send, skipping txids already credited to another
 * call (`claimedBy` returns that call's id).
 */
export function matchHistory(
  txs: TxSummary[],
  target: SendTarget,
  startedAt: number,
  claimedBy?: (txid: string) => string | undefined,
  callId?: string
): PossibleSend[] {
  const out: PossibleSend[] = [];
  for (const t of txs) {
    const m = matchSend(t, target, startedAt);
    if (!m) continue;
    const owner = claimedBy?.(t.txid);
    if (owner && owner !== callId) continue;
    out.push(m);
  }
  return out;
}

/**
 * After an unknown send, look in the whole wallet history for the send. Best effort: a
 * failed lookup returns an empty list and never changes the outcome.
 */
export async function findPossibleSends(
  chain: ChainAdapter,
  target: SendTarget,
  startedAt: number,
  claimedBy?: (txid: string) => string | undefined,
  callId?: string
): Promise<PossibleSend[]> {
  try {
    return matchHistory(await chain.getHistory(Infinity), target, startedAt, claimedBy, callId);
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
    .refine((m) => memoProblem(m) === undefined, `INVALID_MEMO: memo is longer than ${MAX_MEMO_BYTES} bytes, has a control character, or starts or ends with whitespace`)
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
  maxLagBlocks: number,
  /** The highest tip recorded for this wallet. A server reporting far below it is not believed. */
  tipFloor?: number
): Promise<{ code: PayCode; message: string } | undefined> {
  let health: ChainHealth;
  try {
    health = await check();
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    if (e instanceof ChainUnreachableError) return { code: "CHAIN_UNREACHABLE", message: `${detail}. Nothing was sent.` };
    return { code: "CHAIN_ERROR", message: `Pre-send check failed: ${detail}. Nothing was sent.` };
  }
  const tipIssue = tipProblem(health, tipFloor);
  if (tipIssue) return { code: "CHAIN_ERROR", message: `Pre-send check failed: ${tipIssue}. A tip that is too low cannot anchor an expiry. Nothing was sent.` };
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

/**
 * Keys held by a call in flight in this process, before the key is bound on disk (the
 * health check runs first). A second call with the key waits for nothing: it reports
 * pending or conflict. Scoped by store, so two wallets never share a key.
 */
const inFlight = new Map<string, { callId: string; paramsSha256: string }>();
const flightKey = (store: PaymentStore, key: string) => `${store.dir}\u0000${key}`;

/** The in-flight call holding `key` in this process, if any. For zcash_payment_status. */
export function inFlightCall(store: PaymentStore, key: string): string | undefined {
  return inFlight.get(flightKey(store, key))?.callId;
}

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

const KEY_PROBLEM = `idempotency_key must be 1 to ${MAX_IDEMPOTENCY_KEY_LENGTH} letters, digits, dot, underscore, colon, or dash`;

/**
 * zcash_pay. With an idempotency key: a key already bound to the same parameters returns
 * that call's outcome, or its pending status, and sends nothing. A key bound to different
 * parameters is refused with IDEMPOTENCY_CONFLICT. A new key is bound, exclusively, in
 * the wallet's payment store before the broadcast; only one call can ever win it.
 */
export async function executePay(rawInput: PayInput, deps: PayDeps): Promise<PayResult> {
  // An empty memo is no memo: one form everywhere (the key hash, the audit row, the send).
  const input: PayInput = rawInput.memo === "" ? { ...rawInput, memo: undefined } : rawInput;
  const callId = randomUUID();
  const key = input.idempotency_key;
  if (key !== undefined && !IDEMPOTENCY_KEY_PATTERN.test(key)) {
    // Direct callers skip the schema; refuse the same way.
    return refuseKey(input, deps, callId, "INVALID_IDEMPOTENCY_KEY", KEY_PROBLEM);
  }
  let store: PaymentStore;
  try {
    store = storeFor(deps.config, deps.chain);
  } catch (e) {
    const message = `The payment store could not be opened: ${e instanceof Error ? e.message : String(e)}. Nothing was sent.`;
    return refuseKey(input, deps, callId, "STATE_WRITE_FAILED", message, "error");
  }
  if (key === undefined) return runPay(input, deps, store, callId, {});
  const paramsSha256 = paymentParamsHash(input);
  const early = priorUse(input, deps, store, callId, key, paramsSha256);
  if (early) return early;
  const slot = flightKey(store, key);
  inFlight.set(slot, { callId, paramsSha256 });
  try {
    return await runPay(input, deps, store, callId, { idempotency_key: key, params_sha256: paramsSha256 });
  } finally {
    if (inFlight.get(slot)?.callId === callId) inFlight.delete(slot);
  }
}

/** A replay or a conflict when the key is bound on disk or held by a call in flight here. */
function priorUse(
  input: PayInput,
  deps: PayDeps,
  store: PaymentStore,
  callId: string,
  key: string,
  paramsSha256: string
): PayResult | undefined {
  const bound = store.readKey(key);
  const flying = inFlight.get(flightKey(store, key));
  const other = bound ? { callId: bound.call_id, paramsSha256: bound.params_sha256 } : flying && flying.callId !== callId ? flying : undefined;
  if (!other) return undefined;
  if (other.paramsSha256 !== paramsSha256) {
    return refuseKey(
      input,
      deps,
      callId,
      "IDEMPOTENCY_CONFLICT",
      `idempotency_key was already used by call ${other.callId} with different parameters. Nothing was sent.`
    );
  }
  return replay(input, deps, callId, other.callId, store.readCall(other.callId));
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

/** Write a row for a call that ends without touching the chain. Never throws. */
function finish(config: Config, row: AuditEntry): { audit: AuditEntry; auditWarning?: string } {
  const audit = boundAuditEntry(row);
  const written = writeAuditRow(config, audit);
  return { audit, auditWarning: written.warning };
}

function refuseKey(
  input: PayInput,
  deps: PayDeps,
  callId: string,
  code: PayCode,
  message: string,
  status: "rejected" | "error" = "rejected"
): PayResult {
  const { audit, auditWarning } = finish(deps.config, {
    ...baseRow(input, deps.config, callId),
    status,
    code,
    error: message,
    // Only a hash of an invalid key, so an oversized one stays out of the log.
    idempotency_key: code === "INVALID_IDEMPOTENCY_KEY" ? undefined : input.idempotency_key,
  });
  rememberRefusal(callId, { code, error: message, idempotency_key: code === "INVALID_IDEMPOTENCY_KEY" ? undefined : input.idempotency_key });
  return {
    ok: false,
    code,
    text: JSON.stringify(
      { ok: false, status, code, message, error: message, call_id: callId, audit, audit_warning: auditWarning },
      null,
      2
    ),
    audit,
    auditWarning,
  };
}

/** What a caller is told about a call in each state, for a replay. */
const PENDING_MESSAGE =
  "A payment with this idempotency key was started and has no recorded result yet. It was not sent again. Call zcash_payment_status with this idempotency_key.";
const EXPIRED_MESSAGE =
  "The first payment with this idempotency key was proven never sent: the wallet scanned past its expiry height and found no matching transaction. Use a new idempotency key to pay.";

const FAILED_MESSAGE =
  "The first payment with this idempotency key returned a txid, but the wallet has since marked that transaction failed. It was not sent again, and this key will not send again. Check the explorer; if it did not go through, use a new idempotency key to pay.";

/** Same key, same parameters: report the first call's outcome from the store. Nothing is sent. */
function replay(input: PayInput, deps: PayDeps, callId: string, originalCallId: string, record?: CallRecord): PayResult {
  const { config } = deps;
  const intent = record?.intent;
  const { audit, auditWarning } = finish(config, {
    ...baseRow(input, config, callId),
    allowlist_hit: intent?.allowlist_hit ?? false,
    view_key_fingerprint: intent?.view_key_fingerprint ?? null,
    status: "replayed",
    idempotency_key: input.idempotency_key,
    replay_of: originalCallId,
  });
  const common = { call_id: originalCallId, idempotency_key: input.idempotency_key, idempotent_replay: true };
  const state: CallState = record?.state ?? "pending";
  const respond = (ok: boolean, body: Record<string, unknown>, code?: PayCode): PayResult => ({
    ok,
    code,
    audit,
    auditWarning,
    text: JSON.stringify({ ok, ...body, ...common, audit_warning: auditWarning }, null, 2),
  });
  if ((state === "sent" || state === "mined") && record?.txid) {
    return respond(true, {
      status: "ok",
      txid: record.txid,
      amount_zec: intent?.amount_zec,
      amount_zats: intent?.amount_zats,
      recipient: intent?.recipient,
      mode: config.chainMode,
      view_key_fingerprint: intent?.view_key_fingerprint,
      confirmed: state === "mined" ? true : undefined,
      block_height: record.blockHeight,
    });
  }
  const top = record?.top;
  if (state === "not_sent") {
    const code = (top?.code as PayCode | undefined) ?? "CHAIN_ERROR";
    return respond(false, { status: top?.code && isRejectCode(top.code) ? "rejected" : "error", code, message: top?.error, error: top?.error }, code);
  }
  if (state === "failed") {
    return respond(
      false,
      { status: "error", code: "PAYMENT_FAILED", txid: record?.txid, message: FAILED_MESSAGE, error: FAILED_MESSAGE },
      "PAYMENT_FAILED"
    );
  }
  if (state === "expired") {
    return respond(false, { status: "expired", code: "PAYMENT_EXPIRED", message: EXPIRED_MESSAGE, error: EXPIRED_MESSAGE }, "PAYMENT_EXPIRED");
  }
  if (state === "unknown") {
    const message = top?.error ?? SEND_UNCONFIRMED_GUIDANCE;
    return respond(
      false,
      {
        status: "unknown",
        code: "SEND_UNCONFIRMED",
        message,
        error: message,
        possible_txids: top?.possible_sends?.map((p) => p.txid),
        possible_sends: top?.possible_sends,
      },
      "SEND_UNCONFIRMED"
    );
  }
  return respond(false, { status: "pending", code: "PAYMENT_PENDING", message: PENDING_MESSAGE, error: PENDING_MESSAGE }, "PAYMENT_PENDING");
}

function isRejectCode(code: string): boolean {
  return code === "IDEMPOTENCY_CONFLICT";
}

async function runPay(
  input: PayInput,
  deps: PayDeps,
  store: PaymentStore,
  callId: string,
  keyFields: Pick<AuditEntry, "idempotency_key" | "params_sha256">
): Promise<PayResult> {
  const { config, chain } = deps;
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
  let chainTip: number | undefined;
  let walletHeight: number | undefined;

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
    chain_tip: chainTip,
    wallet_height: walletHeight,
  });
  const fail = (s: PayStatus, c: PayCode, message: string) => {
    status = s;
    code = c;
    error = message;
  };

  let policyPassed = false;
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
    const message = e instanceof Error ? e.message : String(e);
    if (e instanceof PolicyError) fail("rejected", e.code, message);
    else if (e instanceof ViewKeyUnavailable) fail("error", "VIEWKEY_UNAVAILABLE", message);
    else fail("error", "CONFIG_ERROR", message);
  }

  // One send at a time per wallet: an in-process queue, then the wallet lease shared with
  // every process on the wallet. Later calls queue for a bounded time, then get BUSY.
  let lock: WalletLock | undefined;
  if (policyPassed && amountZats !== undefined) {
    try {
      lock = await acquireWalletLock(store, config.sendQueueWaitMs ?? SEND_QUEUE_WAIT_DEFAULT_MS, "zcash_pay");
    } catch (e) {
      policyPassed = false;
      if (e instanceof BusyError) fail("error", "BUSY", e.message);
      else fail("error", "CHAIN_ERROR", `The wallet lock could not be taken: ${e instanceof Error ? e.message : String(e)}. Nothing was sent.`);
    }
  }

  let wroteIntent = false;
  let audit: AuditEntry;
  let final: ReturnType<typeof writeAuditRow>;
  try {
    // Another process on this wallet may have bound the key while this call queued.
    // Under the lease, read the binding fresh; if taken, this call becomes a replay or a
    // conflict and sends nothing.
    if (lock && keyFields.idempotency_key) {
      const other = store.readKey(keyFields.idempotency_key);
      if (other && other.call_id !== callId) {
        lock.release();
        lock = undefined;
        return priorUse(input, deps, store, callId, keyFields.idempotency_key, keyFields.params_sha256!)!;
      }
    }

    // Live mode: check the wallet and server before anything is bound. A failure here
    // sends nothing, binds nothing, and the key stays free for a retry.
    if (policyPassed && amountZats !== undefined && config.chainMode === "live" && chain.checkHealth) {
      const tipFloor = safelyRead(() => store.readTipMark());
      let seen: ChainHealth | undefined;
      const problem = await preSendProblem(
        async () => {
          seen = await chain.checkHealth!();
          return seen;
        },
        amountZats,
        config.healthMaxLagBlocks ?? HEALTH_MAX_LAG_DEFAULT,
        tipFloor
      );
      if (problem) {
        policyPassed = false;
        fail("error", problem.code, problem.message);
      } else if (seen) {
        // Anchor any later expiry proof on the highest of what the server said, what the
        // wallet itself has scanned, and the highest tip ever recorded: never a lower one.
        chainTip = expiryAnchor(seen, tipFloor);
        walletHeight = seen.walletHeight;
        // Record it, capped a little above the wallet's own height: a server that reports a
        // tip far ahead (within a loose lag limit) cannot push the mark up and block
        // honest readings afterwards.
        try {
          store.raiseTipMark(Math.min(seen.chainTip, seen.walletHeight + TIP_TOLERANCE_BLOCKS));
        } catch {
          // The anchor above still holds for this call.
        }
      }
    }

    if (policyPassed && amountZats !== undefined && lock) {
      // The health check can be slow. Prove the lease is still ours before any write.
      try {
        lock.assertHeld();
      } catch (e) {
        policyPassed = false;
        fail("error", "BUSY", lostLeaseMessage(e));
      }
    }

    // The health check can take minutes. Read the key's binding again now that the lease is
    // proven: if another call took it meanwhile, this call is a replay and sends nothing.
    if (policyPassed && amountZats !== undefined && lock && keyFields.idempotency_key) {
      const other = store.readKey(keyFields.idempotency_key);
      if (other && other.call_id !== callId) {
        lock.release();
        lock = undefined;
        return priorUse(input, deps, store, callId, keyFields.idempotency_key, keyFields.params_sha256!)!;
      }
    }

    if (policyPassed && amountZats !== undefined && lock) {
      // Record the intent, then the audit pending row, then bind the key: all on disk
      // before the broadcast. The key is bound last so a call that stops here leaves it
      // free; once bound, nothing slow runs before the send.
      status = "pending";
      const intent: CallIntent = {
        call_id: callId,
        ts: new Date(startedAt).toISOString(),
        amount_zec: input.amount_zec,
        amount_zats: amountZats.toString(),
        recipient: input.recipient,
        memo: input.memo,
        allowlist_hit: allowlistHit,
        cap_zec: config.spendingCapZec,
        view_key_fingerprint: viewKeyFingerprint,
        ...keyFields,
        chain_tip: chainTip,
        wallet_height: walletHeight,
      };
      let ready = false;
      try {
        store.writeIntent(intent);
        wroteIntent = true;
        ready = true;
      } catch (e) {
        fail("error", "STATE_WRITE_FAILED", `The payment store could not be written before the send: ${e instanceof Error ? e.message : String(e)}. Nothing was sent.`);
      }

      if (ready) {
        const pendingRow = boundAuditEntry(entry());
        const written = writeAuditRow(config, pendingRow);
        if (written.warning) warnings.push(written.warning);
        if (!written.durable) {
          ready = false;
          fail("error", "AUDIT_WRITE_FAILED", `Audit write failed before send; payment not sent: ${written.warning}`);
        }
      }

      if (ready) {
        // Last check before binding and sending: the lease is still this call's.
        try {
          lock.assertHeld();
        } catch (e) {
          ready = false;
          fail("error", "BUSY", lostLeaseMessage(e));
        }
      }

      if (ready && keyFields.idempotency_key) {
        let bound: ReturnType<PaymentStore["bindKey"]> | undefined;
        try {
          bound = store.bindKey(keyFields.idempotency_key, callId, keyFields.params_sha256!);
        } catch (e) {
          ready = false;
          fail("error", "STATE_WRITE_FAILED", `The idempotency key could not be bound: ${e instanceof Error ? e.message : String(e)}. Nothing was sent.`);
        }
        if (bound && !bound.won) {
          // Another call won the key, one the lease did not stop. It owns the key; this
          // call sends nothing and reports that call's outcome.
          recordSafely(store, { ts: now(), call_id: callId, state: "not_sent", code: "IDEMPOTENCY_CONFLICT", error: "Another call bound this idempotency key first.", by: "send" }, warnings);
          writeAuditRow(config, boundAuditEntry({ ...entry(), status: "error", code: "IDEMPOTENCY_CONFLICT", error: "Another call bound this idempotency key first. Nothing was sent." }));
          lock.release();
          lock = undefined;
          return priorUse(input, deps, store, callId, keyFields.idempotency_key, keyFields.params_sha256!)!;
        }
      }

      if (!ready && wroteIntent) {
        recordSafely(store, { ts: now(), call_id: callId, state: "not_sent", code, error, by: "send" }, warnings);
      }

      if (ready) {
        try {
          const receipt = await chain.pay({
            amountZats,
            recipient: input.recipient,
            memo: input.memo,
            fence: () => {
              try {
                lock!.assertHeld();
              } catch (e) {
                throw new FenceError(lostLeaseMessage(e));
              }
            },
          });
          mockTxid = receipt.txid;
          status = "ok";
          code = undefined;
          error = undefined;
          try {
            store.claimTxid(receipt.txid, callId);
          } catch {
            // The sent event below carries the txid; the claim only guides matching.
          }
          recordSafely(store, { ts: now(), call_id: callId, state: "sent", txid: receipt.txid, by: "send" }, warnings);
        } catch (e) {
          if (e instanceof SendOutcomeUnknownError) {
            fail("unknown", "SEND_UNCONFIRMED", `${SEND_UNCONFIRMED_GUIDANCE} Detail: ${redactInput(e.message, input)}`);
            possibleSends = await findPossibleSends(
              chain,
              { amountZats, recipient: input.recipient, memo: input.memo },
              startedAt,
              (txid) => safeOwner(store, txid),
              callId
            );
            recordSafely(store, { ts: now(), call_id: callId, state: "unknown", code, error, possible_sends: possibleSends, by: "send" }, warnings);
          } else if (e instanceof FenceError) {
            fail("error", "BUSY", e.message);
            recordSafely(store, { ts: now(), call_id: callId, state: "not_sent", code, error, by: "send" }, warnings);
          } else {
            fail("error", "CHAIN_ERROR", redactInput(e instanceof Error ? e.message : String(e), input));
            recordSafely(store, { ts: now(), call_id: callId, state: "not_sent", code, error, by: "send" }, warnings);
          }
        }
      }
    }

    // The response carries the same bounded row that goes to disk.
    audit = boundAuditEntry(entry());
    // writeAuditRow never throws. A send may already have happened, and throwing would hide
    // the txid and invite a retry that pays twice. A failed write is reported with the result.
    final = writeAuditRow(config, audit);
  } finally {
    lock?.release();
  }
  if (!wroteIntent && status !== "ok") rememberRefusal(callId, { code, error, amount_zats: amountZats?.toString(), idempotency_key: keyFields.idempotency_key });
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

function now(): string {
  return new Date().toISOString();
}

function lostLeaseMessage(e: unknown): string {
  const detail = e instanceof LeaseLostError ? e.detail : e instanceof Error ? e.message : String(e);
  return `The wallet lock was lost before the send (${detail}). Nothing was sent. Try again.`;
}

function safeOwner(store: PaymentStore, txid: string): string | undefined {
  try {
    return store.txidOwner(txid);
  } catch {
    return undefined;
  }
}

/** Record an event after the send decision. A failure becomes a warning; it never hides the outcome. */
function recordSafely(store: PaymentStore, event: Parameters<PaymentStore["advance"]>[0], warnings: string[]): void {
  try {
    store.advance(event);
  } catch (e) {
    warnings.push(`The payment store could not record this outcome (${e instanceof Error ? e.message : String(e)}); the audit log has it.`);
  }
}
