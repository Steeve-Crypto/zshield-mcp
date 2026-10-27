import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { appendAuditEntry } from "../src/audit/log.ts";
import { MockChainAdapter } from "../src/chain/mock.ts";
import type { ChainAdapter } from "../src/chain/types.ts";
import { resetPaymentIndexes } from "../src/payments/index.ts";
import { RECOVERY_EXPIRY_MS, recoverPendingPayments } from "../src/payments/recovery.ts";
import { executePay } from "../src/tools/pay.ts";
import { executePaymentStatus, paymentStatus } from "../src/tools/status.ts";
import type { AuditEntry, Config, TxSummary } from "../src/types.ts";
import { ALLOWED, connect, readAuditRows, tempConfig, textOf } from "./helpers.ts";

const R = "utest1" + "s".repeat(100);
const T0 = Date.parse("2026-10-26T12:00:00Z");
const TX = "ab".repeat(32);

function pending(config: Config, callId: string, extra: Partial<AuditEntry> = {}) {
  appendAuditEntry(config.auditDir, {
    ts: new Date(T0).toISOString(), tool: "zcash_pay", call_id: callId, amount_zec: "0.0001", amount_zats: "10000",
    recipient: R, allowlist_hit: true, cap_zec: "0.01", status: "pending", view_key_fingerprint: "f", ...extra,
  });
}
function result(config: Config, callId: string, extra: Partial<AuditEntry>) {
  pending(config, callId);
  appendAuditEntry(config.auditDir, {
    ts: new Date(T0 + 1000).toISOString(), tool: "zcash_pay", call_id: callId, amount_zec: "0.0001", amount_zats: "10000",
    recipient: R, allowlist_hit: true, cap_zec: "0.01", status: "ok", view_key_fingerprint: "f", ...extra,
  });
}
function tx(over: Partial<TxSummary> = {}): TxSummary {
  return {
    txid: TX, time: new Date(T0 + 2000).toISOString(), status: "confirmed", blockHeight: 500, kind: "sent",
    valueZats: -10000n, outgoing: [{ recipient: R, valueZats: 10000n, memo: "" }], ...over,
  };
}
function chain(history: TxSummary[], height = 505) {
  const calls = { pay: 0 };
  const c = {
    mode: "live",
    async pay() {
      calls.pay++;
      throw new Error("status must never send");
    },
    getHistory: async () => history,
    walletHeight: async () => height,
    checkHealth: async () => ({ walletHeight: height, chainTip: height, spendableZats: 0n }),
  } as unknown as ChainAdapter;
  return { c, calls };
}

beforeEach(() => resetPaymentIndexes());

