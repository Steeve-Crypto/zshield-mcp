import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChainAdapter } from "./types.js";
import type { SyncResult } from "./sync.js";
import type { ChainHealth, PaymentReceipt, PaymentRequest, TxSummary, WalletBalance } from "../types.js";
import { assertTestnetAddress, NetworkError } from "./network.js";
import { ChainUnreachableError, SendOutcomeUnknownError } from "./outcome.js";
import { MAX_MONEY_ZATS } from "../policy/amount.js";
import { walletStateDir } from "../payments/store.js";
import { redact } from "../redact.js";
import { zecToZats } from "./zkool.js";
import { healthSyncTimeoutMs, healthTimeoutMs, readTimeoutMs, SEND_TIMEOUT_MS, STAGE_TIMEOUT_MS } from "./live.js";

export interface ToolResult {
  status: number | null;
  stdout: Buffer;
  stderr: string;
}

/** Runs one program with no shell. Injectable for tests. */
export type ToolRunner = (cmd: string, args: string[], opts: { cwd?: string; input?: Buffer; timeoutMs: number }) => Promise<ToolResult>;

/** The longest memo a Zcash note carries, in UTF-8 bytes. */
const MAX_MEMO_BYTES = 512;
const TXID = /^[0-9a-f]{64}$/;
/**
 * How long the signing round waits for the co-signer. A running daemon answers within seconds;
 * coordinate itself would wait an hour, so an offline co-signer is a refusal after this.
 */
export const COSIGN_TIMEOUT_MS = 120_000;

/** A program stopped because it ran out of time. */
class ToolTimeoutError extends Error {}

/** Kept from a failing program's stderr for the error message. */
const STDERR_KEEP = 4_000;

/**
 * zcash-devtool asks `tput cols` for the terminal width and fails with EAGAIN when there is
 * no terminal (an MCP server has none), so every child gets TERM=dumb.
 */
export function createToolRunner(): ToolRunner {
  return (cmd, args, opts) =>
    new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, TERM: "dumb" }, stdio: ["pipe", "pipe", "pipe"] });
      const out: Buffer[] = [];
      let err = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs);
      child.stdout.on("data", (d: Buffer) => out.push(d));
      child.stderr.on("data", (d: Buffer) => {
        err = (err + d.toString("utf8")).slice(-STDERR_KEEP);
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (status, signal) => {
        clearTimeout(timer);
        resolve({ status: signal ? null : status, stdout: Buffer.concat(out), stderr: err });
      });
      child.stdin.end(opts.input);
    });
}

export interface IroncladOptions {
  network: string | undefined;
  /** zcash-devtool, built from the zcash/zcash-devtool main branch. */
  devtool: string;
  /** The devtool wallet holding the FROST group's viewing key (one account). */
  walletDir: string;
  /** ironclad-cosigner, the binary that holds this agent's share and runs the signing round. */
  cosigner: string;
  /** The co-signer's data folder (holds data/ with this agent's share). */
  frostDir: string;
  /** The session folder the co-signer daemon watches. */
  sessionDir: string;
  /** This agent's member number in the group. */
  share?: string;
  /** devtool's server name. */
  server?: string;
  /** devtool's connection mode: "tor", "direct" or "socks5://host:port". */
  connection?: string;
  stateDir?: string;
  runner?: ToolRunner;
}

/**
 * Testnet adapter for an Ironclad group: a 2-of-3 FROST key where this agent holds one share
 * and the owner's policy co-signer holds another (https://github.com/adilhusain01/ironclad).
 * The agent cannot spend alone; the co-signer signs only what the owner's policy allows,
 * and logs every decision, allow or refuse, in its own hash-chained ledger.
 *
 * A send is staged: zcash-devtool builds and proves the PCZT; `ironclad-cosigner inspect
 * --json` gives the fee and payments the co-signer's own checks find, and exactly one
 * payment must carry the requested amount; the co-signer round adds both signature shares
 * (a policy refusal ends the call here, with nothing sent); `pczt extract` gives the txid
 * of the finished transaction without broadcasting it; `req.stage` records that txid; only
 * then does `pczt send` broadcast those same signed bytes, and it must report that txid.
 * The signed PCZT lives in a temporary folder of this process, so a crash after staging
 * cannot be resumed: the call stays unresolved until the wallet shows the txid.
 */
