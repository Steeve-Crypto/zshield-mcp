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
