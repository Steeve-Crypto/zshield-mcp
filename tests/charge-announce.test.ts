import assert from "node:assert/strict";
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it, mock } from "node:test";
import { MockChainAdapter } from "../src/chain/mock.ts";
import * as budget from "../src/payments/budget.ts";
import { acquireWalletLock } from "../src/payments/lock.ts";
import { recoverPendingPayments } from "../src/payments/recovery.ts";
import { PaymentStore, resetPaymentStores, storeFor, walletStateDir } from "../src/payments/store.ts";
import { executePay } from "../src/tools/pay.ts";
import type { Config } from "../src/types.ts";
import { ALLOWED, tempConfig } from "./helpers.ts";

/**
 * A charge is one transmit authorization event, announced in the store generation before
 * and after it is written. The second announcement only keeps caches fresh. These tests
 * check that its failure never charges a payment that is then not sent, and that every
 * path around the authorization keeps the count equal to what may have been sent.
 */

const PRINCIPAL = 1000n, FEE = 10_000n, ONE = PRINCIPAL + FEE;
const zec = (zats: bigint) => `${zats / 100_000_000n}.${(zats % 100_000_000n).toString().padStart(8, "0")}`;
const now = () => new Date().toISOString();
const wallets: string[] = [];
after(() => { for (const w of wallets) fs.rmSync(w, { recursive: true, force: true }); });
beforeEach(() => { resetPaymentStores(); });

function wallet(capZats: bigint) {
  const walletDir = fs.mkdtempSync(join(tmpdir(), "zshield-charge-"));
  wallets.push(walletDir);
  const stateDir = walletStateDir(walletDir);
  const config = tempConfig({ totalSpendingCapZec: zec(capZats), rateLimitPerMin: 100_000, auditDir: join(walletDir, "audits") });
  const chain = new MockChainAdapter({ stateDir });
  const store = storeFor(config, chain);
  return { walletDir, stateDir, config, chain, store };
}

type W = ReturnType<typeof wallet>;
const pay = (w: { config: Config; chain: MockChainAdapter }, key: string) =>
  executePay({ amount_zec: zec(PRINCIPAL), recipient: ALLOWED, idempotency_key: key }, { config: w.config, chain: w.chain });
const parsed = (out: { text: string }) => JSON.parse(out.text) as { ok?: boolean; code?: string; txid?: string };
const recount = (store: PaymentStore) => budget.recountSpentZats(store) ?? 0n;
const sentTxids = async (w: W) => (await w.chain.getHistory(1000)).filter((t) => t.kind === "sent").map((t) => t.txid);

const isState = (p: unknown) => String(p).endsWith(join("zshield-generation", "state.json"));
const isAuthorization = (src: unknown) => {
  try { return fs.readFileSync(String(src), "utf8").includes('"transmit_authorized":true'); } catch { return false; }
};

/**
 * Makes the store generation unwritable and undeletable for the announcement right after
 * a transmit authorization event is published: replace and invalidate both fail.
 */