export class IroncladChainAdapter implements ChainAdapter {
  readonly mode = "live" as const;
  readonly stagesBeforeBroadcast = true as const;
  readonly tracksTransmitAuthorization = true as const;
  readonly network = "testnet" as const;
  readonly stateDir?: string;
  private readonly opts: Required<Omit<IroncladOptions, "stateDir" | "runner" | "network">>;
  private readonly runner: ToolRunner;

  constructor(opts: IroncladOptions) {
    if (opts.network !== "testnet") {
      throw new NetworkError("CHAIN_MODE=ironclad is testnet only. Mainnet is not supported.", "mode");
    }
    const share = opts.share ?? "1";
    if (!/^[1-9][0-9]{0,4}$/.test(share)) throw new Error(`IRONCLAD_SHARE must be a member number, got ${JSON.stringify(share)}`);
    const connection = opts.connection ?? "tor";
    if (!/^(tor|direct|socks5:\/\/[^\s]+)$/.test(connection)) throw new Error(`IRONCLAD_CONNECTION must be tor, direct or socks5://host:port`);
    this.opts = {
      devtool: opts.devtool,
      walletDir: opts.walletDir,
      cosigner: opts.cosigner,
      frostDir: opts.frostDir,
      sessionDir: opts.sessionDir,
      share,
      server: opts.server ?? "zecrocks",
      connection,
    };
    this.stateDir = opts.stateDir ? walletStateDir(opts.stateDir) : undefined;
    this.runner = opts.runner ?? createToolRunner();
  }

  /** Runs a program and returns its stdout; a non-zero exit throws with the end of stderr. */
  private async run(cmd: string, args: string[], timeoutMs: number, opts: { cwd?: string; input?: Buffer } = {}): Promise<Buffer> {
    let r: ToolResult;
    try {
      r = await this.runner(cmd, args, { ...opts, timeoutMs });
    } catch (e) {
      throw new Error(redact(`${cmd.split("/").pop()} did not start: ${e instanceof Error ? e.message : String(e)}`));
    }
    if (r.status === null) throw new ToolTimeoutError(redact(`${cmd.split("/").pop()} ${args[0] ?? ""} was stopped (timeout)`));
    if (r.status !== 0) {
      const what = r.status === null ? "was stopped (timeout)" : `exited ${r.status}`;
      throw new Error(redact(`${cmd.split("/").pop()} ${args[0] ?? ""} ${args[1] ?? ""} ${what}: ${lastLines(r.stderr)}`.replace(/\s+/g, " ").trim()));
    }
    return r.stdout;
  }

  private wallet(args: string[], timeoutMs: number): Promise<string> {
    return this.run(this.opts.devtool, ["wallet", "-w", this.opts.walletDir, ...args], timeoutMs).then((b) => b.toString("utf8"));
  }

  private remote(): string[] {
    return ["-s", this.opts.server, "--connection", this.opts.connection];
  }

  /** The wallet's only account: its UFVK, checked to be testnet. */
  private async account(): Promise<{ ufvk: string }> {
    const out = await this.wallet(["list-accounts"], readTimeoutMs());
    const accounts = out.split("\n").filter((l) => /^Account /.test(l));
    if (accounts.length !== 1) throw new Error(`the Ironclad group wallet must hold exactly one account, it holds ${accounts.length}`);
    const ufvk = /^\s+UFVK:\s+(\S+)\s*$/m.exec(out)?.[1];
    if (!ufvk || !ufvk.startsWith("uviewtest1")) throw new Error("the Ironclad group wallet has no testnet viewing key");
    return { ufvk };
  }

