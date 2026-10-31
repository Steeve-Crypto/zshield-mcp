import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockChainAdapter, MOCK_FEE_ZATS, MOCK_START_ZATS } from "../src/chain/mock.ts";
import { LiveChainAdapter, parseBalance, parseSpendable, type CliRunner } from "../src/chain/live.ts";
import { executeBalance } from "../src/tools/balance.ts";
import { executePay } from "../src/tools/pay.ts";
import { ALLOWED, readAuditRows, tempConfig, withEnv } from "./helpers.ts";

// Captured from zingo-cli on testnet (offline read of the demo wallet).
const BALANCE_OUT = `Launching save task...
[
    confirmed_ironwood_balance: 0
    unconfirmed_ironwood_balance: 12_390_000
    total_ironwood_balance: 12_390_000

    confirmed_orchard_balance: 1_000
    unconfirmed_orchard_balance: 0
    total_orchard_balance: 1_000

    confirmed_sapling_balance: 2_000
    unconfirmed_sapling_balance: 0
    total_sapling_balance: 2_000

    confirmed_transparent_balance: 0
    unconfirmed_transparent_balance: 5
    total_transparent_balance: 5
]
Save task shutdown successfully.`;
const SPENDABLE_OUT = `Launching save task...\n{\n  "spendable_balance": 3_000\n}\nSave task shutdown successfully.`;

function fakeRunner(calls: { args: string[]; timeoutMs?: number }[]): CliRunner {
  return async (_bin, args, opts) => {
    calls.push({ args, timeoutMs: opts?.timeoutMs });
    const cmd = args[args.length - 1];
    if (cmd === "balance") return BALANCE_OUT;
    if (cmd === "spendable_balance") return SPENDABLE_OUT;
    throw new Error(`unexpected command ${cmd}`);
  };
}

describe("zingo-cli balance parsing", () => {
  it("sums confirmed and unconfirmed across pools", () => {
    assert.deepEqual(parseBalance(BALANCE_OUT), { confirmedZats: 3_000n, unconfirmedZats: 12_390_005n });
  });
  it("parses spendable_balance JSON", () => {
    assert.equal(parseSpendable(SPENDABLE_OUT), 3_000n);
    assert.equal(parseSpendable('{"spendable_balance": 0}'), 0n);
  });
  it("throws on output with no balance", () => {
    assert.throws(() => parseBalance("Error: wallet locked"), /no balance lines/);
    assert.throws(() => parseSpendable("Error"), /no value/);
  });
});

describe("LiveChainAdapter.getBalance", () => {
  it("runs only read commands on testnet with a read timeout", async () => {
    const calls: { args: string[]; timeoutMs?: number }[] = [];
    const a = new LiveChainAdapter({ network: "testnet", runner: fakeRunner(calls) });
    // The default only applies when ZINGO_READ_TIMEOUT_MS is not set in the shell running the tests.
    const b = await withEnv("ZINGO_READ_TIMEOUT_MS", undefined, () => a.getBalance());
    assert.deepEqual(b, { confirmedZats: 3_000n, unconfirmedZats: 12_390_005n, spendableZats: 3_000n });
    assert.deepEqual(calls.map((c) => c.args.at(-1)), ["balance", "spendable_balance"]);
    for (const c of calls) {
      assert.deepEqual(c.args.slice(0, 2), ["--chain", "testnet"]);
      assert.ok(!c.args.includes("quicksend") && !c.args.includes("send"));
      assert.equal(c.timeoutMs, 120_000);
    }
  });
  it("honors ZINGO_READ_TIMEOUT_MS", async () => {
    const calls: { args: string[]; timeoutMs?: number }[] = [];
    const a = new LiveChainAdapter({ network: "testnet", runner: fakeRunner(calls) });
    await withEnv("ZINGO_READ_TIMEOUT_MS", "5000", () => a.getBalance());
    assert.equal(calls[0].timeoutMs, 5000);
  });
});

describe("executeBalance", () => {
  it("returns zatoshis and ZEC strings in mock mode and audits the call", async () => {
    const config = tempConfig();
    const r = await executeBalance({ config, chain: new MockChainAdapter() });
    assert.equal(r.ok, true);
    const body = JSON.parse(r.text);
    assert.equal(body.confirmed_zats, MOCK_START_ZATS.toString());
    assert.equal(body.confirmed_zec, "10");
    assert.equal(body.spendable_zats, MOCK_START_ZATS.toString());
    assert.equal(body.spendable_zec, "10");
    assert.equal(body.mode, "mock");
    const rows = readAuditRows(config);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].tool, "zcash_balance");
    assert.equal(rows[0].status, "ok");
    assert.ok(!JSON.stringify(rows[0]).includes(MOCK_START_ZATS.toString()), "balance is not logged");
  });

  it("drops by amount plus fee after a mock payment", async () => {
    const config = tempConfig();
    const chain = new MockChainAdapter();
    const pay = await executePay({ amount_zec: "0.05", recipient: ALLOWED }, { config, chain });
    assert.equal(pay.ok, true);
    const body = JSON.parse((await executeBalance({ config, chain })).text);
    assert.equal(BigInt(body.spendable_zats), MOCK_START_ZATS - 5_000_000n - MOCK_FEE_ZATS);
    assert.equal(body.spendable_zec, "9.9499");
  });

  it("works through the live adapter on testnet", async () => {
    const config = tempConfig({ chainMode: "live", chainNetwork: "testnet" });
    const chain = new LiveChainAdapter({ network: "testnet", runner: fakeRunner([]) });
    const body = JSON.parse((await executeBalance({ config, chain })).text);
    assert.equal(body.confirmed_zats, "3000");
    assert.equal(body.confirmed_zec, "0.00003");
    assert.equal(body.unconfirmed_zec, "0.12390005");
    assert.equal(body.mode, "live");
  });

  it("returns an error and still audits when the CLI fails", async () => {
    const config = tempConfig({ chainMode: "live", chainNetwork: "testnet" });
    const chain = new LiveChainAdapter({
      network: "testnet",
      runner: async () => {
        throw new Error("zingo-cli failed: connection refused");
      },
    });
    const r = await executeBalance({ config, chain });
    assert.equal(r.ok, false);
    assert.match(JSON.parse(r.text).error, /connection refused/);
    const rows = readAuditRows(config);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "error");
  });

  it("still answers with a warning when the audit row cannot be written", async () => {
    const root = mkdtempSync(join(tmpdir(), "zshield-noaudit-"));
    writeFileSync(join(root, "file"), "x");
    const config = tempConfig({ auditDir: join(root, "file", "audits") });
    const r = await executeBalance({ config, chain: new MockChainAdapter() });
    assert.equal(r.ok, true);
    assert.match(r.auditWarning ?? "", /could not be written/);
  });
});

describe("mock wallet funds", () => {
  it("refuses a send larger than the balance", async () => {
    const config = tempConfig({ spendingCapZec: "1" });
    const chain = new MockChainAdapter({ startingBalanceZats: 1_000_000n });
    const r = await executePay({ amount_zec: "0.01", recipient: ALLOWED }, { config, chain });
    assert.equal(r.ok, false);
    assert.equal(r.audit.status, "error");
    assert.match(r.audit.error ?? "", /Insufficient funds/);
    const body = JSON.parse((await executeBalance({ config, chain })).text);
    assert.equal(body.spendable_zats, "1000000");
  });
});
