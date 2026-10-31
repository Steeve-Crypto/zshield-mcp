import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import { MockChainAdapter } from "../src/chain/mock.ts";
import { resetPaymentStores, walletStateDir } from "../src/payments/store.ts";
import { executePay } from "../src/tools/pay.ts";
import { paymentStatus } from "../src/tools/status.ts";
import type { PaymentReceipt, PaymentRequest } from "../src/types.ts";
import { ALLOWED, readAuditRows, tempConfig } from "./helpers.ts";

/** A mock chain bound to a wallet dir, so two of them share one payment store. */
function walletChain(walletDir: string) {
  const chain = new MockChainAdapter({ stateDir: walletStateDir(walletDir) });
  const real = chain.pay.bind(chain);
  const sent: PaymentRequest[] = [];
  chain.pay = async (req: PaymentRequest): Promise<PaymentReceipt> => {
    sent.push(req);
    return real(req);
  };
  return { chain, sent };
}

const wallet = () => mkdtempSync(join(tmpdir(), "zshield-wallet-"));

beforeEach(() => resetPaymentStores());

describe("idempotency keys across server processes on one wallet (V12 F-12)", () => {
  it("a key bound by a process with a different audit dir is replayed, not paid again", async () => {
    const w = wallet();
    const a = walletChain(w);
    const b = walletChain(w);
    const input = { amount_zec: "0.001", recipient: ALLOWED, idempotency_key: "shared-1" };
    const first = JSON.parse((await executePay(input, { config: tempConfig(), chain: a.chain })).text);
    resetPaymentStores(); // the second process starts fresh
    const configB = tempConfig();
    const r = JSON.parse((await executePay(input, { config: configB, chain: b.chain })).text);
    assert.equal(a.sent.length + b.sent.length, 1);
    assert.equal(r.idempotent_replay, true);
    assert.equal(r.call_id, first.call_id);
    assert.equal(r.txid, first.txid);
    assert.equal(readAuditRows(configB).at(-1)!.status, "replayed");
  });

  it("different parameters under a key bound elsewhere are IDEMPOTENCY_CONFLICT and send nothing", async () => {
    const w = wallet();
    const a = walletChain(w);
    const b = walletChain(w);
    await executePay({ amount_zec: "0.001", recipient: ALLOWED, idempotency_key: "shared-2" }, { config: tempConfig(), chain: a.chain });
    resetPaymentStores();
    const r = await executePay({ amount_zec: "0.002", recipient: ALLOWED, idempotency_key: "shared-2" }, { config: tempConfig(), chain: b.chain });
    assert.equal(r.code, "IDEMPOTENCY_CONFLICT");
    assert.equal(b.sent.length, 0);
  });

  it("zcash_payment_status finds a call made by another process with another audit dir", async () => {
    const w = wallet();
    const first = JSON.parse(
      (await executePay({ amount_zec: "0.001", recipient: ALLOWED, idempotency_key: "shared-3" }, { config: tempConfig(), chain: walletChain(w).chain })).text
    );
    resetPaymentStores();
    const s = await paymentStatus(tempConfig(), walletChain(w).chain, { idempotency_key: "shared-3" });
    assert.equal(s.call_id, first.call_id);
    const byCall = await paymentStatus(tempConfig(), walletChain(w).chain, { call_id: first.call_id });
    assert.equal(byCall.txid, first.txid);
  });
});

describe("replay audit rows", () => {
  it("carry the allowlist hit and view key fingerprint of the first call", async () => {
    const config = tempConfig();
    const { chain } = walletChain(wallet());
    const input = { amount_zec: "0.001", recipient: ALLOWED, idempotency_key: "copy-1" };
    await executePay(input, { config, chain });
    resetPaymentStores(); // A new process, as in the testnet proof.
    await executePay(input, { config, chain });
    const rows = readAuditRows(config);
    const [ok, replay] = [rows[1], rows[2]];
    assert.equal(replay.status, "replayed");
    assert.equal(replay.allowlist_hit, true);
    assert.equal(typeof ok.view_key_fingerprint, "string");
    assert.equal(replay.view_key_fingerprint, ok.view_key_fingerprint);
  });
});
