import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AUDIT_SLOT_BYTES } from "../src/audit/budget.ts";
import { fingerprintViewKey } from "../src/audit/log.ts";
import { PaymentStore, storeFor, paymentParamsHash, mayHaveBroadcast } from "../src/payments/store.ts";
import { executePay } from "../src/tools/pay.ts";
import type { ChainAdapter } from "../src/chain/types.ts";
import type { TxSummary } from "../src/types.ts";
import { tempConfig } from "./helpers.ts";

const R = "utest1" + "r".repeat(100), TX = "ad".repeat(32), VF = "uviewtest1" + "q".repeat(80);
const now = () => new Date().toISOString();
function intent(callId: string, extra: Record<string, unknown> = {}) {
  return { call_id: callId, ts: now(), amount_zec: "0.0001", amount_zats: "10000", recipient: R,
    allowlist_hit: true, cap_zec: "0.1", view_key_fingerprint: null, ...extra };
}
function liveStore(): PaymentStore {
  const store = new PaymentStore(mkdtempSync(join(tmpdir(), "v12r13-")));
  store.requireOsLock = true;
  store.ensureLayout();
  return store;
}

describe("V12 run 13 regressions", () => {
  it("F-80 a legacy one-step unknown with no txid blocks new live sends", () => {
    const store = liveStore();
    store.writeIntent(intent("legacy"));
    store.appendEvent({ ts: now(), call_id: "legacy", state: "unknown", code: "SEND_UNCONFIRMED", by: "send" });
    const rec = store.readCall("legacy")!;
    assert.equal(rec.state, "unknown");
    assert.equal(rec.txid ?? rec.stagedTxid, undefined);
    assert.equal(mayHaveBroadcast(rec), true);
    assert.equal(store.unresolvedSend("other")?.callId, "legacy");
  });

  it("F-80 only local protocol proof of non-transmission releases the interlock", () => {
    const store = liveStore();
    // Tracked and never authorized: the transmit cannot have started.
    store.writeIntent(intent("tracked", { two_step: true, transmit_tracked: true }));
    store.stageTxid("tracked", TX, now());
    assert.equal(mayHaveBroadcast(store.readCall("tracked")!), false);
    // Two-step that never staged a transaction: nothing was signed.
    store.writeIntent(intent("unsigned", { two_step: true }));
    assert.equal(mayHaveBroadcast(store.readCall("unsigned")!), false);
    assert.equal(store.unresolvedSend("x"), undefined);
    // Once authorized, the tracked call may have broadcast and blocks again.
    store.authorizeTransmit("tracked", now());
    assert.equal(store.unresolvedSend("x")?.callId, "tracked");
  });

  it("F-76 a legacy staged send-path not_sent folds to unknown and stays pending after upgrade", () => {
    const dir = mkdtempSync(join(tmpdir(), "v12r13-up-"));
    const old = new PaymentStore(dir);
    old.ensureLayout();
    // Recorded before transmit tracking existed: there is no authorization marker at all.
    old.writeIntent(intent("old", { two_step: true }));
    old.stageTxid("old", TX, now());
    old.appendEvent({ ts: now(), call_id: "old", state: "not_sent", code: "BUSY", by: "send" });
    old.clearPending("old");
    assert.equal(old.readCall("old")!.state, "unknown");
    const upgraded = new PaymentStore(dir);
    upgraded.requireOsLock = true;
    upgraded.ensureLayout();
    assert.ok(upgraded.pendingCalls().includes("old"));
    assert.equal(upgraded.unresolvedSend("new")?.callId, "old");
    assert.equal(upgraded.unresolvedSend("new")?.txid, TX);
  });

  it("F-76 a tracked never-authorized staged not_sent stays not_sent", () => {
    const store = liveStore();
    store.writeIntent(intent("t", { two_step: true, transmit_tracked: true }));
    store.stageTxid("t", TX, now());
    store.appendEvent({ ts: now(), call_id: "t", state: "not_sent", code: "BUSY", by: "send" });
    assert.equal(store.readCall("t")!.state, "not_sent");
  });

  it("F-59 refused resumes never consume payment audit capacity", async () => {
    const config = tempConfig({ chainMode: "live", chainNetwork: "testnet" });
    // Room for only a few payment rows; refusals get their own pool.
    config.auditMaxBytes = 4 * AUDIT_SLOT_BYTES;
    config.auditRefusalMaxBytes = 200 * AUDIT_SLOT_BYTES;
    fs.writeFileSync(config.allowlistPath, JSON.stringify({ recipients: [{ address: R }] }));
    const input = { amount_zec: "0.0001", recipient: R, idempotency_key: "orig", memo: "m" };
    let entry: TxSummary = { txid: TX, status: "calculated", kind: "sent", valueZats: 10000n, verified: true,
      outgoing: [{ recipient: R, valueZats: 10000n, memo: input.memo }] };
    let attempts = 0;
    const chain = { mode: "live", stagesBeforeBroadcast: true, tracksTransmitAuthorization: true,
      getViewingKey: async () => VF,
      getTransaction: async () => [entry], getHistory: async () => [entry],
      checkHealth: async () => ({ walletHeight: 1000, chainTip: 1000, spendableZats: 100000n }),
      syncWallet: async () => ({ complete: true, elapsedMs: 0 }), walletHeight: async () => 1000,
      pay: async () => { assert.fail("never build a new transaction"); },
      resumeSigned: async (_txid: string, opts: { fence: () => void }) => {
        opts.fence(); attempts++;
        entry = { ...entry, status: "confirmed", blockHeight: 999 };
      },
    } as unknown as ChainAdapter;
    const store = storeFor(config, chain);
    const hash = paymentParamsHash(input);
    store.writeIntent({ ...intent("orig-call"), ...input, view_key_fingerprint: fingerprintViewKey(VF, config.viewKeyFingerprintSalt),
      two_step: true, transmit_tracked: true, params_sha256: hash });
    store.bindKey(input.idempotency_key, "orig-call", hash);
    store.stageTxid("orig-call", TX, now());
    store.authorizeTransmit("orig-call", now());
    const deps = { config, chain, store };
    fs.writeFileSync(join(store.dir, "payments.pause"), "incident");
    // Far more refused resumes than the payment pool could ever hold.
    for (let i = 0; i < 20; i++) {
      const refused = await executePay({ ...input, resume: true }, deps);
      assert.equal(refused.ok, false);
      assert.notEqual(JSON.parse(refused.text).code, "AUDIT_WRITE_FAILED");
    }
    assert.equal(attempts, 0);
    fs.unlinkSync(join(store.dir, "payments.pause"));
    const resumed = await executePay({ ...input, resume: true }, deps);
    const body = JSON.parse(resumed.text);
    assert.equal(resumed.ok, true, resumed.text);
    assert.equal(body.transmission_attempted, true);
    assert.equal(body.audit_warning, undefined);
    assert.equal(attempts, 1);
  });
});
