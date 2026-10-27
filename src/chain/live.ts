import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import type { ChainAdapter } from "./types.js";
import type { PaymentReceipt, PaymentRequest, TxSummary, WalletBalance } from "../types.js";
import { assertTestnetAddress, NetworkError } from "./network.js";

export const TESTNET_EXPLORER = "https://blockexplorer.one/zcash/testnet/tx/";

export interface RunOptions {
  /** Kill the CLI after this many milliseconds. */
  timeoutMs?: number;
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
    execFile(bin, args, { maxBuffer: 16 * 1024 * 1024, timeout }, (err, stdout, stderr) => {
      if (err) reject(new Error(`zingo-cli failed: ${(stderr || err.message).toString().slice(0, 500)}`));
      else resolve(stdout.toString());
    });
  });

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

  constructor(opts: LiveOptions) {
    if (opts.network !== "testnet") {
      throw new NetworkError("Live mode requires CHAIN_MODE=testnet. Mainnet is not supported.");
    }
    this.bin = opts.zingoBin ?? "zingo-cli";
    this.dataDir = opts.dataDir ?? `${process.env.HOME}/.zshield-testnet/wallet`;
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

  async pay(req: PaymentRequest): Promise<PaymentReceipt> {
    assertTestnetAddress(req.recipient);
    if (typeof req.amountZats !== "bigint" || req.amountZats <= 0n) {
      throw new Error("Amount must be a positive integer number of zatoshis");
    }
    const args = ["quicksend", req.recipient, req.amountZats.toString()];
    if (req.memo) args.push(req.memo);
    const out = await this.run(args, { timeoutMs: SEND_TIMEOUT_MS });
    const txid = parseTxid(out);
    const viewKeyMaterial = `vk_testnet_${createHash("sha256").update(`${txid}|${req.recipient}`).digest("hex").slice(0, 32)}`;
    return {
      txid,
      amountZats: req.amountZats,
      recipient: req.recipient,
      memo: req.memo,
      viewKeyMaterial,
      mode: "live",
    };
  }
}

export function parseTxid(out: string): string {
  const m = out.match(/"txids"\s*:\s*\[\s*"([0-9a-f]{64})"/i);
  if (m) return m[1].toLowerCase();
  if (/error/i.test(out)) throw new Error(`zingo-cli send error: ${out.trim().slice(0, 500)}`);
  throw new Error("zingo-cli returned no txid");
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
