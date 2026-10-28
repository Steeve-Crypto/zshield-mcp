import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MockChainAdapter, MOCK_FEE_ZATS } from "../src/chain/mock.ts";
import { LiveChainAdapter, parseTransactions, type CliRunner } from "../src/chain/live.ts";
import { checkLimit, executeHistory, HISTORY_MAX_LIMIT } from "../src/tools/history.ts";
import { executePay } from "../src/tools/pay.ts";
import { ALLOWED, readAuditRows, tempConfig } from "./helpers.ts";

const RX = "c0f2f121316f6429929491e259144d1b31689364732c387ca9a2f0c76268ad06";
const TX = "59d9cb1b5a473a84602c4812a7809217f6e9d359174deb178e7fd52c151ae8fc";
const PENDING = "aa".repeat(32);

// Trimmed from real zingo-cli `transactions` output on testnet.
const TRANSACTIONS_OUT = `Launching save task...

{
    txid: ${RX}
    datetime: 2026-10-12 14:23:01 UTC
    status: confirmed
    blockheight: 4492422
    kind: received
    value: 12500000
    fee: 10000
    zec price: not available
    pools sent from: 
    ironwood notes: 
\t{
            value: 12500000
            spend status: transmitted spent in ${TX}
            output index: 1
            memo: 
        }
    orchard notes: 
}
{
    txid: ${TX}
    datetime: 2026-10-13 00:51:59 UTC
    status: transmitted
    blockheight: 4493939
    kind: sent
    value: 100000
    fee: 10000
    zec price: not available
    pools sent from: Ironwood
    outgoing ironwood notes: 
\t{
            value: 100000
            memo: zshield-mcp testnet demo
            recipient: utest1tkzp6v69
            output index: 0
        }
}
{
    txid: ${PENDING}
    datetime: 2026-10-14 09:00:00 UTC
    status: mempool
    blockheight: 
    kind: sent
    value: 1_000
    fee: 10_000
}
Save task shutdown successfully.
Zingo CLI quit successfully.`;

const runnerFor = (out: string, calls: string[][] = []): CliRunner => async (_b, args) => {
  calls.push(args);
  return out;
};

describe("zingo-cli transactions parsing", () => {
  it("reads top-level fields and ignores nested notes", () => {
    const txs = parseTransactions(TRANSACTIONS_OUT);
    assert.equal(txs.length, 3);
    assert.deepEqual(txs.map((t) => t.txid), [PENDING, TX, RX]);
    const sent = txs[1];
    assert.equal(sent.kind, "sent");
    assert.equal(sent.status, "transmitted");
    // A transmitted tx has a target height from zingo-cli, not a mined height.
    assert.equal(sent.blockHeight, undefined);
    assert.equal(sent.targetHeight, 4493939);
    assert.equal(sent.valueZats, 100_000n);
    assert.equal(sent.feeZats, 10_000n);
    assert.equal(sent.time, "2026-10-13T00:51:59.000Z");
    assert.equal(txs[0].blockHeight, undefined);
    assert.equal(txs[0].valueZats, 1_000n);
  });
  it("reports the mined height only for confirmed transactions", () => {
    // The same send after a full sync: it was mined at 4493943.
    const out = `{
    txid: ${TX}
    datetime: 2026-10-13 00:52:06 UTC
    status: confirmed
    blockheight: 4493943
    kind: sent
    value: 100000
    fee: 10000
}
{
    txid: ${"bb".repeat(32)}
    datetime: 2026-10-15 10:00:00 UTC
    status: failed
    blockheight: 4495000
    kind: sent
    value: 2000
    fee: 10000
}`;
    const [failed, mined] = parseTransactions(out);
    assert.equal(mined.status, "confirmed");
    assert.equal(mined.blockHeight, 4493943);
    assert.equal(mined.targetHeight, undefined);
    assert.equal(failed.status, "failed");
    assert.equal(failed.blockHeight, undefined);
    assert.equal(failed.targetHeight, 4495000);
  });
  it("puts unconfirmed entries first, newest first, then confirmed by height", () => {
    const block = (txid: string, status: string, height: number, dt: string) =>
      `{\n    txid: ${txid}\n    datetime: ${dt}\n    status: ${status}\n    blockheight: ${height}\n    kind: sent\n    value: 1\n}`;
    const out = [
      block("1".repeat(64), "confirmed", 100, "2026-10-01 00:00:00 UTC"),
      block("2".repeat(64), "transmitted", 150, "2026-10-02 00:00:00 UTC"),
      block("3".repeat(64), "confirmed", 120, "2026-10-01 01:00:00 UTC"),
      block("4".repeat(64), "mempool", 160, "2026-10-03 00:00:00 UTC"),
    ].join("\n");
    assert.deepEqual(
      parseTransactions(out).map((t) => t.txid[0]),
      ["4", "2", "3", "1"]
    );
  });
  it("returns an empty list when there are no transactions", () => {
    assert.deepEqual(parseTransactions("Launching save task...\nSave task shutdown successfully."), []);
  });
});

