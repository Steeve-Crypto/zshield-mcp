import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ZkoolChainAdapter, parseTxid, type GraphqlRunner } from "../src/chain/zkool.ts";

const UTEST = "utest1" + "q".repeat(100);
const U1 = "u1" + "q".repeat(100);
const TXID = "cd".repeat(32);

function runner(ownAddress: string, calls: string[]): GraphqlRunner {
  return async (_url, query) => {
    calls.push(query);
    if (query.includes("addressByAccount")) return { addressByAccount: { ua: ownAddress } };
    if (query.includes("synchronize")) return { synchronize: 4581000 };
    if (query.includes("pay(")) return { pay: TXID };
    throw new Error(`unexpected query ${query}`);
  };
}

describe("ZkoolChainAdapter", () => {
  it("refuses to construct without testnet", () => {
    assert.throws(() => new ZkoolChainAdapter({ network: undefined }), /testnet/);
    assert.throws(() => new ZkoolChainAdapter({ network: "mainnet" }), /testnet/);
  });

  it("syncs, pays, and returns the txid", async () => {
    const calls: string[] = [];
    const chain = new ZkoolChainAdapter({ network: "testnet", url: "http://127.0.0.1:8010", account: 2, runner: runner(UTEST, calls) });
    const receipt = await chain.pay({ amountZec: 0.01, recipient: UTEST, memo: 'order "42"' });
    assert.equal(receipt.txid, TXID);
    assert.equal(receipt.mode, "live");
    assert.ok(calls.some((q) => q.includes("synchronize(idAccounts: [2]")));
    const pay = calls.find((q) => q.includes("pay("))!;
    assert.ok(pay.includes("amount: 0.01000000"), pay);
    assert.ok(pay.includes('memo: "order \\"42\\""'), pay);
  });

  it("rejects a mainnet recipient before touching the wallet", async () => {
    const calls: string[] = [];
    const chain = new ZkoolChainAdapter({ network: "testnet", runner: runner(UTEST, calls) });
    await assert.rejects(() => chain.pay({ amountZec: 0.01, recipient: U1 }), /Mainnet/);
    assert.equal(calls.length, 0);
  });

  it("rejects a wallet whose own address is mainnet", async () => {
    const calls: string[] = [];
    const chain = new ZkoolChainAdapter({ network: "testnet", runner: runner(U1, calls) });
    await assert.rejects(() => chain.pay({ amountZec: 0.01, recipient: UTEST }), /Mainnet/);
    assert.ok(!calls.some((q) => q.includes("pay(")));
  });

  it("parses txids strictly", () => {
    assert.equal(parseTxid(TXID.toUpperCase()), TXID);
    assert.throws(() => parseTxid("nope"), /no txid/);
    assert.throws(() => parseTxid(undefined), /no txid/);
  });
});
