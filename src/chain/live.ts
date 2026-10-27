import { execFile } from "node:child_process";
import type { ChainAdapter } from "./types.js";
import type { PaymentReceipt, PaymentRequest, TxSummary, WalletBalance } from "../types.js";
import { assertTestnetAddress, NetworkError } from "./network.js";
import { CliTimeoutError, SendOutcomeUnknownError } from "./outcome.js";

export const TESTNET_EXPLORER = "https://blockexplorer.one/zcash/testnet/tx/";

export interface RunOptions {
  /** Kill the CLI after this many milliseconds. */
  timeoutMs?: number;
  /**
   * Written to the CLI's stdin, which is then closed. Used to drive the interactive prompt
   * so payment details never appear in argv. When set, stderr is appended to the result,
   * because the prompt reports command errors there and still exits 0.
   */
  input?: string;
}

/** Runs a zingo-cli invocation and returns stdout. Injectable for tests. */
export type CliRunner = (bin: string, args: string[], opts?: RunOptions) => Promise<string>;

/** Sends can take a while to build proofs. */
export const SEND_TIMEOUT_MS = 15 * 60_000;
/** Reads should answer fast or fail. Override with ZINGO_READ_TIMEOUT_MS. */
export const DEFAULT_READ_TIMEOUT_MS = 120_000;

export function readTimeoutMs(): number {
  const v = Number(process.env.ZINGO_READ_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_READ_TIMEOUT_MS;
}

export const defaultRunner: CliRunner = (bin, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const timeout = opts.timeoutMs ?? SEND_TIMEOUT_MS;
    const child = execFile(bin, args, { maxBuffer: 16 * 1024 * 1024, timeout }, (err, stdout, stderr) => {
      if (err) {
        const detail = (stderr || err.message).toString().slice(0, 500);
        // execFile sets killed and signal when the timeout fires or the process is killed.
        if (err.killed || err.signal) {
          reject(new CliTimeoutError(`zingo-cli was stopped (${err.signal ?? "killed"}) after ${timeout} ms: ${detail}`));
        } else {
          reject(new Error(`zingo-cli failed: ${detail}`));
        }
      }
      else resolve(opts.input === undefined ? stdout.toString() : `${stdout}\n${stderr}`);
    });
    if (opts.input !== undefined) {
      child.stdin?.on("error", () => {
        // The CLI exited before reading everything; the exit callback reports it.
      });
      child.stdin?.end(opts.input);
    }
  });

/** Where the testnet wallet lives when ZINGO_DATA_DIR is not set. */
export function defaultWalletDir(): string {
  return `${process.env.HOME}/.zshield-testnet/wallet`;
}

export interface LiveOptions {
  network: string | undefined;
  zingoBin?: string;
  dataDir?: string;
  server?: string;
  runner?: CliRunner;
}

/**
 * Testnet adapter backed by zingo-cli and a public lightwalletd.
 * Refuses to construct unless network is exactly "testnet".
 */
export class LiveChainAdapter implements ChainAdapter {
  readonly mode = "live" as const;
  readonly bin: string;
  readonly dataDir: string;
  readonly server: string;
  private readonly runner: CliRunner;
  /** Cached in memory only, for this process. Never logged or written. */
  private viewingKey?: Promise<string>;

  constructor(opts: LiveOptions) {
    if (opts.network !== "testnet") {
      throw new NetworkError("Live mode requires CHAIN_MODE=testnet. Mainnet is not supported.", "mode");
    }
    this.bin = opts.zingoBin ?? "zingo-cli";
    this.dataDir = opts.dataDir ?? defaultWalletDir();
    this.server = opts.server ?? "https://testnet.zec.rocks:443";
    this.runner = opts.runner ?? defaultRunner;
  }

  baseArgs(): string[] {
    // --waitsync can block past the runner timeout (background sync never reports done),
    // so it is opt-in via ZINGO_WAITSYNC=1. One-shot commands still sync at startup.
    const args = ["--chain", "testnet", "--server", this.server, "--data-dir", this.dataDir];
    if (process.env.ZINGO_WAITSYNC === "1") args.push("--waitsync");
    return args;
  }

  async run(cmd: string[], opts: RunOptions = {}): Promise<string> {
    return this.runner(this.bin, [...this.baseArgs(), ...cmd], opts);
  }

  /** Read-only: runs `balance` and `spendable_balance`. Never sends. */
  async getBalance(): Promise<WalletBalance> {
    const timeoutMs = readTimeoutMs();
    const pools = parseBalance(await this.run(["balance"], { timeoutMs }));
    const spendableZats = parseSpendable(await this.run(["spendable_balance"], { timeoutMs }));
    return { ...pools, spendableZats };
  }