describe("history limit", () => {
  it("defaults to 10 and accepts 1 to the max", () => {
    assert.equal(checkLimit(undefined), 10);
    assert.equal(checkLimit(1), 1);
    assert.equal(checkLimit(HISTORY_MAX_LIMIT), HISTORY_MAX_LIMIT);
  });
  it("rejects zero, negatives, fractions, too large, and non-numbers", () => {
    for (const v of [0, -1, 2.5, HISTORY_MAX_LIMIT + 1, 1e9, NaN, Infinity, "5"]) {
      assert.throws(() => checkLimit(v), /limit must be a whole number/, String(v));
    }
  });
  it("does not repeat the bad value", () => {
    assert.throws(() => checkLimit("9".repeat(5000)), (e: Error) => !e.message.includes("999"));
  });
});

describe("LiveChainAdapter.getHistory", () => {
  it("runs only read commands and applies the limit", async () => {
    const calls: string[][] = [];
    const a = new LiveChainAdapter({ network: "testnet", runner: runnerFor(TRANSACTIONS_OUT, calls) });
    const txs = await a.getHistory(2);
    assert.deepEqual(txs.map((t) => t.txid), [PENDING, TX]);
    assert.deepEqual(calls[0].slice(0, 2), ["--chain", "testnet"]);
    assert.equal(calls.at(-1)?.at(-1), "transactions");
    // The machine-readable commands come first; this runner cannot answer them in JSON, so
    // nothing in the listing is vouched for.
    for (const c of calls) assert.ok(["notes", "all", "coins", "messages", "transactions"].includes(c.at(-1)!), c.join(" "));
    assert.ok(txs.every((t) => t.verified === false));
  });
});

describe("executeHistory", () => {
  it("lists mock payments newest first, with the funding receive last", async () => {
    const config = tempConfig();
    const chain = new MockChainAdapter();
    const p1 = await executePay({ amount_zec: "0.01", recipient: ALLOWED }, { config, chain });
    const p2 = await executePay({ amount_zec: "0.02", recipient: ALLOWED }, { config, chain });
    const r = await executeHistory({}, { config, chain });
    assert.equal(r.ok, true);
    const body = JSON.parse(r.text);
    assert.equal(body.count, 3);
    assert.deepEqual(
      body.transactions.map((t: { txid: string }) => t.txid),
      [p2.audit.mock_txid, p1.audit.mock_txid, body.transactions[2].txid]
    );
    assert.equal(body.transactions[0].value_zec, "0.02");
    assert.equal(body.transactions[0].fee_zats, MOCK_FEE_ZATS.toString());
    assert.equal(body.transactions[2].kind, "received");
    assert.equal(body.transactions[0].explorer_url, undefined);
  });

  it("applies the limit in mock mode", async () => {
    const config = tempConfig();
    const chain = new MockChainAdapter();
    await executePay({ amount_zec: "0.01", recipient: ALLOWED }, { config, chain });
    const body = JSON.parse((await executeHistory({ limit: 1 }, { config, chain })).text);
    assert.equal(body.count, 1);
    assert.equal(body.transactions[0].kind, "sent");
  });

  it("adds explorer links in live mode", async () => {
    const config = tempConfig({ chainMode: "live", chainNetwork: "testnet" });
    const chain = new LiveChainAdapter({ network: "testnet", runner: runnerFor(TRANSACTIONS_OUT) });
    const body = JSON.parse((await executeHistory({ limit: 5 }, { config, chain })).text);
    assert.equal(body.count, 3);
    assert.equal(body.transactions[1].explorer_url, `https://blockexplorer.one/zcash/testnet/tx/${TX}`);
    assert.equal(body.transactions[1].value_zec, "0.001");
    assert.equal(body.transactions[1].block_height, undefined);
    assert.equal(body.transactions[1].target_height, 4493939);
    assert.equal(body.transactions[2].block_height, 4492422);
    assert.equal(body.transactions[2].target_height, undefined);
  });

  it("rejects a bad limit, audits it, and never calls the CLI", async () => {
    const config = tempConfig({ chainMode: "live", chainNetwork: "testnet" });
    const calls: string[][] = [];
    const chain = new LiveChainAdapter({ network: "testnet", runner: runnerFor(TRANSACTIONS_OUT, calls) });
    const r = await executeHistory({ limit: 500 }, { config, chain });
    assert.equal(r.ok, false);
    assert.equal(JSON.parse(r.text).status, "rejected");
    assert.equal(calls.length, 0);
    const rows = readAuditRows(config);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].tool, "zcash_history");
    assert.equal(rows[0].status, "rejected");
    assert.equal(rows[0].limit, 500);
  });

  it("returns an error when the CLI fails", async () => {
    const config = tempConfig({ chainMode: "live", chainNetwork: "testnet" });
    const chain = new LiveChainAdapter({
      network: "testnet",
      runner: async () => {
        throw new Error("zingo-cli failed: timed out");
      },
    });
    const r = await executeHistory({}, { config, chain });
    assert.equal(r.ok, false);
    assert.equal(readAuditRows(config)[0].status, "error");
  });
});
