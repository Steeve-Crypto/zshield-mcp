import type { ChainAdapter } from "./types.js";
import type { SyncResult } from "./sync.js";
import type { ChainHealth, PaymentReceipt, PaymentRequest, TxSummary, WalletBalance } from "../types.js";
import { assertTestnetAddress, NetworkError } from "./network.js";
import { ChainUnreachableError, SendOutcomeUnknownError } from "./outcome.js";
import { MAX_MONEY_ZATS, ZATS_PER_ZEC } from "../policy/amount.js";
import { walletStateDir } from "../payments/store.js";
import { displayUrl, redact } from "../redact.js";
import { healthSyncTimeoutMs, healthTimeoutMs, readTimeoutMs, SEND_TIMEOUT_MS, STAGE_TIMEOUT_MS } from "./live.js";

/**
 * Posts one GraphQL operation with its variables and returns `data`. Injectable for tests.
 * Every value goes in `variables`, never into the query text: the recipient and memo come
 * from the agent, and a quote in either could otherwise add a recipient or change the
 * amount past the policy cap.
 */
export type GraphqlRunner = (url: string, query: string, variables: Record<string, unknown>, timeoutMs: number) => Promise<unknown>;

/** zkool_graphql's account ids are i32. */
export const MAX_ZKOOL_ACCOUNT = 2 ** 31 - 1;

/** The longest memo a Zcash note carries, in UTF-8 bytes. */
const MAX_MEMO_BYTES = 512;

const TXID = /^[0-9a-f]{64}$/;

export function createGraphqlRunner(fetchFn: typeof globalThis.fetch = globalThis.fetch): GraphqlRunner {
  return async (url, query, variables, timeoutMs) => {
    const res = await fetchFn(`${url.replace(/\/$/, "")}/graphql`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`zkool_graphql answered ${res.status} ${res.statusText}`.trim());
    const body = (await res.json()) as { data?: unknown; errors?: { message?: string }[] };
    if (body.errors?.length) throw new Error(`zkool_graphql: ${body.errors.map((e) => String(e.message)).join("; ").slice(0, 500)}`);
    return body.data;
  };
}

export interface ZkoolOptions {
  network: string | undefined;
  url?: string;
  account?: number;
  /** Folder holding the payment store; every process paying from this account must share it. */
  stateDir?: string;
  runner?: GraphqlRunner;
}

/**
 * Testnet adapter backed by zkool_graphql (https://github.com/hhanh00/zkool2), the wallet
 * server with a release binary and no Rust build. One zkool account is one wallet.
 *
 * A send is staged like the zingo adapter's: `prepareSend` builds the transaction,
 * `decodePczt` gives its txid (zkool2 #1647; under ZIP 244 signing cannot change it), and
 * `signTx` signs it, with nothing broadcast; `req.stage` records the txid durably; only then
 * does `broadcastTx` post exactly those bytes, and its answer must be that txid. Any
 * failure before the broadcast is a clean "not sent". The signed bytes live only in this
 * process, so a crash after staging cannot be resumed: the call stays unresolved until the
 * wallet shows the txid mined, which recovery and zcash_payment_status read by txid.
 */
export class ZkoolChainAdapter implements ChainAdapter {
  readonly mode = "live" as const;
  readonly stagesBeforeBroadcast = true as const;
  readonly tracksTransmitAuthorization = true as const;
  readonly network = "testnet" as const;
  readonly url: string;
  readonly account: number;
  readonly stateDir?: string;
  private readonly runner: GraphqlRunner;

  constructor(opts: ZkoolOptions) {
    if (opts.network !== "testnet") {
      throw new NetworkError("CHAIN_MODE=zkool is testnet only. Mainnet is not supported.", "mode");
    }
    this.url = opts.url ?? "http://127.0.0.1:8000";
    this.account = opts.account ?? 1;
    if (!Number.isInteger(this.account) || this.account < 1 || this.account > MAX_ZKOOL_ACCOUNT) {
      throw new Error(`ZKOOL_ACCOUNT must be a positive integer, got ${this.account}`);
    }
    this.stateDir = opts.stateDir ? walletStateDir(opts.stateDir) : undefined;
    this.runner = opts.runner ?? createGraphqlRunner();
  }

