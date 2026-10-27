import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiveChainAdapter, parseTxid, type CliRunner } from "../src/chain/live.ts";
import { addressNetwork, assertTestnetAddress } from "../src/chain/network.ts";
import { executePay } from "../src/tools/pay.ts";
import type { Config } from "../src/types.ts";
import { withUfvk } from "./helpers.ts";

const UTEST = "utest1" + "q".repeat(100);
const ZTEST = "ztestsapling1" + "q".repeat(70);
const TM = "tmBsTi2xWTjUdEXnuTceL7fecEQKeWaPDJd";
const TXID = "ab".repeat(32);

const okRunner = (calls: string[][]): CliRunner =>
  withUfvk(async (_bin, args, opts) => {
    // Stdin, when used, is recorded as a final pseudo-argument so tests can inspect it.
    calls.push(opts?.input === undefined ? args : [...args, opts.input]);
    return JSON.stringify({ txids: [TXID] });
  });

describe("address network checks", () => {
  it("accepts testnet prefixes", () => {
    for (const a of [UTEST, ZTEST, TM]) {
      assert.equal(addressNetwork(a), "testnet");
      assert.doesNotThrow(() => assertTestnetAddress(a));
    }
  });
  it("rejects mainnet prefixes", () => {
    for (const a of ["u1abc", "zs1abc", "t1abc"]) {
      assert.equal(addressNetwork(a), "mainnet");
      assert.throws(() => assertTestnetAddress(a), /Mainnet/);
    }
  });
  it("rejects unknown prefixes", () => {
    assert.throws(() => assertTestnetAddress("bc1xyz"), /Unrecognized/);
  });
});

describe("LiveChainAdapter", () => {
  it("refuses to construct without testnet", () => {
    assert.throws(() => new LiveChainAdapter({ network: undefined }), /testnet/);
    assert.throws(() => new LiveChainAdapter({ network: "mainnet" }), /testnet/);
  });
  it("sends via zingo-cli on testnet and parses txid", async () => {
    const calls: string[][] = [];
    const a = new LiveChainAdapter({ network: "testnet", runner: okRunner(calls) });
    const r = await a.pay({ amountZats: 100_000n, recipient: UTEST, memo: "hi" });
    assert.equal(r.txid, TXID);
    const args = calls[0];
    assert.deepEqual(args.slice(0, 2), ["--chain", "testnet"]);
    assert.ok(!args.slice(0, -1).includes("hi") && !args.slice(0, -1).includes(UTEST), "payment details stay out of argv");
    assert.match(args.at(-1) ?? "", /"memo":"hi"/);
  });
  it("never calls the CLI for a mainnet recipient", async () => {
    const calls: string[][] = [];
    const a = new LiveChainAdapter({ network: "testnet", runner: okRunner(calls) });
    await assert.rejects(a.pay({ amountZats: 100_000n, recipient: "u1abc" }), /Mainnet/);
    assert.equal(calls.length, 0);
  });
  it("surfaces CLI failures", async () => {
    const a = new LiveChainAdapter({
      network: "testnet",
      runner: async () => { throw new Error("zingo-cli failed: insufficient funds"); },
    });
    await assert.rejects(a.pay({ amountZats: 100_000n, recipient: UTEST }), /insufficient/);
  });
  it("rejects non-positive zatoshi amounts before calling the CLI", async () => {
    const calls: string[][] = [];
    const a = new LiveChainAdapter({ network: "testnet", runner: okRunner(calls) });
    await assert.rejects(a.pay({ amountZats: 0n, recipient: UTEST }), /positive integer/);
    await assert.rejects(a.pay({ amountZats: -1n, recipient: UTEST }), /positive integer/);
    assert.equal(calls.length, 0);
  });
  it("parseTxid errors on missing or error output", () => {
    assert.throws(() => parseTxid("Error: proposal failed"), /send error/);
    assert.throws(() => parseTxid("{}"), /without a txid/);
  });
});

describe("policy runs before chain in live mode", () => {
  function cfg(): Config {
    const root = mkdtempSync(join(tmpdir(), "zshield-live-"));
    const allow = join(root, "allow.json");
    writeFileSync(allow, JSON.stringify({ recipients: [{ address: UTEST }, { address: "u1mainnetlisted" }] }));
    return { spendingCapZec: 0.01, allowlistPath: allow, chainMode: "live", auditDir: join(root, "a"), viewKeyFingerprintSalt: "s", chainNetwork: "testnet" };
  }
  it("cap and allow-list block before any CLI call", async () => {
    const calls: string[][] = [];
    const chain = new LiveChainAdapter({ network: "testnet", runner: okRunner(calls) });
    const c = cfg();
    const over = await executePay({ amount_zec: 1, recipient: UTEST }, { config: c, chain });
    assert.equal(over.audit.status, "rejected");
    const notListed = await executePay({ amount_zec: 0.001, recipient: ZTEST }, { config: c, chain });
    assert.equal(notListed.audit.status, "rejected");
    const mainnet = await executePay({ amount_zec: 0.001, recipient: "u1mainnetlisted" }, { config: c, chain });
    assert.equal(mainnet.audit.status, "rejected");
    assert.equal(mainnet.audit.code, "MAINNET_REFUSED");
    assert.equal(calls.length, 0);
    const ok = await executePay({ amount_zec: 0.001, recipient: UTEST }, { config: c, chain });
    assert.equal(ok.audit.status, "ok");
    assert.equal(ok.audit.mock_txid, TXID);
  });
  it("passes exact zatoshis to zingo-cli without rounding", async () => {
    const calls: string[][] = [];
    const chain = new LiveChainAdapter({ network: "testnet", runner: okRunner(calls) });
    const r = await executePay({ amount_zec: "0.00012345", recipient: UTEST }, { config: cfg(), chain });
    assert.equal(r.audit.status, "ok");
    assert.equal(r.audit.amount_zats, "12345");
    assert.ok(calls[0].at(-1)?.startsWith(`quicksend '[{"address":"${UTEST}","amount":12345}]'`));
  });
  it("rejects sub-zatoshi amounts before any CLI call", async () => {
    const calls: string[][] = [];
    const chain = new LiveChainAdapter({ network: "testnet", runner: okRunner(calls) });
    const r = await executePay({ amount_zec: "0.000000015", recipient: UTEST }, { config: cfg(), chain });
    assert.equal(r.audit.status, "rejected");
    assert.match(r.audit.error ?? "", /more than 8 decimal places/);
    assert.equal(calls.length, 0);
  });
});
