import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import type { ChainAdapter } from "./types.js";
import type { PaymentReceipt, PaymentRequest } from "../types.js";
import { assertTestnetAddress, NetworkError } from "./network.js";

export const TESTNET_EXPLORER = "https://blockexplorer.one/zcash/testnet/tx/";

/** Runs a zingo-cli invocation and returns stdout. Injectable for tests. */
export type CliRunner = (bin: string, args: string[]) => Promise<string>;

export const defaultRunner: CliRunner = (bin, args) =>
  new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 16 * 1024 * 1024, timeout: 15 * 60_000 }, (err, stdout, stderr) => {
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

  async run(cmd: string[]): Promise<string> {
    return this.runner(this.bin, [...this.baseArgs(), ...cmd]);
  }

  async pay(req: PaymentRequest): Promise<PaymentReceipt> {
    assertTestnetAddress(req.recipient);
    if (typeof req.amountZats !== "bigint" || req.amountZats <= 0n) {
      throw new Error("Amount must be a positive integer number of zatoshis");
    }
    const args = ["quicksend", req.recipient, req.amountZats.toString()];
    if (req.memo) args.push(req.memo);
    const out = await this.run(args);
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
