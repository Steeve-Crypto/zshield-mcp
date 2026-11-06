import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, mock } from "node:test";
import { AUDIT_SLOT_BYTES, reserveAudit } from "../src/audit/budget.ts";
import { operationalHealth } from "../src/operations/health.ts";
import { MockChainAdapter } from "../src/chain/mock.ts";
import { fingerprintViewKey, writeAuditRow } from "../src/audit/log.ts";
import { acquireWalletLock } from "../src/payments/lock.ts";
import { resumeOriginal } from "../src/payments/resume.ts";
import { storeFor, paymentParamsHash, mayHaveBroadcast } from "../src/payments/store.ts";
import { executePay } from "../src/tools/pay.ts";
import type { ChainAdapter } from "../src/chain/types.ts";
import type { Config, TxSummary } from "../src/types.ts";
import { tempConfig } from "./helpers.ts";

const R = "utest1" + "r".repeat(100), TX = "ad".repeat(32), VF = "uviewtest1" + "q".repeat(80);
const now = () => new Date().toISOString();
const input = { amount_zec: "0.0001", recipient: R, idempotency_key: "orig", memo: "m" };

/** A live testnet setup with one staged two-step payment bound to `input`. */
function staged(authorized: boolean) {
  const config = tempConfig({ chainMode: "live", chainNetwork: "testnet" });
  fs.writeFileSync(config.allowlistPath, JSON.stringify({ recipients: [{ address: R }] }));
  let entry: TxSummary = { txid: TX, status: "calculated", kind: "sent", valueZats: 10000n, verified: true,
    outgoing: [{ recipient: R, valueZats: 10000n, memo: input.memo }] };
  const sent = { count: 0 };
  const chain = { mode: "live", stagesBeforeBroadcast: true, tracksTransmitAuthorization: true,
    getViewingKey: async () => VF,
    getTransaction: async () => [entry], getHistory: async () => [entry],
    checkHealth: async () => ({ walletHeight: 1000, chainTip: 1000, spendableZats: 100000n }),
    syncWallet: async () => ({ complete: true, elapsedMs: 0 }), walletHeight: async () => 1000,
    pay: async () => { assert.fail("never build a new transaction"); },
    resumeSigned: async (_txid: string, opts: { fence: () => void }) => {
      opts.fence(); sent.count++;
      entry = { ...entry, status: "confirmed", blockHeight: 999 };
    },
  } as unknown as ChainAdapter;
  const store = storeFor(config, chain);
  const hash = paymentParamsHash(input);
  store.writeIntent({ call_id: "orig-call", ts: now(), amount_zats: "10000", allowlist_hit: true, cap_zec: "0.1", ...input,
    view_key_fingerprint: fingerprintViewKey(VF, config.viewKeyFingerprintSalt),
    two_step: true, transmit_tracked: true, params_sha256: hash } as never);
  store.bindKey(input.idempotency_key, "orig-call", hash);
  store.stageTxid("orig-call", TX, now());
  if (authorized) store.authorizeTransmit("orig-call", now());
  return { config, chain, store, sent };
}

/** A legacy one-step call whose outcome is unknown and whose txid was never recorded. */
function addLegacyUnknown(store: ReturnType<typeof storeFor>) {
  store.writeIntent({ call_id: "legacy", ts: now(), amount_zec: "0.0001", amount_zats: "10000", recipient: R,
    allowlist_hit: true, cap_zec: "0.1", view_key_fingerprint: null } as never);
  store.appendEvent({ ts: now(), call_id: "legacy", state: "unknown", code: "SEND_UNCONFIRMED", by: "send" });
}

describe("V12 run 14 regressions", () => {
  it("F-84 a tracked call never authorized to transmit cannot be revived by explicit resume", async () => {
    const { config, chain, store, sent } = staged(false);
    // It counts as never sent, so a replacement payment is allowed...
    assert.equal(mayHaveBroadcast(store.readCall("orig-call")!), false);
    assert.equal(store.unresolvedSend("new"), undefined);
    // ...and therefore it must never be transmitted later.
    const res = await executePay({ ...input, resume: true }, { config, chain, store });
    assert.equal(JSON.parse(res.text).transmission_attempted, false, res.text);
    assert.equal(sent.count, 0);
    assert.equal(store.readCall("orig-call")!.events.some((e) => e.transmit_authorized), false);
  });

  it("F-86 explicit resume honors the wallet-wide unresolved-send interlock", async () => {
    const { config, chain, store, sent } = staged(true);
    addLegacyUnknown(store);
    const res = await executePay({ ...input, resume: true }, { config, chain, store });
    const body = JSON.parse(res.text);
    assert.equal(body.transmission_attempted, false, res.text);
    assert.match(body.resume_note, /legacy/);
    assert.equal(sent.count, 0);
  });

  it("F-86 automatic recovery resume honors the same interlock", async () => {
    const { config, chain, store, sent } = staged(true);
    addLegacyUnknown(store);
    const lock = await acquireWalletLock(store, 1000, "zcash_pay");
    try {
      const out = await resumeOriginal(config, chain, store, lock, store.readCall("orig-call")!);
      assert.equal(out.attempted, false);
      assert.equal(sent.count, 0);
    } finally {
      await lock.release();
    }
  });

  it("F-86 resume still works once no other send is unresolved", async () => {
    const { config, chain, store, sent } = staged(true);
    const res = await executePay({ ...input, resume: true }, { config, chain, store });
    assert.equal(JSON.parse(res.text).transmission_attempted, true, res.text);
    assert.equal(sent.count, 1);
  });

});
