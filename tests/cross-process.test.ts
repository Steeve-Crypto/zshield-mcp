import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { appendAuditEntry } from "../src/audit/log.ts";
import { MockChainAdapter } from "../src/chain/mock.ts";
import { paymentIndexFor, paymentParamsHash, resetPaymentIndexes } from "../src/payments/index.ts";
import { executePay } from "../src/tools/pay.ts";
import { paymentStatus } from "../src/tools/status.ts";
import type { Config, PaymentReceipt, PaymentRequest } from "../src/types.ts";
import { ALLOWED, readAuditRows, tempConfig } from "./helpers.ts";

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

/** Rows another server process on the same audit log would write for a paid call. */
function paidElsewhere(config: Config, callId: string, input: { amount_zec: string; recipient: string; memo?: string; idempotency_key: string }) {
  const base = {
    tool: "zcash_pay" as const, call_id: callId, amount_zec: input.amount_zec, amount_zats: "100000", recipient: input.recipient,
    allowlist_hit: true, cap_zec: 0.1, view_key_fingerprint: "fp-other", memo: input.memo, idempotency_key: input.idempotency_key,
  };
  appendAuditEntry(config.auditDir, { ...base, ts: new Date().toISOString(), status: "pending", params_sha256: paymentParamsHash(input) });
  appendAuditEntry(config.auditDir, { ...base, ts: new Date().toISOString(), status: "ok", mock_txid: "mock_other" });
}

beforeEach(() => resetPaymentIndexes());

describe("idempotency keys across server processes on one audit log", () => {
  it("a key bound by another process after this one loaded its index is replayed, not paid again", async () => {
    const config = tempConfig();
    const { chain, sent } = countingChain();
    paymentIndexFor(config); // This process loaded the log before the other process wrote.
    const input = { amount_zec: "0.001", recipient: ALLOWED, idempotency_key: "shared-1" };
    paidElsewhere(config, "other-call", input);
    const r = JSON.parse((await executePay(input, { config, chain })).text);
    assert.equal(sent.length, 0);
    assert.equal(r.idempotent_replay, true);
    assert.equal(r.call_id, "other-call");
    assert.equal(r.txid, "mock_other");
    assert.equal(readAuditRows(config).at(-1)!.status, "replayed");
  });

  it("different parameters under a key bound elsewhere are IDEMPOTENCY_CONFLICT and send nothing", async () => {
    const config = tempConfig();
    const { chain, sent } = countingChain();
    paymentIndexFor(config);
    paidElsewhere(config, "other-call", { amount_zec: "0.001", recipient: ALLOWED, idempotency_key: "shared-2" });
    const r = await executePay({ amount_zec: "0.002", recipient: ALLOWED, idempotency_key: "shared-2" }, { config, chain });
    assert.equal(r.code, "IDEMPOTENCY_CONFLICT");
    assert.equal(sent.length, 0);
  });

  it("zcash_payment_status finds a call made by another process", async () => {
    const config = tempConfig();
    paymentIndexFor(config);
    paidElsewhere(config, "other-call", { amount_zec: "0.001", recipient: ALLOWED, idempotency_key: "shared-3" });
    const s = await paymentStatus(config, new MockChainAdapter(), { idempotency_key: "shared-3" });
    assert.equal(s.call_id, "other-call");
  });
});

describe("replay audit rows", () => {
  it("carry the allowlist hit and view key fingerprint of the first call", async () => {
    const config = tempConfig();
    const { chain } = countingChain();
    const input = { amount_zec: "0.001", recipient: ALLOWED, idempotency_key: "copy-1" };
    await executePay(input, { config, chain });
    resetPaymentIndexes(); // A new process, as in the testnet proof.
    await executePay(input, { config, chain });
    const rows = readAuditRows(config);
    const [ok, replay] = [rows[1], rows[2]];
    assert.equal(replay.status, "replayed");
    assert.equal(replay.allowlist_hit, true);
    assert.equal(typeof ok.view_key_fingerprint, "string");
    assert.equal(replay.view_key_fingerprint, ok.view_key_fingerprint);
  });
});
