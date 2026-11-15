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
  const config = tempConfig({ totalSpendingCapZec: "0.0022" }), chain = new MockChainAdapter();
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
  const config = tempConfig({ totalSpendingCapZec: "0.0011" }), chain = new MockChainAdapter();
  const results = await Promise.all(["a", "b"].map(idempotency_key => executePay({ recipient: ALLOWED, amount_zec: "0.001", idempotency_key }, { config, chain })));
  assert.equal(results.filter(r => r.ok).length, 1);
  assert.equal(results.filter(r => r.code === "SPENDING_BUDGET_REFUSED").length, 1);
});

it("a crash while publishing the charged authorization leaves neither the charge nor the authorization", async () => {
  const { authorizeCharged, spentZats } = await import("../src/payments/budget.ts");
  const { acquireWalletLock } = await import("../src/payments/lock.ts");
  const { mock } = await import("node:test");
  const config = tempConfig({ totalSpendingCapZec: "0.0011" }), store = storeFor(config, new MockChainAdapter());
  const lock = await acquireWalletLock(store, 1000, "budget-test");
  const intent = (call_id: string, idempotency_key: string, params_sha256: string) => store.writeIntent({ call_id, ts: new Date().toISOString(), amount_zec: "0.001", amount_zats: "100000",
    recipient: ALLOWED, allowlist_hit: true, cap_zec: "0.1", view_key_fingerprint: null, idempotency_key, params_sha256 });
  try {
    intent("call", "key", "a".repeat(64));
    // Creating the empty ledger needs a store with no calls yet; this one already has one.
    fs.mkdirSync(join(store.dir, "spending-budget"), { mode: 0o700 });
    fs.writeFileSync(join(store.dir, "spending-budget/ledger.json"), JSON.stringify({ version: 2, total: "0" }), { mode: 0o600 });
    const record = () => store.readCall("call")!;
    const realLink = fs.linkSync;
    const hook = mock.method(fs, "linkSync", (from: fs.PathLike, to: fs.PathLike) => {
      if (String(to).includes(join("calls", "call"))) throw new Error("simulated crash before the authorization is published");
      return realLink(from, to);
    });
    try { assert.throws(() => authorizeCharged(config, store, lock, record(), 100000n, 10000n)); }
    finally { hook.mock.restore(); }
    assert.equal(spentZats(store), 0n);
    assert.equal(record().events.some(e => e.transmit_authorized), false);
    authorizeCharged(config, store, lock, record(), 100000n, 10000n);
    assert.equal(spentZats(store), 110000n);
    // The same payment identity is counted once, however many authorizations it has.
    authorizeCharged(config, store, lock, record(), 100000n, 10000n);
    assert.equal(spentZats(store), 110000n);
    assert.equal(authorizeCharged(config, store, lock, record(), 100000n, 10000n, true), false, "already counted and authorized: nothing written");
    // A higher fee for the same identity is counted only by the difference, and refused when it does not fit.
    assert.throws(() => authorizeCharged(config, store, lock, record(), 100000n, 20000n));
    assert.equal(spentZats(store), 110000n);
    intent("other", "key2", "b".repeat(64));
    assert.throws(() => authorizeCharged(config, store, lock, store.readCall("other")!, 100000n, 1n));
    assert.equal(spentZats(store), 110000n);
  } finally { await lock.release(); }
});

it("missing or corrupted spending state never resets allowance", async () => {
  const config = tempConfig({ totalSpendingCapZec: "0.0011" }), chain = new MockChainAdapter(), store = storeFor(config, chain);
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
  const env = { TOTAL_SPENDING_CAP_ZEC: "0.0011" };
  const results = await Promise.all([proc(w, "budget-a", ["pay", "key-a"], env).done, proc(w, "budget-b", ["pay", "key-b"], env).done]);
  assert.equal(results.filter(r => r.ok).length, 1);
  assert.equal(results.filter(r => r.code === "SPENDING_BUDGET_REFUSED").length, 1);
  assert.equal(sends(w).length, 1);
});

it("operator monitoring reports actionable conditions without payment secrets", async () => {
  const { operationalHealth }=await import('../src/operations/health.ts');
  const config=tempConfig({totalSpendingCapZec:"0.0011"}),chain=new MockChainAdapter(),store=storeFor(config,chain);
  await executePay({recipient:ALLOWED,amount_zec:"0.001",idempotency_key:"sensitive-key",memo:"sensitive-memo"},{config,chain});
  fs.writeFileSync(join(store.dir,'payments.pause'),'incident');
  const report=operationalHealth(config,store);
  assert.equal(report.ok,false);
  assert.ok(report.alerts.includes('PAYMENTS_PAUSED'));
  assert.ok(report.alerts.includes('SPENDING_ALLOWANCE_LOW'));
  assert.ok(report.alerts.includes('FINANCIAL_CONTROLS_MISSING'));
  assert.doesNotMatch(JSON.stringify(report),/sensitive-key|sensitive-memo|u1mockrecipient|test-salt/);
});

it("fees consume allowance before mock funds move", async () => {
  const config = tempConfig({ totalSpendingCapZec: "0.001" }), chain = new MockChainAdapter();
  const before = await chain.getBalance();
  const result = await executePay({ recipient: ALLOWED, amount_zec: "0.001", idempotency_key: "fee-over-cap" }, { config, chain });
  assert.equal(result.ok, false);
  assert.deepEqual(await chain.getBalance(), before);
});

it("legacy principal-only ledgers cannot silently undercount fees", async () => {
  const config = tempConfig({ totalSpendingCapZec: "1" }), chain = new MockChainAdapter(), store = storeFor(config, chain);
  fs.mkdirSync(join(store.dir, "spending-budget"), { mode: 0o700 });
  fs.writeFileSync(join(store.dir, "spending-budget/ledger.json"), JSON.stringify({ version: 1, total: "0" }), { mode: 0o600 });
  assert.equal((await executePay({ recipient: ALLOWED, amount_zec: "0.001", idempotency_key: "legacy" }, { config, chain })).code, "SPENDING_BUDGET_REFUSED");
});
