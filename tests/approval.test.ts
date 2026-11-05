import assert from "node:assert/strict";
import fs from "node:fs";
import { dirname, join } from "node:path";
import { generateKeyPairSync, sign } from "node:crypto";
import { it } from "node:test";
import { approvalBytes, approvalFilename, approvalKeys, type ApprovalPayload } from "../src/payments/approval.ts";
import { MockChainAdapter, MOCK_UFVK } from "../src/chain/mock.ts";
import { fingerprintViewKey } from "../src/audit/log.ts";
import { paymentParamsHash } from "../src/payments/store.ts";
import { executePay } from "../src/tools/pay.ts";
import { tempConfig, ALLOWED } from "./helpers.ts";

function world(threshold = 2) {
  const signers = [generateKeyPairSync("ed25519"), generateKeyPairSync("ed25519")];
  const config = tempConfig({ approvalPublicKeys: signers.map(k => k.publicKey.export({format:"pem",type:"spki"}).toString()), approvalThreshold: threshold });
  config.approvalDir = join(dirname(config.auditDir), "approvals");
  fs.mkdirSync(config.approvalDir, { mode: 0o700 });
  const chain = new MockChainAdapter();
  const input = { recipient: ALLOWED, amount_zec: "0.001", idempotency_key: "approved", memo: "invoice" };
  const payload: ApprovalPayload = { domain: "zshield-payment-approval-v1", network: "testnet", wallet_fingerprint: fingerprintViewKey(MOCK_UFVK, config.viewKeyFingerprintSalt), idempotency_key: input.idempotency_key, params_sha256: paymentParamsHash(input), expires_at: Date.now() + 60000 };
  const signatures = signers.map(k => sign(null, approvalBytes(payload), k.privateKey).toString("base64"));
  const write = (p = payload, sigs = signatures) => fs.writeFileSync(join(config.approvalDir!, approvalFilename(input.idempotency_key)), JSON.stringify({payload: p, signatures: sigs}), {mode:0o600});
  return {config, chain, input, payload, signatures, write, signPayload: (p: ApprovalPayload) => signers.map(k => sign(null, approvalBytes(p), k.privateKey).toString("base64"))};
}

it("two independent signatures authorize exactly one payment identity", async () => {
  const w = world();
  assert.equal((await executePay(w.input, w)).code, "APPROVAL_REQUIRED");
  w.write(w.payload, [w.signatures[0], w.signatures[0]]);
  assert.equal((await executePay(w.input, w)).code, "APPROVAL_REQUIRED");
  w.write();
  assert.equal((await executePay(w.input, w)).ok, true);
  assert.equal((await executePay(w.input, w)).ok, true);
  assert.equal((await executePay({...w.input, idempotency_key:"different"}, w)).code, "APPROVAL_REQUIRED");
});

for (const field of ["amount", "memo", "wallet", "expiry", "signature"] as const) {
  it(`approval rejects changed ${field}`, async () => {
    const w = world();
    w.write();
    if (field === "amount") w.input.amount_zec = "0.002";
    if (field === "memo") w.input.memo = "different";
    if (field === "wallet") w.config.viewKeyFingerprintSalt = "another-wallet-identity";
    if (field === "expiry") { const expired = {...w.payload, expires_at: Date.now() - 1}; w.write(expired, w.signPayload(expired)); }
    if (field === "signature") w.write(w.payload, ["A".repeat(86) + "=="]);
    assert.equal((await executePay(w.input, w)).code, "APPROVAL_REQUIRED");
  });
}

it("approval configuration cannot disappear after enforcement begins", async () => {
  const w = world();
  await executePay(w.input, w);
  w.config.approvalPublicKeys = undefined;
  assert.equal((await executePay(w.input, w)).code, "APPROVAL_REQUIRED");
});

it("duplicate signer keys cannot satisfy a two-person threshold", () => {
  const w = world();
  w.config.approvalPublicKeys![1] = w.config.approvalPublicKeys![0];
  assert.throws(() => approvalKeys(w.config), /distinct/);
});

it("revoking approval during signing blocks transmission", async () => {
  const w = world(); w.write();
  let sent = false;
  w.chain.pay = async request => {
    request.stage?.("ab".repeat(32));
    fs.unlinkSync(join(w.config.approvalDir!, approvalFilename(w.input.idempotency_key)));
    request.beforeTransmit?.();
    sent = true;
    throw new Error("unreachable");
  };
  assert.equal((await executePay(w.input, w)).ok, false);
  assert.equal(sent, false);
});
