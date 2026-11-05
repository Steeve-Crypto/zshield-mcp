import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { MockChainAdapter } from "../src/chain/mock.ts";
import { executePay } from "../src/tools/pay.ts";
import { storeFor } from "../src/payments/store.ts";
import { assertPaymentsEnabled } from "../src/payments/pause.ts";
import { tempConfig, ALLOWED } from "./helpers.ts";

it("operator pause blocks new keys without disabling historical replay", async () => {
  const config = tempConfig(), chain = new MockChainAdapter(), store = storeFor(config, chain);
  const input = { recipient: ALLOWED, amount_zec: "0.001", idempotency_key: "original" };
  assert.equal((await executePay(input, { config, chain })).ok, true);
  fs.writeFileSync(join(store.dir, "payments.pause"), "incident");
  assert.equal((await executePay({ ...input, idempotency_key: "replacement" }, { config, chain })).code, "PAYMENTS_PAUSED");
  assert.equal((await executePay(input, { config, chain })).ok, true);
  fs.unlinkSync(join(store.dir, "payments.pause"));
  assert.equal((await executePay({ ...input, idempotency_key: "replacement" }, { config, chain })).ok, true);
});

it("unsafe pause markers fail closed", () => {
  const config = tempConfig(), store = storeFor(config, new MockChainAdapter());
  fs.symlinkSync(join(store.dir, "absent"), join(store.dir, "payments.pause"));
  assert.throws(() => assertPaymentsEnabled(store), /disabled/);
});

it("pause arriving during signing prevents transmit authorization", async () => {
  const config = tempConfig(), chain = new MockChainAdapter(), store = storeFor(config, chain);
  let transmitted = false;
  chain.pay = async (request) => {
    request.stage?.("aa".repeat(32));
    fs.writeFileSync(join(store.dir, "payments.pause"), "stop");
    request.beforeTransmit?.();
    transmitted = true;
    throw new Error("unreachable");
  };
  const result = await executePay({ recipient: ALLOWED, amount_zec: "0.001", idempotency_key: "paused-mid-stage" }, { config, chain });
  assert.equal(result.ok, false);
  assert.equal(transmitted, false);
  const record = store.readCall(JSON.parse(result.text).call_id)!;
  assert.equal(record.events.some(e => e.transmit_authorized), false);
});

it("cumulative allowance survives restart, new keys and configuration removal", async () => {
  const config = tempConfig({ totalSpendingCapZec: "0.002" }), chain = new MockChainAdapter();
  const pay = (key: string) => executePay({ recipient: ALLOWED, amount_zec: "0.001", idempotency_key: key }, { config, chain });
  assert.equal((await pay("one")).ok, true);
  assert.equal((await pay("one")).ok, true);
  assert.equal((await pay("two")).ok, true);
  assert.equal((await pay("three")).code, "SPENDING_BUDGET_REFUSED");
  const { resetPaymentStores } = await import("../src/payments/store.ts");
  resetPaymentStores();
  assert.equal((await pay("four")).code, "SPENDING_BUDGET_REFUSED");
  config.totalSpendingCapZec = undefined;
  assert.equal((await pay("five")).code, "SPENDING_BUDGET_REFUSED");
});

it("concurrent different keys share one cumulative allowance", async () => {
  const config = tempConfig({ totalSpendingCapZec: "0.001" }), chain = new MockChainAdapter();
  const results = await Promise.all(["a", "b"].map(idempotency_key => executePay({ recipient: ALLOWED, amount_zec: "0.001", idempotency_key }, { config, chain })));
  assert.equal(results.filter(r => r.ok).length, 1);
  assert.equal(results.filter(r => r.code === "SPENDING_BUDGET_REFUSED").length, 1);
});

it("a crashed reservation completes without charging twice", async () => {
  const { reserveSpending } = await import("../src/payments/budget.ts");
  const { acquireWalletLock } = await import("../src/payments/lock.ts");
  const { mock } = await import("node:test");
  const config = tempConfig({ totalSpendingCapZec: "0.001" }), store = storeFor(config, new MockChainAdapter());
  const lock = await acquireWalletLock(store, 1000, "budget-test");
  const realLink = fs.linkSync;
  const hook = mock.method(fs, "linkSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (String(to).includes("/receipts/")) throw new Error("simulated crash after durable total");
    return realLink(from, to);
  });
  try {
    assert.throws(() => reserveSpending(config, store, lock, "call", 100000n, "a".repeat(64), "key"));
    hook.mock.restore();
    reserveSpending(config, store, lock, "call", 100000n, "a".repeat(64), "key");
    const ledger = JSON.parse(fs.readFileSync(join(store.dir, "spending-budget/ledger.json"), "utf8"));
    assert.equal(ledger.total, "100000");
    assert.equal(ledger.pending, undefined);
    assert.throws(() => reserveSpending(config, store, lock, "different", 1n, "b".repeat(64), "key2"));
  } finally { hook.mock.restore(); await lock.release(); }
});

it("missing or corrupted spending state never resets allowance", async () => {
  const config = tempConfig({ totalSpendingCapZec: "0.001" }), chain = new MockChainAdapter(), store = storeFor(config, chain);
  const input = { recipient: ALLOWED, amount_zec: "0.001", idempotency_key: "first" };
  await executePay(input, { config, chain });
  const ledger = join(store.dir, "spending-budget/ledger.json");
  fs.unlinkSync(ledger);
  assert.equal((await executePay({ ...input, idempotency_key: "second" }, { config, chain })).code, "SPENDING_BUDGET_REFUSED");
  fs.writeFileSync(ledger, "{broken");
  assert.equal((await executePay({ ...input, idempotency_key: "third" }, { config, chain })).code, "SPENDING_BUDGET_REFUSED");
});

it("separate processes cannot exceed the shared allowance", async () => {
  const { world, proc, sends } = await import("./invariants/helpers.ts");
  const w = world();
  const env = { TOTAL_SPENDING_CAP_ZEC: "0.001" };
  const results = await Promise.all([proc(w, "budget-a", ["pay", "key-a"], env).done, proc(w, "budget-b", ["pay", "key-b"], env).done]);
  assert.equal(results.filter(r => r.ok).length, 1);
  assert.equal(results.filter(r => r.code === "SPENDING_BUDGET_REFUSED").length, 1);
  assert.equal(sends(w).length, 1);
});