function failSecondAnnouncement() {
  let armed = false;
  let failed = 0;
  const realLink = fs.linkSync, realRename = fs.renameSync, realUnlink = fs.unlinkSync;
  const link = mock.method(fs, "linkSync", (src: fs.PathLike, dest: fs.PathLike) => {
    const authorization = isAuthorization(src);
    realLink(src, dest);
    if (authorization) armed = true;
  });
  const rename = mock.method(fs, "renameSync", (src: fs.PathLike, dest: fs.PathLike) => {
    if (armed && isState(dest)) { try { realUnlink(src); } catch { /* gone */ } throw Object.assign(new Error("ENOSPC: no space left"), { code: "ENOSPC" }); }
    return realRename(src, dest);
  });
  const unlink = mock.method(fs, "unlinkSync", (p: fs.PathLike) => {
    if (armed && isState(p)) { armed = false; failed++; throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" }); }
    return realUnlink(p);
  });
  return { failed: () => failed, restore: () => { link.mock.restore(); rename.mock.restore(); unlink.mock.restore(); } };
}

describe("charge announcement", () => {
  it("a failed announcement after the charge is written never leaves a charged payment unsent", async () => {
    const w = wallet(3n * ONE);
    const fault = failSecondAnnouncement();
    let out;
    try { out = await pay(w, "after-charge-1"); } finally { fault.restore(); }
    assert.equal(fault.failed(), 1, "the second announcement was made to fail");
    const charged = recount(w.store);
    const sent = await sentTxids(w);
    // Fails before the fix: the charge is durable, but the payment was refused and not sent.
    assert.ok(charged === 0n || sent.length === 1, `a payment that was never sent stays charged (${charged} zats charged, ${sent.length} sent)`);
    assert.equal(parsed(out).ok, true, out.text);
    assert.equal(sent.length, 1);
    assert.equal(charged, ONE);
  });

  it("the tolerated charge is counted by this process and by a fresh one, so the cap holds", async () => {
    const w = wallet(2n * ONE);
    const fault = failSecondAnnouncement();
    try { assert.equal(parsed(await pay(w, "tolerated-1")).ok, true); } finally { fault.restore(); }
    assert.equal(parsed(await pay(w, "tolerated-2")).ok, true);
    assert.equal(parsed(await pay(w, "tolerated-3")).code, "SPENDING_BUDGET_REFUSED", "the cap counted the tolerated charge");
    assert.equal(recount(w.store), 2n * ONE);
    resetPaymentStores();
    const fresh = { ...w, chain: new MockChainAdapter({ stateDir: w.stateDir }) };
    assert.equal(parsed(await pay(fresh, "tolerated-4")).code, "SPENDING_BUDGET_REFUSED", "a fresh process counts it too");
  });

  it("with the wallet lock lost at that point, the transmit is still refused", async () => {
    const w = wallet(3n * ONE);
    const id = `lost-${randomBytes(4).toString("hex")}`;
    const real = await acquireWalletLock(w.store, 5000, "maintenance");
    let lost = false;
    const lock = { ...real, exclusiveAcrossProcesses: real.exclusiveAcrossProcesses, assertHeld() { if (lost) throw new Error("wallet lock lost"); real.assertHeld(); }, release: () => real.release() };
    try {
      budget.checkSpending(w.config, w.store, lock, PRINCIPAL, FEE, "f".repeat(64), "probe");
      w.store.writeIntent({ call_id: id, ts: now(), amount_zec: zec(PRINCIPAL), amount_zats: PRINCIPAL.toString(), recipient: ALLOWED, allowlist_hit: true, cap_zec: 0.1, view_key_fingerprint: null, idempotency_key: id });
      const fault = failSecondAnnouncement();
      const realUnlink = fs.unlinkSync;
      const loseLock = mock.method(fs, "unlinkSync", (p: fs.PathLike) => { if (isState(p)) lost = true; return realUnlink(p); });
      try {
        assert.throws(() => budget.authorizeCharged(w.config, w.store, lock, { callId: id, intent: w.store.readCall(id)!.intent, events: [] }, PRINCIPAL, FEE), /wallet lock lost/);
      } finally { loseLock.mock.restore(); fault.restore(); }
      assert.equal(fault.failed(), 1);
    } finally { await real.release(); }
    // Refused, so nothing is transmitted; the durable authorization stays counted, as any
    // charge interrupted by a lost lock does.
    assert.equal(recount(w.store), ONE);
  });

  it("a charge that cannot be published charges nothing, sends nothing, and a retry pays", async () => {
    const w = wallet(2n * ONE);
    const realLink = fs.linkSync;
    const link = mock.method(fs, "linkSync", (src: fs.PathLike, dest: fs.PathLike) => {
      if (isAuthorization(src)) throw Object.assign(new Error("ENOSPC: no space left"), { code: "ENOSPC" });
      return realLink(src, dest);
    });
    let out;
    try { out = await pay(w, "unpublished-1"); } finally { link.mock.restore(); }
    assert.notEqual(parsed(out).ok, true, out.text);
    assert.equal((await sentTxids(w)).length, 0);
    assert.equal(recount(w.store), 0n);
    assert.equal(parsed(await pay(w, "unpublished-2")).ok, true);
    assert.equal(recount(w.store), ONE);
  });

  it("a refusal at the final gate charges nothing and leaves the cap usable", async () => {
    const w = wallet(ONE);
    const realAuthorize = PaymentStore.prototype.authorizeTransmit;
    const gate = mock.method(PaymentStore.prototype, "authorizeTransmit", function () { throw new Error("refused at the gate"); });
    let out;
    try { out = await pay(w, "gate-1"); } finally { gate.mock.restore(); }
    void realAuthorize;
    assert.notEqual(parsed(out).ok, true, out.text);
    assert.equal(recount(w.store), 0n);
    assert.equal(parsed(await pay(w, "gate-2")).ok, true);
  });

  it("a charged call interrupted before its outcome stays counted through restart and recovery", async () => {
    const w = wallet(3n * ONE);
    const id = `crash-${randomBytes(4).toString("hex")}`;
    // The empty ledger exists before the first intent, as the first payment check makes it.
    const first = await acquireWalletLock(w.store, 5000, "maintenance");
    try { budget.checkSpending(w.config, w.store, first, PRINCIPAL, FEE, "f".repeat(64), "probe"); } finally { await first.release(); }
    w.store.writeIntent({ call_id: id, ts: now(), amount_zec: zec(PRINCIPAL), amount_zats: PRINCIPAL.toString(), recipient: ALLOWED, allowlist_hit: true, cap_zec: 0.1, view_key_fingerprint: null, idempotency_key: id });
    w.store.appendEvent({ ts: now(), call_id: id, state: "pending", calculated_fee_zats: FEE.toString(), by: "send" });
    const lock = await acquireWalletLock(w.store, 5000, "maintenance");
    try { budget.authorizeCharged(w.config, w.store, lock, { callId: id, intent: w.store.readCall(id)!.intent, events: [] }, PRINCIPAL, FEE); } finally { await lock.release(); }
    assert.equal(recount(w.store), ONE);
    resetPaymentStores();
    const store = storeFor(w.config, w.chain);
    assert.equal(recount(store), ONE, "a restart never drops a charge that may have been sent");
    await recoverPendingPayments(w.config, w.chain);
    assert.equal(recount(store), ONE, "recovery never drops or doubles it");
  });
});