  private async call<T>(query: string, variables: Record<string, unknown>, timeoutMs: number): Promise<T> {
    try {
      return (await this.runner(this.url, query, variables, timeoutMs)) as T;
    } catch (e) {
      throw new Error(redact(e instanceof Error ? e.message : String(e)));
    }
  }

  /** The account's unified address, checked to be testnet: a mainnet database is refused. */
  async getReceiveAddress(): Promise<string> {
    const data = await this.call<{ addressByAccount?: { ua?: string | null } }>(
      "query($account: Int!) { addressByAccount(idAccount: $account) { ua } }",
      { account: this.account },
      readTimeoutMs()
    );
    const ua = data?.addressByAccount?.ua;
    if (typeof ua !== "string" || ua === "") throw new Error("zkool_graphql returned no address for the account");
    assertTestnetAddress(ua);
    return ua;
  }

  async getViewingKey(): Promise<string> {
    const data = await this.call<{ unifiedFullViewingKey?: string }>(
      "query($account: Int!) { unifiedFullViewingKey(idAccount: $account) }",
      { account: this.account },
      readTimeoutMs()
    );
    const key = data?.unifiedFullViewingKey;
    if (typeof key !== "string" || !key.startsWith("uviewtest1")) throw new Error("zkool_graphql returned no testnet viewing key for the account");
    return key;
  }

  async getBalance(): Promise<WalletBalance> {
    const data = await this.call<{ balanceByAccount?: { total?: unknown }; unconfirmedByAccount?: { value?: unknown }[] }>(
      "query($account: Int!) { balanceByAccount(idAccount: $account) { total } unconfirmedByAccount(idAccount: $account) { value } }",
      { account: this.account },
      readTimeoutMs()
    );
    const confirmed = zecToZats(data?.balanceByAccount?.total, "balance");
    let unconfirmed = 0n;
    for (const t of data?.unconfirmedByAccount ?? []) {
      const v = zecToZats(t.value, "unconfirmed value");
      if (v > 0n) unconfirmed += v;
    }
    return { confirmedZats: confirmed, spendableZats: confirmed, unconfirmedZats: unconfirmed };
  }

  /** The height this account has scanned to. */
  async walletHeight(): Promise<number> {
    const data = await this.call<{ accounts?: { id: number; height: number }[] }>(
      "query($account: Int!) { accounts(accountFilter: { id: $account }) { id height } }",
      { account: this.account },
      healthTimeoutMs()
    );
    const row = (data?.accounts ?? []).find((a) => a.id === this.account);
    if (!row || !Number.isSafeInteger(row.height) || row.height < 0) throw new Error(`zkool_graphql has no account ${this.account}`);
    return row.height;
  }

  /** Scans the account to the chain tip, for at most `timeoutMs`. Never sends. Never throws. */
  async syncWallet(timeoutMs: number): Promise<SyncResult> {
    const started = Date.now();
    if (timeoutMs <= 0) return { complete: false, elapsedMs: 0, detail: "sync skipped (timeout is 0)" };
    try {
      const data = await this.call<{ synchronize?: number }>(
        "mutation($accounts: [Int!]!) { synchronize(idAccounts: $accounts, fast: false) }",
        { accounts: [this.account] },
        timeoutMs
      );
      const height = data?.synchronize;
      return { complete: true, elapsedMs: Date.now() - started, ...(Number.isSafeInteger(height) ? { scannedHeight: height } : {}) };
    } catch (e) {
      return { complete: false, elapsedMs: Date.now() - started, detail: e instanceof Error ? e.message : String(e) };
    }
  }

  /** The pre-send check: a bounded sync, then the server's tip, the account's height and its balance. */
  async checkHealth(opts: { sync?: boolean } = {}): Promise<ChainHealth> {
    let synced: boolean | undefined;
    let syncDetail: string | undefined;
    const syncMs = healthSyncTimeoutMs();
    if (opts.sync !== false && syncMs > 0) {
      const r = await this.syncWallet(syncMs);
      synced = r.complete;
      syncDetail = r.detail;
    }
    let chainTip: number;
    try {
      const data = await this.call<{ currentHeight?: number }>("query { currentHeight }", {}, healthTimeoutMs());
      chainTip = data?.currentHeight as number;
      if (!Number.isSafeInteger(chainTip) || chainTip <= 0) throw new Error("no chain height in the answer");
    } catch (e) {
      throw new ChainUnreachableError(`zkool_graphql at ${displayUrl(this.url)} did not report the chain tip: ${e instanceof Error ? e.message : String(e)}`);
    }
    const walletHeight = await this.walletHeight();
    const { spendableZats } = await this.getBalance();
    return { walletHeight, chainTip, spendableZats, ...(synced === undefined ? {} : { synced }), ...(syncDetail ? { syncDetail } : {}) };
  }