  /** Read-only: runs `transactions` and returns the newest `limit` entries. */
  async getHistory(limit: number): Promise<TxSummary[]> {
    const all = parseTransactions(await this.run(["transactions"], { timeoutMs: readTimeoutMs() }));
    return all.slice(0, limit);
  }

  /** Read-only: runs `addresses` and returns the newest unified address. Refuses a mainnet one. */
  async getReceiveAddress(): Promise<string> {
    const address = parseReceiveAddress(await this.run(["addresses"], { timeoutMs: readTimeoutMs() }));
    assertTestnetAddress(address);
    return address;
  }

  /**
   * Read-only: runs `export_ufvk` in an offline session, so it is fast and touches no
   * network. Cached for the life of the process. The key never leaves this adapter
   * except to be hashed by the caller.
   */
  async getViewingKey(): Promise<string> {
    if (!this.viewingKey) {
      const args = ["--chain", "testnet", "--data-dir", this.dataDir, "--offline", "export_ufvk"];
      const p = this.runner(this.bin, args, { timeoutMs: readTimeoutMs() }).then(parseUfvk);
      // Do not cache a failure; the next call tries again.
      p.catch(() => {
        if (this.viewingKey === p) this.viewingKey = undefined;
      });
      this.viewingKey = p;
    }
    return this.viewingKey;
  }

  async pay(req: PaymentRequest): Promise<PaymentReceipt> {
    assertTestnetAddress(req.recipient);
    if (typeof req.amountZats !== "bigint" || req.amountZats <= 0n) {
      throw new Error("Amount must be a positive integer number of zatoshis");
    }
    // The recipient, amount, and memo go over stdin to zingo-cli's prompt, never in argv,
    // so they do not show up in the process list. argv holds only the fixed base options.
    const input = buildSendInput(req);
    let out: string;
    try {
      out = await this.runner(this.bin, this.baseArgs(), { timeoutMs: SEND_TIMEOUT_MS, input });
    } catch (e) {
      // A send that was cut off may still have been broadcast.
      if (e instanceof CliTimeoutError) throw new SendOutcomeUnknownError(e.message);
      throw e;
    }
    const txid = parseTxid(out);
    return {
      txid,
      amountZats: req.amountZats,
      recipient: req.recipient,
      memo: req.memo,
      mode: "live",
    };
  }
}

/**
 * Build the stdin script for one send: a `quicksend` line in zingo-cli's JSON form, then
 * `quit`. The prompt splits the line like a shell, so the JSON goes inside single quotes.
 * JSON.stringify already escapes newlines and control characters; single quotes become
 * \u0027, which is still valid JSON. The result is one line with no single quote in it.
 */
