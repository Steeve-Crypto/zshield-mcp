import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MockChainAdapter } from "../src/chain/mock.ts";
import { resetPaymentStores as resetPaymentIndexes } from "../src/payments/store.ts";
import { executePay } from "../src/tools/pay.ts";
import type { PaymentReceipt, PaymentRequest } from "../src/types.ts";
import { ALLOWED, connect, readAuditRows, tempConfig, textOf } from "./helpers.ts";

/** Mock chain that counts sends. */
function countingChain() {
  const chain = new MockChainAdapter();
  const real = chain.pay.bind(chain);
  const sent: PaymentRequest[] = [];
  chain.pay = async (req: PaymentRequest): Promise<PaymentReceipt> => {
    sent.push(req);
    return real(req);
  };
  return { chain, sent };
}

beforeEach(() => resetPaymentIndexes());

describe("idempotency_key", () => {
  it("same key and parameters pays once and returns the first outcome", async () => {
    const config = tempConfig();
    const { chain, sent } = countingChain();
    const input = { amount_zec: "0.001", recipient: ALLOWED, memo: "inv 7", idempotency_key: "order-7" };
    const first = JSON.parse((await executePay(input, { config, chain })).text);
    const again = JSON.parse((await executePay({ ...input, amount_zec: 0.001 }, { config, chain })).text);
    assert.equal(sent.length, 1);
    assert.equal(first.ok, true);
    assert.equal(again.ok, true);
    assert.equal(again.idempotent_replay, true);
    assert.equal(again.txid, first.txid);
    assert.equal(again.call_id, first.call_id);
    const rows = readAuditRows(config);
    assert.deepEqual(rows.map((r) => r.status), ["pending", "ok", "replayed"]);
    assert.equal(rows[2].replay_of, first.call_id);
  });

  it("same key with different parameters is IDEMPOTENCY_CONFLICT and sends nothing", async () => {
    const config = tempConfig();
    const { chain, sent } = countingChain();
    await executePay({ amount_zec: "0.001", recipient: ALLOWED, idempotency_key: "k1" }, { config, chain });
    for (const other of [{ amount_zec: "0.002" }, { memo: "x" }]) {
      const r = await executePay({ amount_zec: "0.001", recipient: ALLOWED, idempotency_key: "k1", ...other }, { config, chain });
      assert.equal(r.code, "IDEMPOTENCY_CONFLICT");
      assert.equal(JSON.parse(r.text).status, "rejected");
    }
    assert.equal(sent.length, 1);
  });

  it("survives a restart: the key is rebuilt from the audit log", async () => {
    const config = tempConfig();
    const { chain, sent } = countingChain();
    const input = { amount_zec: "0.001", recipient: ALLOWED, idempotency_key: "restart-1" };
    const first = JSON.parse((await executePay(input, { config, chain })).text);
    resetPaymentIndexes();
    const again = JSON.parse((await executePay(input, { config, chain: countingChain().chain })).text);
    assert.equal(sent.length, 1);
    assert.equal(again.txid, first.txid);
    assert.equal(again.idempotent_replay, true);
  });

  it("a pending row with no result returns PAYMENT_PENDING and never sends again", async () => {
    const config = tempConfig();
    const input = { amount_zec: "0.001", recipient: ALLOWED, idempotency_key: "crash-1" };
    const { chain } = countingChain();
    // Simulate a process that stopped mid-send: the send never returns.
    chain.pay = () => new Promise(() => {});
    void executePay(input, { config, chain });
    await new Promise((r) => setTimeout(r, 20));
    resetPaymentIndexes();
    const fresh = countingChain();
    const r = await executePay(input, { config, chain: fresh.chain });
    assert.equal(r.code, "PAYMENT_PENDING");
    assert.equal(JSON.parse(r.text).status, "pending");
    assert.equal(fresh.sent.length, 0);
  });

  it("a concurrent call with the same key does not send twice", async () => {
    const config = tempConfig();
    const { chain, sent } = countingChain();
    const input = { amount_zec: "0.001", recipient: ALLOWED, idempotency_key: "race-1" };
    const results = await Promise.all([executePay(input, { config, chain }), executePay(input, { config, chain })]);
    assert.equal(sent.length, 1);
    const bodies = results.map((r) => JSON.parse(r.text));
    assert.equal(bodies.filter((b) => b.idempotent_replay).length, 1);
  });

  it("a key refused before the send is not bound, so it can be used again", async () => {
    const config = tempConfig();
    const { chain, sent } = countingChain();
    const r1 = await executePay({ amount_zec: "5", recipient: ALLOWED, idempotency_key: "fix-me" }, { config, chain });
    assert.equal(r1.code, "CAP_EXCEEDED");
    const r2 = await executePay({ amount_zec: "0.001", recipient: ALLOWED, idempotency_key: "fix-me" }, { config, chain });
    assert.equal(r2.ok, true);
    assert.equal(sent.length, 1);
  });

  it("the schema refuses a bad key with INVALID_IDEMPOTENCY_KEY", async () => {
    const { client } = await connect();
    for (const key of ["", "a".repeat(129), "has space", "semi;colon"]) {
      const res = await client.callTool({ name: "zcash_pay", arguments: { amount_zec: "0.001", recipient: ALLOWED, idempotency_key: key } });
      assert.equal(res.isError, true);
      assert.match(textOf(res), /INVALID_IDEMPOTENCY_KEY/);
    }
  });
});
