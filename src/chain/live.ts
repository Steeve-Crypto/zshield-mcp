import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import type { ChainAdapter } from "./types.js";
import type { PaymentReceipt, PaymentRequest, WalletBalance } from "../types.js";
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