export function buildSendInput(req: PaymentRequest): string {
  const entry: Record<string, string | number> = {
    address: req.recipient,
    amount: Number(req.amountZats),
  };
  if (!Number.isSafeInteger(entry.amount)) throw new Error("Amount is too large to send");
  if (req.memo) entry.memo = req.memo;
  const json = JSON.stringify([entry]).replace(/'/g, "\\u0027");
  if (/[\r\n']/.test(json)) throw new Error("Send line could not be encoded safely");
  return `quicksend '${json}'\nquit\n`;
}

export function parseTxid(out: string): string {
  const m = out.match(/"txids"\s*:\s*\[\s*"([0-9a-f]{64})"/i);
  if (m) return m[1].toLowerCase();
  if (/error/i.test(out)) throw new Error(`zingo-cli send error: ${out.trim().slice(0, 500)}`);
  // No error and no txid: the send may or may not have gone out.
  throw new SendOutcomeUnknownError(`zingo-cli finished without a txid or an error: ${out.trim().slice(0, 300)}`);
}

/**
 * Parse `zingo-cli export_ufvk`, which prints `{ "ufvk": "uviewtest1...", "birthday": N }`.
 * Only a testnet key is accepted. Error messages never echo the output, since it holds the key.
 */
export function parseUfvk(out: string): string {
  const m = out.match(/"ufvk"\s*:\s*"(uview[a-z0-9]*1[02-9ac-hj-np-z]+)"/);
  if (!m) throw new Error("zingo-cli export_ufvk returned no unified full viewing key");
  if (!m[1].startsWith("uviewtest1")) {
    throw new NetworkError("zingo-cli export_ufvk returned a key that is not for testnet", "mainnet");
  }
  return m[1];
}

/** Parse an integer that zingo-cli may print with underscores, like 12_390_000. */
function parseZatsToken(token: string): bigint {
  return BigInt(token.replace(/_/g, ""));
}

/**
 * Parse `zingo-cli balance`. It prints lines such as `confirmed_orchard_balance: 12_390_000`
 * for each pool. Confirmed and unconfirmed are summed across every pool it reports.
 */
export function parseBalance(out: string): { confirmedZats: bigint; unconfirmedZats: bigint } {
  let confirmedZats = 0n;
  let unconfirmedZats = 0n;
  let seen = 0;
  for (const m of out.matchAll(/^\s*"?(confirmed|unconfirmed)_[a-z]+_balance"?\s*:\s*([\d_]+)/gim)) {
    seen++;
    const v = parseZatsToken(m[2]);
    if (m[1].toLowerCase() === "confirmed") confirmedZats += v;
    else unconfirmedZats += v;
  }
  if (seen === 0) {
    throw new Error(`zingo-cli balance returned no balance lines: ${out.trim().slice(0, 300)}`);
  }
  return { confirmedZats, unconfirmedZats };
}

/** Parse `zingo-cli spendable_balance`, which prints `{ "spendable_balance": 0 }`. */
export function parseSpendable(out: string): bigint {
  const m = out.match(/"?spendable_balance"?\s*:\s*([\d_]+)/i);
  if (!m) throw new Error(`zingo-cli spendable_balance returned no value: ${out.trim().slice(0, 300)}`);
  return parseZatsToken(m[1]);
}

/**
 * Parse `zingo-cli addresses`, a JSON array of `{ account, address_index, encoded_address }`.
 * Returns the address with the highest index on account 0, which is the newest one.
 */
export function parseReceiveAddress(out: string): string {
  const start = out.indexOf("[");
  const end = out.lastIndexOf("]");
  if (start < 0 || end < start) {
    throw new Error(`zingo-cli addresses returned no address list: ${out.trim().slice(0, 300)}`);
  }
  let list: unknown;
  try {
    list = JSON.parse(out.slice(start, end + 1));
  } catch {
    throw new Error(`zingo-cli addresses returned unreadable output: ${out.trim().slice(0, 300)}`);
  }
  if (!Array.isArray(list)) throw new Error("zingo-cli addresses did not return a list");
  const entries = list
    .filter((e): e is { account?: number; address_index?: number; encoded_address: string } =>
      typeof e?.encoded_address === "string" && e.encoded_address.length > 0
    )
    .filter((e) => (e.account ?? 0) === 0)
    .sort((a, b) => (b.address_index ?? 0) - (a.address_index ?? 0));
  if (entries.length === 0) throw new Error("zingo-cli addresses returned no unified address");
  return entries[0].encoded_address;
}

/**
 * Parse `zingo-cli transactions`. It prints one `{ ... }` block per transaction with
 * top-level fields indented by four spaces (txid, datetime, status, blockheight, kind,
 * value, fee) and nested note lists indented deeper, which are ignored here.
 * Returns newest first: pending entries without a height, then by height descending.
 */
export function parseTransactions(out: string): TxSummary[] {
  const txs: TxSummary[] = [];
  for (const block of out.matchAll(/^\{\s*$([\s\S]*?)^\}\s*$/gm)) {
    const fields = new Map<string, string>();
    for (const line of block[1].matchAll(/^ {4}([a-z][a-z _]*?):[ \t]*(.*?)\s*$/gm)) {
      if (!fields.has(line[1])) fields.set(line[1], line[2]);
    }
    const txid = fields.get("txid");
    if (!txid || !/^[0-9a-f]{64}$/i.test(txid)) continue;
    const value = fields.get("value");
    if (!value || !/^[\d_]+$/.test(value)) continue;
    const height = fields.get("blockheight");
    const fee = fields.get("fee") ?? fields.get("transaction fee");
    txs.push({
      txid: txid.toLowerCase(),
      time: toIso(fields.get("datetime")),
      status: fields.get("status") || "unknown",
      blockHeight: height && /^\d+$/.test(height) ? Number(height) : undefined,
      kind: fields.get("kind") || "unknown",
      valueZats: BigInt(value.replace(/_/g, "")),
      feeZats: fee && /^[\d_]+$/.test(fee) ? BigInt(fee.replace(/_/g, "")) : undefined,
    });
  }
  return txs.sort((a, b) => (b.blockHeight ?? Infinity) - (a.blockHeight ?? Infinity) || 0);
}

/** "2026-10-12 14:23:01 UTC" becomes "2026-10-12T14:23:01.000Z". */
function toIso(dt: string | undefined): string | undefined {
  if (!dt) return undefined;
  const m = dt.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s*UTC$/);
  if (!m) return dt;
  const d = new Date(`${m[1]}T${m[2]}Z`);
  return Number.isNaN(d.getTime()) ? dt : d.toISOString();
}