  async getReceiveAddress(): Promise<string> {
    const out = await this.wallet(["list-addresses"], readTimeoutMs());
    const ua = /Default Address:\s+(\S+)/.exec(out)?.[1];
    if (!ua) throw new Error("zcash-devtool listed no address for the Ironclad group");
    assertTestnetAddress(ua);
    return ua;
  }

  async getViewingKey(): Promise<string> {
    return (await this.account()).ufvk;
  }

  private async balanceJson(): Promise<Record<string, unknown>> {
    const out = await this.wallet(["balance", "--json"], readTimeoutMs());
    try {
      const parsed = JSON.parse(out.trim().split("\n").pop() ?? "") as unknown;
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    } catch {
      /* falls through */
    }
    throw new Error("zcash-devtool balance --json gave no JSON object");
  }

  async getBalance(): Promise<WalletBalance> {
    const b = await this.balanceJson();
    const zats = (key: string): bigint => {
      const v = b[key];
      if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw new Error(`zcash-devtool balance has no whole ${key}`);
      return BigInt(v);
    };
    const total = zats("total");
    // A shielded send spends shielded notes only.
    const spendable = zats("ironwood_spendable") + zats("sapling_spendable") + zats("orchard_spendable");
    return { confirmedZats: total, spendableZats: spendable, unconfirmedZats: 0n };
  }

  /** The height the wallet has scanned to, as devtool's balance reports it. */
  async walletHeight(): Promise<number> {
    const h = (await this.balanceJson()).chain_tip_height;
    if (typeof h !== "number" || !Number.isSafeInteger(h) || h < 0) throw new Error("zcash-devtool balance has no chain_tip_height");
    return h;
  }

  /** Scans the group wallet to the chain tip, for at most `timeoutMs`. Never sends. Never throws. */
  async syncWallet(timeoutMs: number): Promise<SyncResult> {
    const started = Date.now();
    if (timeoutMs <= 0) return { complete: false, elapsedMs: 0, detail: "sync skipped (timeout is 0)" };
    try {
      await this.wallet(["sync", ...this.remote()], timeoutMs);
      return { complete: true, elapsedMs: Date.now() - started };
    } catch (e) {
      return { complete: false, elapsedMs: Date.now() - started, detail: e instanceof Error ? e.message : String(e) };
    }
  }

