import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.ts";
import type { CliRunner } from "../src/chain/live.ts";
import type { ChainAdapter } from "../src/chain/types.ts";
import { appendAuditEntry } from "../src/audit/log.ts";
import { storeFor } from "../src/payments/store.ts";
import type { AuditEntry, Config } from "../src/types.ts";

export const ALLOWED = "u1mockrecipientaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

export function tempConfig(overrides: Partial<Config> = {}): Config {
  const root = mkdtempSync(join(tmpdir(), "zshield-test-"));
  const allowPath = join(root, "allow.json");
  writeFileSync(allowPath, JSON.stringify({ recipients: [{ address: ALLOWED, label: "Demo" }] }));
  return {
    spendingCapZec: 0.1,
    allowlistPath: allowPath,
    chainMode: "mock",
    auditDir: join(root, "audits"),
    viewKeyFingerprintSalt: "test-salt",
    ...overrides,
  };
}

/** Every audit row in the config's audit dir, oldest first. */
export function readAuditRows(config: Config): Record<string, unknown>[] {
  return readdirSync(config.auditDir)
    .sort()
    .flatMap((f) => readFileSync(join(config.auditDir, f), "utf8").trim().split("\n"))
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/** A connected in-memory MCP client for a fresh server. */
export async function connect(config: Config = tempConfig()) {
  const server = createServer(config);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientT);
  return { client, config };
}

export function textOf(res: unknown): string {
  const content = (res as { content: { type: string; text: string }[] }).content;
  return content[0].text;
}

/** A fake testnet UFVK for tests. Not a real key. */
export const TEST_UFVK = "uviewtest1" + "q".repeat(80);

/** Healthy answers for the pre-send check: wallet at the tip, plenty spendable. */
export const HEALTHY = { info: '{ "latest_block_height": 1000 }', height: '{ "height": 1000 }', spendable_balance: '{ "spendable_balance": 100000000 }' };

/**
 * Wraps a fake CLI runner so `export_ufvk` answers with TEST_UFVK and the pre-send check
 * (`info`, offline `height` and `spendable_balance`) answers HEALTHY. None of these reach
 * `runner`, so tests that count CLI calls only see sends and reads.
 */
export function withUfvk(runner: CliRunner, health: Partial<typeof HEALTHY> = {}, translate = true): CliRunner {
  const answers = { ...HEALTHY, ...health };
  return async (bin, args, opts) => {
    if (args.includes("export_ufvk")) return JSON.stringify({ ufvk: TEST_UFVK, birthday: 1 });
    const last = args.at(-1);
    const offline = args.includes("--offline");
    if (last === "info" || (offline && (last === "height" || last === "spendable_balance"))) {
      return answers[last as keyof typeof HEALTHY];
    }
    // A live send is two steps: `send` + `calculate`, then `transmit <txid>`. The inner
    // runner plays the old one-step `quicksend`: its answer is the built txid, and the
    // transmit step answers by itself.
    const input = translate ? opts?.input : undefined;
    if (input?.startsWith("send '")) {
      const line = input.split("\n")[0].replace(/^send /, "quicksend ");
      const out = await runner(bin, args, { ...opts, input: `${line}\nquit\n` });
      return /"txids"/.test(out) ? `{\n  "fee": 10000\n}\n${out}` : out;
    }
    const transmit = input?.match(/^transmit ([0-9a-f]{64})\n/);
    if (transmit) return JSON.stringify({ txids: [transmit[1]] });
    return runner(bin, args, opts);
  };
}

/** Read methods for fake chain adapters in pay tests. They fail if a test reaches them. */
export const unusedReads: Pick<ChainAdapter, "getBalance" | "getReceiveAddress" | "getHistory"> = {
  async getBalance() {
    throw new Error("getBalance not expected in this test");
  },
  async getReceiveAddress() {
    throw new Error("getReceiveAddress not expected in this test");
  },
  async getHistory() {
    throw new Error("getHistory not expected in this test");
  },
};

/**
 * Runs `fn` with an environment variable set to `value`, or removed when `value` is
 * undefined, then puts back whatever was there before. Keeps tests independent of the
 * shell they run in.
 */
export async function withEnv<T>(name: string, value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const had = Object.prototype.hasOwnProperty.call(process.env, name);
  const before = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return await fn();
  } finally {
    if (had) process.env[name] = before;
    else delete process.env[name];
  }
}

/**
 * Answers for the wallet's JSON commands (`notes all`, `coins all`, `messages`) in tests
 * that need a listing entry to be vouched for. `txs` gives each txid's status and height.
 * Returns undefined for any other command.
 */
export function walletJson(
  args: string[],
  txs: { txid: string; status?: string; height?: number; memos?: { recipient: string; memo: string; value?: number }[] }[]
): string | undefined {
  const last = args.at(-1);
  const prev = args.at(-2);
  if (prev === "notes" && last === "all") {
    return pretty({
      orchard_notes: {
        note_summaries: txs.map((t) => ({
          txid: t.txid,
          status: `${t.status ?? "confirmed"}${t.height !== undefined || (t.status ?? "confirmed") === "confirmed" ? ` at block height ${t.height ?? 999}` : ""}`,
          spend_status: "unspent",
          memo: null,
        })),
      },
    });
  }
  if (prev === "coins" && last === "all") return pretty({ transparent_coins: [] });
  if (last === "messages") {
    return pretty({
      value_transfers: txs.filter((t) => t.memos?.length).map((t) => ({ txid: t.txid, kind: "sent", value: t.memos![0].value, recipient_address: t.memos![0].recipient, memos: t.memos!.map((m) => m.memo) })),
    });
  }
  return undefined;
}

const pretty = (v: unknown) => JSON.stringify(v, null, 2) + "\n";

/**
 * Put a call in the payment store the way an interrupted or finished send leaves it, and
 * write its audit rows. The store, not the audit log, is what recovery and status read.
 */
export function seedCall(config: Config, pending: AuditEntry, chain: { stateDir?: string } = {}, result?: AuditEntry): void {
  appendAuditEntry(config.auditDir, pending);
  const store = storeFor(config, chain);
  const i = pending;
  store.writeIntent({
    call_id: i.call_id, ts: i.ts, amount_zec: i.amount_zec, amount_zats: i.amount_zats!, recipient: i.recipient, memo: i.memo,
    allowlist_hit: i.allowlist_hit, cap_zec: i.cap_zec, view_key_fingerprint: i.view_key_fingerprint, idempotency_key: i.idempotency_key,
    params_sha256: i.params_sha256, chain_tip: i.chain_tip, wallet_height: i.wallet_height,
  });
  if (i.idempotency_key && i.params_sha256) store.bindKey(i.idempotency_key, i.call_id, i.params_sha256);
  if (!result) return;
  appendAuditEntry(config.auditDir, result);
  const r = result;
  const base = { ts: r.ts, call_id: i.call_id, by: "send" as const };
  if (r.status === "ok") {
    store.advance({ ...base, state: "sent", txid: r.mock_txid });
    if (r.mock_txid) store.claimTxid(r.mock_txid, i.call_id);
  } else if (r.status === "unknown") store.advance({ ...base, state: "unknown", code: r.code, error: r.error, possible_sends: r.possible_sends });
  else store.advance({ ...base, state: "not_sent", code: r.code, error: r.error });
}