  /**
   * Up to `limit` transactions, newest first: mined ones from the account's history, then
   * the ones still in the mempool. zkool answers in JSON, so every entry is `verified`.
   * Entries carry no `outgoing` notes: zkool lists each output under its single-receiver
   * address, never the unified address that was paid, so they could not be matched to a call.
   */
  async getHistory(limit: number, opts: { offline?: boolean; verifiedOnly?: boolean; timeoutMs?: number } = {}): Promise<TxSummary[]> {
    const timeoutMs = opts.timeoutMs === undefined ? readTimeoutMs() : Math.min(readTimeoutMs(), Math.max(1, Math.floor(opts.timeoutMs)));
    const data = await this.call<{
      transactionsByAccount?: { txid: string; height: number; time?: string; value: unknown; fee: unknown }[];
      unconfirmedByAccount?: { txid: string; value: unknown }[];
    }>(
      "query($account: Int!) { transactionsByAccount(idAccount: $account) { txid height time value fee } unconfirmedByAccount(idAccount: $account) { txid value } }",
      { account: this.account },
      timeoutMs
    );
    const out: TxSummary[] = [];
    const seen = new Set<string>();
    for (const t of data?.transactionsByAccount ?? []) {
      const txid = String(t.txid).toLowerCase();
      if (!TXID.test(txid)) continue;
      seen.add(txid);
      const value = zecToZats(t.value, "transaction value");
      const fee = zecToZats(t.fee, "transaction fee");
      const mined = Number.isSafeInteger(t.height) && t.height > 0;
      out.push({
        txid,
        ...(t.time ? { time: asUtc(t.time) } : {}),
        status: mined ? "confirmed" : "mempool",
        ...(mined ? { blockHeight: t.height } : {}),
        ...summarize(value, fee),
        verified: true,
      });
    }
    for (const t of data?.unconfirmedByAccount ?? []) {
      const txid = String(t.txid).toLowerCase();
      if (!TXID.test(txid) || seen.has(txid)) continue;
      seen.add(txid);
      out.push({ txid, status: "mempool", ...summarize(zecToZats(t.value, "unconfirmed value"), undefined), verified: true });
    }
    const height = (t: TxSummary) => t.blockHeight ?? Number.MAX_SAFE_INTEGER;
    return out.sort((a, b) => height(b) - height(a)).slice(0, limit);
  }

