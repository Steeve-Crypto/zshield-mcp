import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { writeFileSync } from "node:fs";
import { LiveChainAdapter, parseLatestBlockHeight, parseWalletHeight, type CliRunner } from "../src/chain/live.ts";
import { CliTimeoutError } from "../src/chain/outcome.ts";
import { resetPaymentIndexes } from "../src/payments/index.ts";
import { executePay } from "../src/tools/pay.ts";
import { MockChainAdapter } from "../src/chain/mock.ts";
import { ALLOWED, readAuditRows, tempConfig, withUfvk, withEnv } from "./helpers.ts";

const UTEST = "utest1" + "q".repeat(100);
const TXID = "ab".repeat(32);

function liveConfig() {
  const config = tempConfig({ chainMode: "live", chainNetwork: "testnet", spendingCapZec: "0.01" });
  writeFileSync(config.allowlistPath, JSON.stringify({ recipients: [{ address: UTEST }] }));
  return config;
}

/** Live adapter with the given health answers; records whether a send was attempted. */
function chain(health: Parameters<typeof withUfvk>[1] = {}, info?: CliRunner) {
  const seen = { sends: 0 };
  const runner: CliRunner = async (_bin, _args, opts) => {
    if (opts?.input !== undefined) {
      seen.sends++;
      return JSON.stringify({ txids: [TXID] });
    }
    throw new Error("not in this test");
  };
  const wrapped = withUfvk(runner, health);
  const final: CliRunner = info ? async (b, a, o) => (a.at(-1) === "info" ? info(b, a, o) : wrapped(b, a, o)) : wrapped;
  return { seen, chain: new LiveChainAdapter({ network: "testnet", runner: final }) };
}

const pay = (c: LiveChainAdapter, config = liveConfig()) =>
  executePay({ amount_zec: "0.001", recipient: UTEST }, { config, chain: c }).then((r) => ({ r, config }));

beforeEach(() => resetPaymentIndexes());

describe("pre-send health check", () => {
  it("sends when the wallet is near the tip and funded", async () => {
    const { chain: c, seen } = chain();
    const { r } = await pay(c);
    assert.equal(r.ok, true);
    assert.equal(seen.sends, 1);
  });

  it("WALLET_NOT_SYNCED when the wallet is too far behind", async () => {
    const { chain: c, seen } = chain({ height: '{ "height": 900 }' });
    const { r, config } = await pay(c);
    assert.equal(r.code, "WALLET_NOT_SYNCED");
    assert.match(JSON.parse(r.text).message, /100 blocks behind/);
    assert.equal(seen.sends, 0);
    // Nothing sent, so no pending row.
    assert.deepEqual(readAuditRows(config).map((x) => x.status), ["error"]);
  });

  it("allows a lag up to HEALTH_MAX_LAG_BLOCKS", async () => {
    const { chain: c } = chain({ height: '{ "height": 995 }' });
    const config = { ...liveConfig(), healthMaxLagBlocks: 5 };
    assert.equal((await pay(c, config)).r.ok, true);
  });

  it("INSUFFICIENT_FUNDS when spendable does not cover amount plus fee", async () => {
    // 0.001 ZEC is 100000 zats; with the 10000 fee it needs 110000.
    const { chain: c, seen } = chain({ spendable_balance: '{ "spendable_balance": 109999 }' });
    const { r } = await pay(c);
    assert.equal(r.code, "INSUFFICIENT_FUNDS");
    assert.equal(seen.sends, 0);
    const ok = chain({ spendable_balance: '{ "spendable_balance": 110000 }' });
    assert.equal((await pay(ok.chain)).r.ok, true);
  });

  it("CHAIN_UNREACHABLE when the server does not answer in time", async () => {
    const { chain: c, seen } = chain({}, async () => {
      throw new CliTimeoutError("stopped after 30000 ms");
    });
    const { r } = await pay(c);
    assert.equal(r.code, "CHAIN_UNREACHABLE");
    assert.equal(seen.sends, 0);
  });

  it("runs info without --waitsync and the wallet reads offline, all with short timeouts", async () => {
    const calls: { args: string[]; timeoutMs?: number }[] = [];
    const runner: CliRunner = async (_b, args, opts) => {
      calls.push({ args, timeoutMs: opts?.timeoutMs });
      const last = args.at(-1);
      if (last === "info") return '{ "latest_block_height": 7 }';
      if (last === "height") return '{ "height": 7 }';
      return '{ "spendable_balance": 5 }';
    };
    await withEnv("ZINGO_WAITSYNC", "1", async () => {
      await withEnv("ZINGO_HEALTH_TIMEOUT_MS", "4000", async () => {
        const c = new LiveChainAdapter({ network: "testnet", runner, dataDir: "/w" });
        assert.deepEqual(await c.checkHealth(), { walletHeight: 7, chainTip: 7, spendableZats: 5n });
      });
    });
    assert.equal(calls.length, 3);
    assert.ok(calls.every((c) => !c.args.includes("--waitsync") && c.timeoutMs === 4000));
    assert.ok(calls.slice(1).every((c) => c.args.includes("--offline") && !c.args.includes("--server")));
  });

  it("parses real zingo-cli info and height output", () => {
    const info = `Launching sync task...\nLaunching save task...\n{\n  "version": "v0.5.4",\n  "chain_name": "test",\n  "latest_block_height": 4547427\n}\nSave task shutdown successfully.`;
    assert.equal(parseLatestBlockHeight(info), 4547427);
    assert.equal(parseWalletHeight(`Launching save task...\n{\n  "height": 4547426\n}\n`), 4547426);
    assert.throws(() => parseLatestBlockHeight("error"), /latest_block_height/);
  });

  it("mock mode skips the check", async () => {
    const r = await executePay({ amount_zec: "0.001", recipient: ALLOWED }, { config: tempConfig(), chain: new MockChainAdapter() });
    assert.equal(r.ok, true);
  });
});