describe("zcash_payment_status", () => {
  it("mined with height and confirmations, by call_id", async () => {
    const config = tempConfig();
    result(config, "c1", { mock_txid: TX });
    const { c, calls } = chain([tx()]);
    const s = await paymentStatus(config, c, { call_id: "c1" }, T0 + 60_000);
    assert.equal(s.state, "mined");
    assert.equal(s.txid, TX);
    assert.equal(s.block_height, 500);
    assert.equal(s.confirmations, 6);
    assert.equal(calls.pay, 0);
  });

  it("broadcast while not mined, unknown once long gone from history", async () => {
    const config = tempConfig();
    result(config, "c1", { mock_txid: TX });
    assert.equal((await paymentStatus(config, chain([tx({ status: "transmitted", blockHeight: undefined })]).c, { call_id: "c1" }, T0)).state, "broadcast");
    assert.equal((await paymentStatus(config, chain([]).c, { call_id: "c1" }, T0 + 60_000)).state, "broadcast");
    assert.equal((await paymentStatus(config, chain([]).c, { call_id: "c1" }, T0 + RECOVERY_EXPIRY_MS + 1)).state, "unknown");
    assert.equal((await paymentStatus(config, chain([tx({ status: "failed" })]).c, { call_id: "c1" }, T0)).state, "failed");
  });

  it("failed with the code for a refused or errored call", async () => {
    const config = tempConfig();
    result(config, "c1", { status: "error", code: "INSUFFICIENT_FUNDS", error: "not enough" });
    const s = await paymentStatus(config, chain([]).c, { call_id: "c1" });
    assert.equal(s.state, "failed");
    assert.equal(s.code, "INSUFFICIENT_FUNDS");
  });

  it("an interrupted send: pending, then mined once it shows up, expired after recovery finds nothing", async () => {
    const config = tempConfig();
    pending(config, "c1", { idempotency_key: "k1", params_sha256: "p" });
    assert.equal((await paymentStatus(config, chain([]).c, { idempotency_key: "k1" }, T0 + 60_000)).state, "pending");
    const mined = await paymentStatus(config, chain([tx()]).c, { idempotency_key: "k1" }, T0 + 60_000);
    assert.equal(mined.state, "mined");
    assert.equal(mined.txid, TX);
    assert.equal((await paymentStatus(config, chain([]).c, { call_id: "c1" }, T0 + RECOVERY_EXPIRY_MS + 1)).state, "expired");

    await recoverPendingPayments(config, chain([]).c, { now: T0 + RECOVERY_EXPIRY_MS + 1 });
    const after = await paymentStatus(config, chain([tx()]).c, { call_id: "c1" });
    assert.equal(after.state, "expired");
  });

  it("SEND_UNCONFIRMED with one unmined candidate is broadcast", async () => {
    const config = tempConfig();
    result(config, "c1", { status: "unknown", code: "SEND_UNCONFIRMED" });
    const s = await paymentStatus(config, chain([tx({ status: "mempool", blockHeight: undefined })]).c, { call_id: "c1" }, T0 + 60_000);
    assert.equal(s.state, "broadcast");
    assert.equal(s.txid, TX);
    assert.equal(s.code, "SEND_UNCONFIRMED");
  });

  it("refuses a bad lookup and an unknown id, audited as rejected", async () => {
    const config = tempConfig();
    const c = new MockChainAdapter();
    for (const input of [{}, { call_id: "a", idempotency_key: "b" }, { call_id: "" }]) {
      const r = await executePaymentStatus(input, { config, chain: c });
      assert.equal(JSON.parse(r.text).code, "INVALID_LOOKUP");
    }
    const r = await executePaymentStatus({ idempotency_key: "nope" }, { config, chain: c });
    assert.equal(JSON.parse(r.text).code, "PAYMENT_NOT_FOUND");
    const rows = readAuditRows(config);
    assert.ok(rows.every((x) => x.tool === "zcash_payment_status" && x.status === "rejected"));
  });

  it("end to end on the mock chain: pay, replay, status", async () => {
    const config = tempConfig();
    const { client } = await connect(config);
    const args = { amount_zec: "0.001", recipient: ALLOWED, idempotency_key: "e2e-1" };
    const first = JSON.parse(textOf(await client.callTool({ name: "zcash_pay", arguments: args })));
    const again = JSON.parse(textOf(await client.callTool({ name: "zcash_pay", arguments: args })));
    assert.equal(again.idempotent_replay, true);
    assert.equal(again.txid, first.txid);
    const s = JSON.parse(textOf(await client.callTool({ name: "zcash_payment_status", arguments: { idempotency_key: "e2e-1" } })));
    assert.equal(s.ok, true);
    assert.equal(s.state, "mined");
    assert.equal(s.txid, first.txid);
    assert.equal(s.call_id, first.call_id);
    const last = readAuditRows(config).at(-1)!;
    assert.equal(last.tool, "zcash_payment_status");
    assert.equal(last.ref_call_id, first.call_id);
  });

  it("an executePay with no result yet reports pending through the key", async () => {
    const config = tempConfig();
    const c = new MockChainAdapter();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const real = c.pay.bind(c);
    c.pay = async (req) => {
      await gate;
      return real(req);
    };
    const p = executePay({ amount_zec: "0.001", recipient: ALLOWED, idempotency_key: "slow" }, { config, chain: c });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal((await paymentStatus(config, c, { idempotency_key: "slow" })).state, "pending");
    release();
    await p;
    assert.equal((await paymentStatus(config, c, { idempotency_key: "slow" })).state, "mined");
  });
});
