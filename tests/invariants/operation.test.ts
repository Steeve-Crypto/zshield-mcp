// The operation ID: made by ZShield when a payment is authorized, never taken from the caller,
// stored with the payment, written on every audit row for it, and usable to look it up.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { describe, it } from "node:test";
import { createChain } from "../../src/server.ts";
import { executePay } from "../../src/tools/pay.ts";
import { paymentStatus } from "../../src/tools/status.ts";
import { resetPaymentStores, storeFor } from "../../src/payments/store.ts";
import { ALLOWED, connect, readAuditRows, tempConfig, textOf } from "../helpers.ts";
import { proc, world } from "./helpers.ts";

const OP = /^op_[0-9a-f]{32}$/;
const pay = (config: ReturnType<typeof tempConfig>, chain: ReturnType<typeof createChain>, extra: Record<string, unknown> = {}) =>
  executePay({ amount_zec: "0.001", recipient: ALLOWED, idempotency_key: `op-${crypto.randomUUID()}`, ...extra } as never, { config, chain });

describe("operation id", { timeout: 120_000 }, () => {
  it("zcash_pay returns an operation_id that ZShield made, and ignores one the caller supplies", async () => {
    const config = tempConfig();
    const chain = createChain(config);
    const supplied = "op_" + "a".repeat(32);
    const a = JSON.parse((await pay(config, chain, { operation_id: supplied })).text);
    const b = JSON.parse((await pay(config, chain)).text);
    assert.match(a.operation_id, OP);
    assert.match(b.operation_id, OP);
    assert.notEqual(a.operation_id, supplied);
    assert.notEqual(a.operation_id, b.operation_id);
  });

  it("through the MCP tool, a supplied operation_id is ignored too", async () => {
    const { client } = await connect();
    const r = await client.callTool({ name: "zcash_pay", arguments: { amount_zec: "0.001", recipient: ALLOWED, operation_id: "op_" + "b".repeat(32) } });
    const body = JSON.parse(textOf(r));
    assert.match(body.operation_id, OP);
    assert.notEqual(body.operation_id, "op_" + "b".repeat(32));
  });

  it("it is stored with the payment record and on every audit row for the payment", async () => {
    const config = tempConfig();
    const chain = createChain(config);
    const body = JSON.parse((await pay(config, chain)).text);
    assert.match(body.operation_id, /^op_[0-9a-f]{32}$/);
    const rec = storeFor(config, chain).readCall(body.call_id);
    assert.equal(rec?.intent?.operation_id, body.operation_id);
    const rows = readAuditRows(config).filter((r) => r.call_id === body.call_id);
    assert.ok(rows.length >= 2, "a pending row and a result row");
    for (const r of rows) assert.equal(r.operation_id, body.operation_id, `audit row ${r.status} lacks the operation id`);
  });

  it("zcash_payment_status looks a payment up by operation_id, across a restart", async () => {
    const config = tempConfig();
    const chain = createChain(config);
    const body = JSON.parse((await pay(config, chain)).text);
    resetPaymentStores();
    const s = await paymentStatus(config, createChain(config), { operation_id: body.operation_id } as never);
    assert.equal(s.call_id, body.call_id);
    assert.equal((s as { operation_id?: string }).operation_id, body.operation_id);
  });

  it("the MCP status tool takes operation_id and answers with it", async () => {
    const { client } = await connect();
    const paid = JSON.parse(textOf(await client.callTool({ name: "zcash_pay", arguments: { amount_zec: "0.001", recipient: ALLOWED } })));
    const r = await client.callTool({ name: "zcash_payment_status", arguments: { operation_id: paid.operation_id } });
    const body = JSON.parse(textOf(r));
    assert.equal(body.ok, true, textOf(r));
    assert.equal(body.call_id, paid.call_id);
    assert.equal(body.operation_id, paid.operation_id);
  });

  it("a replay of the same key returns the first payment's operation_id", async () => {
    const config = tempConfig();
    const chain = createChain(config);
    const input = { idempotency_key: "op-replay" };
    const first = JSON.parse((await pay(config, chain, input)).text);
    const again = JSON.parse((await pay(config, chain, input)).text);
    assert.equal(again.idempotent_replay, true);
    assert.match(first.operation_id, /^op_[0-9a-f]{32}$/);
    assert.equal(again.operation_id, first.operation_id);
  });

  it("a lookup with a malformed operation_id is refused before the store is touched", async () => {
    const config = tempConfig();
    const chain = createChain(config);
    const proto = Object.getPrototypeOf(crypto.createHash("sha256")) as { update: (...a: any[]) => any };
    let hashed = 0;
    const orig = proto.update;
    proto.update = function (this: unknown, data: unknown, ...rest: unknown[]) {
      hashed = Math.max(hashed, typeof data === "string" ? Buffer.byteLength(data) : (data as { length: number }).length);
      return orig.call(this, data, ...rest);
    };
    try {
      for (const bad of ["x".repeat(10 * 1024 * 1024), "op_", "op_" + "A".repeat(32), "op_" + "a".repeat(31), "op_" + "a".repeat(33), "../etc/passwd", "op_" + "a".repeat(30) + "/.", "OP_" + "a".repeat(32)]) {
        await assert.rejects(() => paymentStatus(config, chain, { operation_id: bad } as never), (e: any) => e.code === "INVALID_LOOKUP", `accepted ${bad.slice(0, 40)}`);
      }
      assert.ok(hashed <= 256, `a hash was fed ${hashed} bytes of caller input`);
    } finally {
      proto.update = orig;
    }
  });

  it("an unknown but well formed operation_id is PAYMENT_NOT_FOUND, and two lookup fields are refused", async () => {
    const config = tempConfig();
    const chain = createChain(config);
    await assert.rejects(() => paymentStatus(config, chain, { operation_id: "op_" + "0".repeat(32) } as never), (e: any) => e.code === "PAYMENT_NOT_FOUND");
    await assert.rejects(() => paymentStatus(config, chain, { operation_id: "op_" + "0".repeat(32), call_id: "x" } as never), (e: any) => e.code === "INVALID_LOOKUP");
  });

  it("a payment refused by policy gets no operation_id", async () => {
    const config = tempConfig();
    const chain = createChain(config);
    const body = JSON.parse((await pay(config, chain, { recipient: "u1notonthelistaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })).text);
    assert.equal(body.ok, false);
    assert.equal(body.operation_id, undefined);
  });

  it("another process finds a payment by its operation_id", async () => {
    const w = world();
    const paid = await proc(w, "payer", ["pay", "inv-op"], { OPERATION_ID: "op_" + "c".repeat(32) }).done;
    assert.match(paid.operation_id, OP);
    assert.notEqual(paid.operation_id, "op_" + "c".repeat(32));
    const found = await proc(w, "finder", ["status-op", paid.operation_id]).done;
    assert.equal(found.call_id, paid.call_id, JSON.stringify(found).slice(0, 300));
  });
});