  async pay(req: PaymentRequest): Promise<PaymentReceipt> {
    assertTestnetAddress(req.recipient);
    if (typeof req.amountZats !== "bigint" || req.amountZats <= 0n || req.amountZats > MAX_MONEY_ZATS) {
      throw new Error("Amount must be a positive integer number of zatoshis, at most 21 million ZEC");
    }
    if (req.memo !== undefined && Buffer.byteLength(req.memo, "utf8") > MAX_MEMO_BYTES) {
      throw new Error(`Memo refused: longer than ${MAX_MEMO_BYTES} bytes`);
    }
    // The account must be a testnet wallet before anything is built from it.
    await this.getReceiveAddress();
    const payment = {
      recipients: [{ address: req.recipient, amount: formatZec(req.amountZats), ...(req.memo ? { memo: req.memo } : {}) }],
      confirmations: 1,
    };

    // Step one, nothing broadcast: build, read the txid, check, sign. Every failure
    // here is a clean "not sent".
    req.fence?.();
    const prepared = await this.call<{ prepareSend?: string }>(
      "query($account: Int!, $payment: Payment!) { prepareSend(idAccount: $account, payment: $payment) }",
      { account: this.account, payment },
      STAGE_TIMEOUT_MS
    );
    const pczt = hexOrThrow(prepared?.prepareSend, "prepareSend");
    const decoded = await this.call<{ decodePczt?: { fee?: unknown; txid?: unknown; recipients?: { value?: unknown }[] } }>(
      "query($pczt: String!) { decodePczt(pczt: $pczt) { fee txid recipients { value } } }",
      { pczt },
      STAGE_TIMEOUT_MS
    );
    // A txid commits to the transaction's effects only (ZIP 244), and the prepared PCZT's
    // effects are final, so this is the id the signed bytes will have.
    const txid = typeof decoded?.decodePczt?.txid === "string" ? decoded.decodePczt.txid.toLowerCase() : "";
    if (!TXID.test(txid)) {
      throw new Error("zkool_graphql did not give the prepared transaction's txid (decodePczt needs zkool2 #1647, after 6.37.0). Nothing was signed or sent.");
    }
    const feeZats = zecToZats(decoded?.decodePczt?.fee, "fee");
    if (feeZats <= 0n) throw new Error("zkool_graphql planned a transaction with no fee");
    // zkool lists each output under its single-receiver address, so the recipient cannot be
    // compared as a string. The amount can: one output must carry exactly what was asked.
    const outputs = (decoded?.decodePczt?.recipients ?? []).map((r) => zecToZats(r.value, "output value"));
    if (!outputs.includes(req.amountZats)) throw new Error("zkool_graphql planned a transaction with no output of the requested amount");
    const signed = await this.call<{ signTx?: string }>(
      "query($account: Int!, $pczt: String!) { signTx(idAccount: $account, pczt: $pczt) }",
      { account: this.account, pczt },
      STAGE_TIMEOUT_MS
    );
    const txBytes = hexOrThrow(signed?.signTx, "signTx");

    // Record the txid durably; if that fails, nothing is broadcast.
    req.stage?.(txid);
    req.authorizeFee?.(feeZats);
    req.fence?.();
    req.beforeTransmit?.();
    // zkool has no wallet lock of its own to wait on: authorize the transmit right before it.
    req.fence?.();
    req.afterLock?.();

    let answer: string | undefined;
    try {
      const posted = await this.call<{ broadcastTx?: string }>(
        "query($txBytes: String!, $account: Int!) { broadcastTx(txBytes: $txBytes, idAccount: $account) }",
        { txBytes, account: this.account },
        SEND_TIMEOUT_MS
      );
      answer = posted?.broadcastTx;
    } catch (e) {
      // The bytes may have reached the network before the error.
      throw new SendOutcomeUnknownError(e instanceof Error ? e.message : String(e), txid);
    }
    if (typeof answer !== "string" || answer.toLowerCase() !== txid) {
      throw new SendOutcomeUnknownError(`zkool_graphql answered the broadcast of ${txid} with ${JSON.stringify(answer)?.slice(0, 200)}`, txid);
    }
    return { txid, amountZats: req.amountZats, recipient: req.recipient, memo: req.memo, mode: "live" };
  }
}

/** A sent entry's value is what left the account less the fee; a received one, what arrived. */
function summarize(value: bigint, fee: bigint | undefined): Pick<TxSummary, "kind" | "valueZats" | "feeZats"> {
  if (value < 0n) {
    const out = -value - (fee ?? 0n);
    return { kind: "sent", valueZats: out > 0n ? out : -value, ...(fee !== undefined ? { feeZats: fee } : {}) };
  }
  return { kind: "received", valueZats: value };
}

/** zkool's LocalDateTime is UTC without a zone. */
function asUtc(time: string): string | undefined {
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(time) ? time : `${time}Z`);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

function hexOrThrow(value: unknown, what: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(value)) {
    throw new Error(`zkool_graphql ${what} returned no hex data. Nothing was sent.`);
  }
  return value;
}

/** Exact ZEC decimal (as zkool's BigDecimal prints it) to zatoshis. Never rounds. */
export function zecToZats(value: unknown, what: string): bigint {
  const text = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
  const m = typeof text === "string" ? /^(-?)(\d{1,10})(?:\.(\d{1,8})0*)?$/.exec(text.trim()) : null;
  if (!m) throw new Error(`zkool_graphql returned an unreadable ${what}: ${JSON.stringify(value)?.slice(0, 40)}`);
  const zats = BigInt(m[2]) * ZATS_PER_ZEC + BigInt((m[3] ?? "").padEnd(8, "0"));
  return m[1] === "-" ? -zats : zats;
}

/** Zatoshis as the 8-decimal ZEC string zkool's BigDecimal takes. */
export function formatZec(zats: bigint): string {
  const s = zats.toString().padStart(9, "0");
  return `${s.slice(0, -8)}.${s.slice(-8)}`;
}
