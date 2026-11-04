import { createHash } from "node:crypto";
import type { ChainAdapter } from "./types.js";
import type { PaymentReceipt, PaymentRequest } from "../types.js";
import { assertTestnetAddress, NetworkError } from "./network.js";

export const ZEXPLORER_TESTNET = "https://zexplorer.app/testnet/tx/";

/** Posts one GraphQL query and returns the data. Injectable for tests. */
export type GraphqlRunner = (url: string, query: string) => Promise<unknown>;

export const defaultGraphqlRunner: GraphqlRunner = async (url, query) => {
  const res = await fetch(`${url.replace(/\/$/, "")}/graphql`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const body = (await res.json()) as { data?: unknown; errors?: { message: string }[] };
  if (body.errors?.length) throw new Error(`zkool_graphql: ${body.errors.map((e) => e.message).join("; ")}`);
  return body.data;
};

export interface ZkoolOptions {
  network: string | undefined;
  url?: string;
  account?: number;
  runner?: GraphqlRunner;
}

/**
 * Testnet adapter backed by zkool_graphql (https://github.com/hhanh00/zkool2),
 * the wallet server with a release binary and no Rust build. Refuses to
 * construct unless network is exactly "testnet", and refuses a database that
 * reports a mainnet address.
 */
export class ZkoolChainAdapter implements ChainAdapter {
  readonly mode = "live" as const;
  readonly url: string;
  readonly account: number;
  private readonly runner: GraphqlRunner;

  constructor(opts: ZkoolOptions) {
    if (opts.network !== "testnet") {
      throw new NetworkError("zkool mode requires CHAIN_MODE=zkool with a testnet wallet. Mainnet is not supported.");
    }
    this.url = opts.url ?? "http://127.0.0.1:8000";
    this.account = opts.account ?? 1;
    this.runner = opts.runner ?? defaultGraphqlRunner;
  }

  /** The wallet's own address, checked to be testnet before any payment. */
  async ownAddress(): Promise<string> {
    const data = (await this.runner(this.url, `{ addressByAccount(idAccount: ${this.account}) { ua } }`)) as {
      addressByAccount?: { ua?: string };
    };
    const ua = data?.addressByAccount?.ua;
    if (!ua) throw new Error("zkool_graphql returned no address for the account");
    assertTestnetAddress(ua);
    return ua;
  }

  async pay(req: PaymentRequest): Promise<PaymentReceipt> {
    assertTestnetAddress(req.recipient);
    if (!Number.isFinite(req.amountZec) || req.amountZec <= 0) {
      throw new Error("Amount must be positive");
    }
    await this.ownAddress();
    await this.runner(this.url, `mutation { synchronize(idAccounts: [${this.account}], fast: false) }`);
    const memo = (req.memo ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
    const amount = req.amountZec.toFixed(8);
    const data = (await this.runner(
      this.url,
      `mutation { pay(idAccount: ${this.account}, payment: { recipients: [{ address: "${req.recipient}", amount: ${amount}, memo: "${memo}" }], confirmations: 1 }) }`
    )) as { pay?: string };
    const txid = parseTxid(data?.pay);
    const viewKeyMaterial = `vk_testnet_${createHash("sha256").update(`${txid}|${req.recipient}`).digest("hex").slice(0, 32)}`;
    return { txid, amountZec: req.amountZec, recipient: req.recipient, memo: req.memo, viewKeyMaterial, mode: "live" };
  }
}

export function parseTxid(value: unknown): string {
  if (typeof value === "string" && /^[0-9a-f]{64}$/i.test(value)) return value.toLowerCase();
  throw new Error(`zkool_graphql pay returned no txid: ${String(JSON.stringify(value) ?? "undefined").slice(0, 200)}`);
}