  /** The pre-send check: a bounded sync, then the server's tip (testnet only), the wallet's height and spendable balance. */
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
      const out = await this.wallet(["get-info", ...this.remote()], healthTimeoutMs());
      const info = JSON.parse(out.trim().split("\n").pop() ?? "") as { chain_name?: unknown; chain_tip_height?: unknown };
      if (info.chain_name !== "test") throw new NetworkError(`the light wallet server is on ${JSON.stringify(info.chain_name)}, not testnet`, "mode");
      chainTip = info.chain_tip_height as number;
      if (!Number.isSafeInteger(chainTip) || chainTip <= 0) throw new Error("no chain height in the answer");
    } catch (e) {
      if (e instanceof NetworkError) throw e;
      throw new ChainUnreachableError(`zcash-devtool did not report the chain tip: ${e instanceof Error ? e.message : String(e)}`);
    }
    const walletHeight = await this.walletHeight();
    const { spendableZats } = await this.getBalance();
    return { walletHeight, chainTip, spendableZats, ...(synced === undefined ? {} : { synced }), ...(syncDetail ? { syncDetail } : {}) };
  }

  /**
   * Up to `limit` transactions, newest first, from devtool's listing. An entry is
   * `verified` only when `list-tx --json` lists the same txid at the same height and the
   * listing names it once. Entries carry no `outgoing` notes: devtool prints memos in Rust's
   * debug escaping, and a memo decoded wrongly could match a call it does not belong to.
   * This mode stages every txid before broadcast, so calls are matched by txid.
   */
  async getHistory(limit: number, opts: { offline?: boolean; verifiedOnly?: boolean; timeoutMs?: number } = {}): Promise<TxSummary[]> {
    const timeoutMs = opts.timeoutMs === undefined ? readTimeoutMs() : Math.min(readTimeoutMs(), Math.max(1, Math.floor(opts.timeoutMs)));
    const [text, json] = await Promise.all([this.wallet(["list-tx"], timeoutMs), this.wallet(["list-tx", "--json"], timeoutMs)]);
    const mined = new Map<string, number | null>();
    try {
      for (const row of JSON.parse(json.trim().split("\n").pop() ?? "[]") as { txid?: unknown; mined_height?: unknown }[]) {
        if (typeof row.txid === "string" && TXID.test(row.txid)) mined.set(row.txid, typeof row.mined_height === "number" ? row.mined_height : null);
      }
    } catch {
      /* every entry stays unverified */
    }
    const entries = parseListTx(text);
    const counts = new Map<string, number>();
    for (const e of entries) counts.set(e.txid, (counts.get(e.txid) ?? 0) + 1);
    const out = entries.map((e) => {
      const fromJson = mined.get(e.txid);
      const verified = counts.get(e.txid) === 1 && mined.has(e.txid) && (fromJson ?? undefined) === e.blockHeight;
      return { ...e, verified };
    });
    const height = (t: TxSummary) => t.blockHeight ?? Number.MAX_SAFE_INTEGER;
    const sorted = out.sort((a, b) => height(b) - height(a));
    return (opts.verifiedOnly ? sorted.filter((t) => t.verified) : sorted).slice(0, limit);
  }

  async getTransaction(txid: string): Promise<TxSummary[]> {
    return (await this.getHistory(Infinity)).filter((t) => t.txid === txid);
  }

  async pay(req: PaymentRequest): Promise<PaymentReceipt> {
    assertTestnetAddress(req.recipient);
    if (typeof req.amountZats !== "bigint" || req.amountZats <= 0n || req.amountZats > MAX_MONEY_ZATS) {
      throw new Error("Amount must be a positive integer number of zatoshis, at most 21 million ZEC");
    }
    if (req.memo !== undefined && Buffer.byteLength(req.memo, "utf8") > MAX_MEMO_BYTES) {
      throw new Error(`Memo refused: longer than ${MAX_MEMO_BYTES} bytes`);
    }
    // The group wallet must be a single testnet account before anything is built from it.
    await this.account();
    await this.getReceiveAddress();

    const work = mkdtempSync(join(tmpdir(), "zshield-ironclad-"));
    try {
      const created = join(work, "created.pczt");
      const proven = join(work, "proven.pczt");
      const signed = join(work, "signed.pczt");

      // Step one, nothing broadcast: build, prove, check, co-sign, read the txid. Every
      // failure here is a clean "not sent".
      req.fence?.();
      await this.run(
        this.opts.devtool,
        ["pczt", "-w", this.opts.walletDir, "create", "--address", req.recipient, "--value", req.amountZats.toString(), ...(req.memo ? ["--memo", req.memo] : []), "--output", created],
        STAGE_TIMEOUT_MS
      );
      const provenBytes = await this.run(this.opts.devtool, ["pczt", "-w", this.opts.walletDir, "prove"], STAGE_TIMEOUT_MS, { input: await readFile(created) });
      if (provenBytes.length === 0) throw new Error("zcash-devtool prove gave no PCZT. Nothing was sent.");
      await writeFile(proven, provenBytes);

      const checked = parseInspect(
        (await this.run(this.opts.cosigner, ["inspect", "--pczt", proven, "--as", this.opts.share, "--json"], STAGE_TIMEOUT_MS, { cwd: this.opts.frostDir })).toString("utf8")
      );
      // The co-signer reports each payment under its single-receiver address, so the
      // recipient cannot be compared as a string here; the co-signer's allow-list judges
      // it. The amount can: exactly one payment, of exactly what was asked.
      if (checked.payments.length !== 1 || checked.payments[0] !== req.amountZats) {
        throw new Error("the PCZT does not pay exactly the requested amount in one payment. Nothing was signed or sent.");
      }

      try {
        await this.run(
          this.opts.cosigner,
          ["coordinate", "--as", this.opts.share, "--dir", this.opts.sessionDir, "--pczt", proven, "--out", signed],
          COSIGN_TIMEOUT_MS,
          { cwd: this.opts.frostDir }
        );
      } catch (e) {
        if (e instanceof ToolTimeoutError) {
          throw new Error(`the Ironclad co-signer did not answer within ${COSIGN_TIMEOUT_MS / 1000} s (is its daemon running?). Nothing was sent.`);
        }
        const msg = e instanceof Error ? e.message : String(e);
        const refusal = /refused to sign: (.*)$/.exec(msg)?.[1];
        if (refusal) throw new Error(`the Ironclad co-signer refused to sign (${refusal.slice(0, 300)}). Nothing was sent.`);
        throw new Error(`the Ironclad signing round failed: ${msg}. Nothing was sent.`);
      }

      const extracted = (await this.run(this.opts.devtool, ["pczt", "extract"], STAGE_TIMEOUT_MS, { input: await readFile(signed) })).toString("utf8");
      const txid = extracted.trim().split("\n").pop()?.trim().toLowerCase() ?? "";
      if (!TXID.test(txid)) throw new Error("zcash-devtool pczt extract gave no txid. Nothing was sent.");

      // Record the txid durably; if that fails, nothing is broadcast.
      req.stage?.(txid);
      req.authorizeFee?.(checked.feeZats);
      req.fence?.();
      req.beforeTransmit?.();
      // devtool takes no wallet lock of its own to wait on: authorize the transmit right before it.
      req.fence?.();
      req.afterLock?.();

      let answer: string;
      try {
        answer = (await this.run(this.opts.devtool, ["pczt", "-w", this.opts.walletDir, "send", ...this.remote(), signed], SEND_TIMEOUT_MS)).toString("utf8");
      } catch (e) {
        // The bytes may have reached the network before the error.
        throw new SendOutcomeUnknownError(e instanceof Error ? e.message : String(e), txid);
      }
      if (!answer.toLowerCase().match(/[0-9a-f]{64}/g)?.includes(txid)) {
        throw new SendOutcomeUnknownError(`zcash-devtool answered the broadcast of ${txid} without that txid`, txid);
      }
      return { txid, amountZats: req.amountZats, recipient: req.recipient, memo: req.memo, mode: "live" };
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
}

async function readFile(path: string): Promise<Buffer> {
  return (await import("node:fs/promises")).readFile(path);
}

async function writeFile(path: string, data: Buffer): Promise<void> {
  await (await import("node:fs/promises")).writeFile(path, data, { mode: 0o600 });
}

function lastLines(text: string): string {
  return text.trim().split("\n").slice(-6).join(" ").slice(-1_000);
}

/** `ironclad-cosigner inspect --json`: payment amounts and the fee, in whole zatoshis. */
export function parseInspect(out: string): { payments: bigint[]; feeZats: bigint } {
  let v: { payments?: { zat?: unknown }[]; fee_zat?: unknown };
  try {
    v = JSON.parse(out.trim().split("\n").pop() ?? "");
  } catch {
    throw new Error("ironclad-cosigner inspect --json gave no JSON. Nothing was signed or sent.");
  }
  const whole = (x: unknown, what: string): bigint => {
    if (typeof x !== "number" || !Number.isSafeInteger(x) || x < 0) throw new Error(`ironclad-cosigner inspect gave no whole ${what}. Nothing was signed or sent.`);
    return BigInt(x);
  };
  if (!Array.isArray(v.payments)) throw new Error("ironclad-cosigner inspect gave no payments. Nothing was signed or sent.");
  const feeZats = whole(v.fee_zat, "fee");
  if (feeZats <= 0n) throw new Error("ironclad-cosigner inspect found no fee. Nothing was signed or sent.");
  return { payments: v.payments.map((p) => whole(p?.zat, "payment")), feeZats };
}

/**
 * devtool's `wallet list-tx` text: a txid line, then indented fields and outputs. Values are
 * read from the outputs (change left out); a transaction this wallet sent a note in is
 * "sent", otherwise "received". An entry that cannot be read throws for the whole listing:
 * leaving it out could let a real send look like no send.
 */
export function parseListTx(text: string): Omit<TxSummary, "verified">[] {
  const out: Omit<TxSummary, "verified">[] = [];
  const blocks = text.split(/\n(?=[0-9a-f]{64}\s*$)/m);
  for (const block of blocks) {
    const lines = block.split("\n");
    const txid = lines[0]?.trim();
    if (!txid || !TXID.test(txid)) continue;
    {
      const minedLine = lines.find((l) => /^\s+Mined:/.test(l));
      const mined = minedLine ? /^\s+Mined:\s+(\d+)(?:\s+\((.*)\))?/.exec(minedLine) : null;
      const blockHeight = mined ? Number(mined[1]) : undefined;
      const time = mined?.[2] ? devtoolTime(mined[2]) : undefined;
      const feeText = /^\s+Fee paid:\s+(.*)$/m.exec(block)?.[1]?.trim();
      const feeZats = feeText && feeText !== "Unknown" ? amount(feeText) : undefined;
      let sentZats = 0n;
      let receivedZats = 0n;
      let sentNotes = 0;
      const outputs = block.split(/\n(?=\s+Output \d+ )/).slice(1);
      for (const o of outputs) {
        const value = /^\s+Value:\s+(.+?)\s*$/m.exec(o)?.[1];
        if (!value) throw new Error(`zcash-devtool list-tx: an output of ${txid} has no value`);
        const change = /\(Change\)\s*$/.test(value);
        const zats = amount(value.replace(/\s*\(Change\)\s*$/, ""));
        if (change) continue;
        if (/^\s+Sent from account:/m.test(o)) {
          sentZats += zats;
          sentNotes++;
        } else if (/^\s+Received by account:/m.test(o)) {
          receivedZats += zats;
        }
      }
      const sent = sentNotes > 0;
      out.push({
        txid,
        ...(time ? { time } : {}),
        status: blockHeight !== undefined ? "confirmed" : "mempool",
        ...(blockHeight !== undefined ? { blockHeight } : {}),
        kind: sent ? "sent" : "received",
        valueZats: sent ? sentZats : receivedZats,
        ...(sent && feeZats !== undefined ? { feeZats } : {}),
      });
    }
  }
  return out;
}

/** "0.01000000 TAZ" (or ZEC) to zatoshis, exactly. */
function amount(text: string): bigint {
  const m = /^(\d+\.\d{1,8})\s+(TAZ|ZEC)$/.exec(text.trim());
  if (!m) throw new Error(`zcash-devtool list-tx: unreadable amount ${JSON.stringify(text).slice(0, 40)}`);
  return zecToZats(m[1], "amount");
}

/** devtool prints "2026-11-04 6:49:58.0 +00:00:00"; only UTC is read. */
function devtoolTime(text: string): string | undefined {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{1,2}):(\d{2}):(\d{2})(?:\.\d+)? \+00:00:00$/.exec(text.trim());
  if (!m) return undefined;
  const iso = `${m[1]}T${m[2].padStart(2, "0")}:${m[3]}:${m[4]}Z`;
  return Number.isNaN(Date.parse(iso)) ? undefined : new Date(iso).toISOString();
}
