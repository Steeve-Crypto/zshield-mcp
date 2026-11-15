import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, describe, it, mock } from "node:test";
import { fingerprintViewKey } from "../src/audit/log.ts";
import { MockChainAdapter } from "../src/chain/mock.ts";
import * as budget from "../src/payments/budget.ts";
import { acquireWalletLock, type WalletLock } from "../src/payments/lock.ts";
import { recoverPendingPayments } from "../src/payments/recovery.ts";
import { PaymentStore, paymentParamsHash, resetPaymentStores, storeFor, walletStateDir } from "../src/payments/store.ts";
import { executePay } from "../src/tools/pay.ts";
import type { ChainAdapter } from "../src/chain/types.ts";
import type { Config, TxSummary } from "../src/types.ts";
import { ALLOWED, tempConfig } from "./helpers.ts";

const now = () => new Date().toISOString();
const PRINCIPAL = 1000n, FEE = 10_000n;
const zec = (zats: bigint) => `${zats / 100_000_000n}.${(zats % 100_000_000n).toString().padStart(8, "0")}`;

beforeEach(() => resetPaymentStores());

/** A wallet whose store holds `n` paid calls, written straight to disk as another process would. */
function walletWithHistory(n: number, capZats: bigint) {
  const walletDir = fs.mkdtempSync(join(tmpdir(), "zshield-r18-"));
  const stateDir = walletStateDir(walletDir);
  const config = tempConfig({ totalSpendingCapZec: zec(capZats), rateLimitPerMin: 10_000 });
  const chain = new MockChainAdapter({ stateDir });
  // Opening once creates the layout; a restart then forgets everything in memory.
  storeFor(config, chain);
  resetPaymentStores();
  fs.mkdirSync(join(stateDir, "spending-budget"), { mode: 0o700 });
  fs.writeFileSync(join(stateDir, "spending-budget", "ledger.json"), JSON.stringify({ version: 2, total: "0" }), { mode: 0o600 });
  const ids: string[] = [];
  const t = Date.now();
  for (let i = 0; i < n; i++) {
    const id = `hist-${i.toString().padStart(5, "0")}-${randomBytes(4).toString("hex")}`;
    ids.push(id);
    const dir = join(stateDir, "calls", id);
    fs.mkdirSync(dir, { mode: 0o700 });
    const write = (name: string, value: unknown) => fs.writeFileSync(join(dir, name), JSON.stringify(value), { mode: 0o600 });
    write("intent.json", { call_id: id, ts: now(), amount_zec: zec(PRINCIPAL), amount_zats: PRINCIPAL.toString(), recipient: ALLOWED,
      allowlist_hit: true, cap_zec: 0.1, view_key_fingerprint: null });
    write(`${String(t).padStart(15, "0")}-000000000001.json`, { ts: now(), call_id: id, state: "pending", calculated_fee_zats: FEE.toString(), by: "send" });
    write(`${String(t).padStart(15, "0")}-000000000002.json`, { ts: now(), call_id: id, state: "pending", transmit_authorized: true,
      charged_principal_zats: PRINCIPAL.toString(), charged_fee_zats: FEE.toString(), by: "send" });
    write(`${String(t).padStart(15, "0")}-000000000003.json`, { ts: now(), call_id: id, state: "sent", txid: `mock_${id}`, by: "send" });
  }
  return { walletDir, stateDir, config, chain, ids, history: BigInt(n) * (PRINCIPAL + FEE) };
}

/**
 * Counts, while `run` runs: readCall of history calls, readCall of other calls, record file
 * opens under calls/ and directory listings. Records are what F-91 measured.
 */
async function measure(stateDir: string, history: Set<string>, run: () => Promise<unknown>) {
  const counts = { historyReads: 0, otherReads: 0, fileOpens: 0, listings: 0 };
  const realRead = PaymentStore.prototype.readCall;
  const read = mock.method(PaymentStore.prototype, "readCall", function (this: PaymentStore, id: string, ...rest: unknown[]) {
    if (history.has(id)) counts.historyReads++; else counts.otherReads++;
    return (realRead as (...a: unknown[]) => ReturnType<typeof realRead>).call(this, id, ...rest);
  });
  const calls = join(resolve(stateDir), "calls");
  const realOpen = fs.openSync;
  const open = mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
    if (String(args[0]).startsWith(calls)) counts.fileOpens++;
    return realOpen(...args);
  });
  const realList = fs.readdirSync;
  const list = mock.method(fs, "readdirSync", (...args: Parameters<typeof fs.readdirSync>) => {
    if (String(args[0]).startsWith(calls)) counts.listings++;
    return (realList as (...a: unknown[]) => unknown)(...args);
  });
  try { await run(); } finally { read.mock.restore(); open.mock.restore(); list.mock.restore(); }
  return counts;
}

const pay = (h: { config: Config; chain: ChainAdapter }, input: Record<string, unknown>) =>
  executePay({ amount_zec: zec(PRINCIPAL), recipient: ALLOWED, ...input }, { config: h.config, chain: h.chain });

/** The full recount from disk with no cache, the reference every cached decision must equal. */
function recount(store: PaymentStore): bigint {
  const fn = (budget as { recountSpentZats?: (s: PaymentStore) => bigint | undefined }).recountSpentZats ?? budget.spentZats;
  return fn(store) ?? 0n;
}
/** What a spending decision inside an already validated hold counts. */
function cached(store: PaymentStore): bigint {
  const fn = (budget as { cachedSpentZats?: (s: PaymentStore) => bigint | undefined }).cachedSpentZats ?? budget.spentZats;
  return fn(store) ?? 0n;
}

/** Decisions at the exact boundary agree with the recount: fits at cap, refused one zat below. */
async function decidesLikeRecount(config: Config, store: PaymentStore) {
  const total = recount(store);
  const lock = await acquireWalletLock(store, 5000, "maintenance");
  try {
    const check = (cap: bigint) => budget.checkSpending({ ...config, totalSpendingCapZec: zec(cap) }, store, lock, PRINCIPAL, FEE, "f".repeat(64), `probe-${randomBytes(4).toString("hex")}`);
    assert.throws(() => check(total + PRINCIPAL + FEE - 1n), /allowance/);
    check(total + PRINCIPAL + FEE);
  } finally { await lock.release(); }
}

const log: string[] = [];
function report(line: string) { log.push(line); console.log(`# F-91 ${line}`); }

describe("V12 run 18 regressions", () => {
  it("F-91 a fresh process reads the history once in full, at store open (the remaining cost)", async () => {
    const h = walletWithHistory(100, 0n + 100n * (PRINCIPAL + FEE) + 5_000n);
    const ids = new Set(h.ids);
    const first = await measure(h.stateDir, ids, () => pay(h, { idempotency_key: "too-big" }));
    report(`fresh process, first refusal, 100 calls: ${JSON.stringify(first)}`);
    assert.equal(first.historyReads, 100, "a fresh process must read each history call exactly once, no more");
  });

  it("F-91 repeated cap refusals with the same key re-read no unchanged call", async () => {
    const h = walletWithHistory(100, 100n * (PRINCIPAL + FEE) + 5_000n);
    const ids = new Set(h.ids);
    const warm = await pay(h, { idempotency_key: "refused" });
    assert.equal(JSON.parse(warm.text).code, "SPENDING_BUDGET_REFUSED", warm.text);
    const again = await measure(h.stateDir, ids, async () => {
      for (let i = 0; i < 5; i++) {
        const out = await pay(h, { idempotency_key: "refused" });
        assert.equal(JSON.parse(out.text).code, "SPENDING_BUDGET_REFUSED", out.text);
      }
    });
    report(`5 repeated refusals after warm-up, 100 calls: ${JSON.stringify(again)}`);
    assert.equal(again.historyReads, 0, "a refusal re-read unchanged history");
    assert.equal(again.fileOpens, 0, "a refusal opened payment record files");
    assert.equal(again.listings, 0, "a refusal listed call folders");
  });

  for (const size of [100, 2000]) {
    it(`F-91 one payment after warm-up re-reads only its own call across all 4 checks (${size} calls)`, async () => {
      const h = walletWithHistory(size, 10n ** 9n);
      const ids = new Set(h.ids);
      const warm = await pay(h, { idempotency_key: "warm" });
      assert.equal(JSON.parse(warm.text).ok, true, warm.text);
      const store = storeFor(h.config, h.chain);
      const one = await measure(h.stateDir, ids, async () => {
        const out = await pay(h, { idempotency_key: `paid-${size}` });
        assert.equal(JSON.parse(out.text).ok, true, out.text);
      });
      report(`one payment after warm-up, ${size} calls: ${JSON.stringify(one)}`);
      assert.equal(one.historyReads, 0, "a payment re-read unchanged history");
      // Opens are the payment's own records and the warm-up call: constant in the history size.
      assert.ok(one.fileOpens <= 60, `a payment opened ${one.fileOpens} record files`);
      // What remains per payment: one listing of each call folder, once per lock hold, to see
      // another process's writes. No record file of an unchanged call is opened.
      assert.ok(one.listings <= size + 10, `a payment listed ${one.listings} call folders, more than one pass`);
      assert.equal(cached(store), recount(store));
      (globalThis as Record<string, unknown>)[`r18opens${size}`] = one.fileOpens;
      if (size === 2000) assert.equal(one.fileOpens, (globalThis as Record<string, unknown>).r18opens100, "record reads per payment grew with history");
    });
  }

  it("F-91 a payment by another process forces a re-read of only that call, and is never missed", async () => {
    const h = walletWithHistory(100, 100n * (PRINCIPAL + FEE) + 2n * (PRINCIPAL + FEE));
    const ids = new Set(h.ids);
    const store = storeFor(h.config, h.chain);
    const warm = await pay(h, { idempotency_key: "here-1" });
    assert.equal(JSON.parse(warm.text).ok, true, warm.text);
    // A second real process pays the last allowance the cache still thinks is free.
    const child = spawnSync(process.execPath, ["--import", "tsx", "-e", `
      import { MockChainAdapter } from ${JSON.stringify(resolve("src/chain/mock.ts"))};
      import { executePay } from ${JSON.stringify(resolve("src/tools/pay.ts"))};
      const config = ${JSON.stringify({ ...h.config, auditDir: join(h.walletDir, "child-audit") })};
      const out = await executePay({ amount_zec: ${JSON.stringify(zec(PRINCIPAL))}, recipient: ${JSON.stringify(ALLOWED)}, idempotency_key: "there-1" },
        { config, chain: new MockChainAdapter({ stateDir: ${JSON.stringify(h.stateDir)} }) });
      console.log(JSON.parse(out.text).ok);
    `], { encoding: "utf8", cwd: resolve(".") });
    assert.equal(child.stdout.trim(), "true", child.stderr);
    assert.equal(recount(store), h.history + 2n * (PRINCIPAL + FEE));
    const next = await measure(h.stateDir, ids, async () => {
      const out = await pay(h, { idempotency_key: "here-2" });
      assert.equal(JSON.parse(out.text).code, "SPENDING_BUDGET_REFUSED", "a stale cache authorized spending another process already used");
    });
    report(`next payment after another process paid, 100 calls: ${JSON.stringify(next)}`);
    assert.equal(next.historyReads, 0, "unchanged history was re-read after another process wrote");
    assert.ok(next.otherReads >= 1, "the other process's call was never read");
    await decidesLikeRecount(h.config, store);
    // A restart forgets the cache: one full rescan at store open.
    resetPaymentStores();
    const restart = await measure(h.stateDir, ids, () => pay(h, { idempotency_key: "here-2" }));
    report(`restart, first refusal, 100 calls: ${JSON.stringify(restart)}`);
    assert.equal(restart.historyReads, 100, "a restart reads each history call exactly once");
    await decidesLikeRecount(h.config, storeFor(h.config, h.chain));
  });

  it("F-91 cached decisions equal the full recount after pay, recovery and a restart", async () => {
    const h = walletWithHistory(20, 10n ** 9n);
    const store = storeFor(h.config, h.chain);
    for (const key of ["a", "b", "a"]) assert.equal(JSON.parse((await pay(h, { idempotency_key: key })).text).ok, true);
    assert.equal(cached(store), recount(store));
    await decidesLikeRecount(h.config, store);
    await recoverPendingPayments(h.config, h.chain);
    assert.equal(cached(store), recount(store));
    await decidesLikeRecount(h.config, store);
    resetPaymentStores();
    const reopened = storeFor(h.config, h.chain);
    await decidesLikeRecount(h.config, reopened);
    assert.equal(cached(reopened), recount(reopened));
  });

  it("F-91 cached decisions equal the full recount after migration and resume", async () => {
    const VF = "uviewtest1" + "q".repeat(80), TX = "e8".repeat(32), R = "utest1" + "r".repeat(100);
    const input = { amount_zec: "0.0001", recipient: R, idempotency_key: "r18-legacy", memo: "m" };
    const config = tempConfig({ chainMode: "live", chainNetwork: "testnet", totalSpendingCapZec: "0.001", auditMaxBytes: 64 * 8193, auditRefusalMaxBytes: 64 * 8193 });
    fs.writeFileSync(config.allowlistPath, JSON.stringify({ recipients: [{ address: R }] }));
    let entry: TxSummary = { txid: TX, status: "calculated", kind: "sent", valueZats: 10000n, feeZats: 10000n, verified: true,
      outgoing: [{ recipient: R, valueZats: 10000n, memo: input.memo }] };
    const chain = {
      mode: "live", stagesBeforeBroadcast: true,
      getViewingKey: async () => VF, getTransaction: async () => [entry], getHistory: async () => [entry],
      checkHealth: async () => ({ walletHeight: 1000, chainTip: 1000, spendableZats: 100000n }),
      syncWallet: async () => ({ complete: true, elapsedMs: 0 }), walletHeight: async () => 1000,
      pay: async () => { assert.fail("never build a new transaction"); },
      resumeSigned: async (_txid: string, o: { fence: () => void }) => { o.fence(); entry = { ...entry, status: "confirmed", blockHeight: 999 }; },
    } as unknown as ChainAdapter;
    const store = storeFor(config, chain);
    // A historical authorized payment, migrated, then a legacy staged one resumed.
    store.writeIntent({ call_id: "old", ts: now(), amount_zec: "0.0002", amount_zats: "20000", recipient: R, allowlist_hit: true, cap_zec: "0.1",
      view_key_fingerprint: null, idempotency_key: "old", params_sha256: "b".repeat(64), two_step: true, transmit_tracked: true } as never);
    store.stageTxid("old", "b1".repeat(32), now());
    store.appendEvent({ ts: now(), call_id: "old", state: "pending", calculated_fee_zats: "10000", by: "send" });
    store.authorizeTransmit("old", now());
    let lock: WalletLock = await acquireWalletLock(store, 1000, "migration");
    try { budget.initializeHistoricalBudget(store, lock); } finally { await lock.release(); }
    assert.equal(recount(store), 30_000n);
    // The historical payment is mined, so it no longer blocks the resume below.
    store.advance({ ts: now(), call_id: "old", state: "mined", txid: "b1".repeat(32), block_height: 990, by: "recovery" });
    assert.equal(cached(store), recount(store));
    await decidesLikeRecount(config, store);
    const hash = paymentParamsHash(input);
    store.writeIntent({ call_id: "legacy", ts: now(), amount_zats: "10000", allowlist_hit: true, cap_zec: "0.1", ...input,
      view_key_fingerprint: fingerprintViewKey(VF, config.viewKeyFingerprintSalt), two_step: true, params_sha256: hash } as never);
    store.bindKey(input.idempotency_key, "legacy", hash);
    store.stageTxid("legacy", TX, now());
    store.appendEvent({ ts: now(), call_id: "legacy", state: "pending", calculated_fee_zats: "10000", by: "send" });
    lock = await acquireWalletLock(store, 1000, "maintenance");
    try { assert.equal(cached(store), recount(store)); } finally { await lock.release(); }
    const out = await executePay({ ...input, resume: true }, { config, chain });
    assert.equal(JSON.parse(out.text).transmission_attempted, true, out.text);
    assert.equal(recount(store), 50_000n);
    assert.equal(cached(store), recount(store));
    await decidesLikeRecount(config, store);
  });


  /** One more charged call written straight to disk, as another process would. */
  function foreignCharge(stateDir: string, id: string) {
    const dir = join(stateDir, "calls", id);
    fs.mkdirSync(dir, { mode: 0o700 });
    fs.writeFileSync(join(dir, "intent.json"), JSON.stringify({ call_id: id, ts: now(), amount_zec: zec(PRINCIPAL), amount_zats: PRINCIPAL.toString(),
      recipient: ALLOWED, allowlist_hit: true, cap_zec: 0.1, view_key_fingerprint: null }), { mode: 0o600 });
    fs.writeFileSync(join(dir, "000000000000001-0000000000aa.json"), JSON.stringify({ ts: now(), call_id: id, state: "pending", transmit_authorized: true,
      charged_principal_zats: PRINCIPAL.toString(), charged_fee_zats: FEE.toString(), by: "send" }), { mode: 0o600 });
  }

  it("F-91 a ledger changed on disk is never decided from the old total", async () => {
    const h = walletWithHistory(10, 10n ** 9n);
    const store = storeFor(h.config, h.chain);
    await decidesLikeRecount(h.config, store);
    // A restored or re-initialized ledger with a higher total, same calls.
    fs.writeFileSync(join(h.stateDir, "spending-budget", "ledger.json"), JSON.stringify({ version: 2, total: "500000" }), { mode: 0o600 });
    assert.equal(cached(store), recount(store));
    await decidesLikeRecount(h.config, store);
  });

  it("F-91 without the OS lock every acceptance lists the call folders again", async () => {
    const h = walletWithHistory(10, 10n ** 9n);
    const store = storeFor(h.config, h.chain);
    const lock = { assertHeld() {}, async release() {} } as WalletLock;
    const cap = h.history + 2n * (PRINCIPAL + FEE);
    const check = (key: string) => budget.checkSpending({ ...h.config, totalSpendingCapZec: zec(cap) }, store, lock, PRINCIPAL, FEE, "f".repeat(64), key);
    check("first");
    foreignCharge(h.stateDir, "foreign-1");
    check("second");
    foreignCharge(h.stateDir, "foreign-2");
    assert.throws(() => check("third"), /allowance/, "a reused in-process lock trusted a stale count");
  });

  it("F-91 a charge written through another path to the same store is seen in the same hold", async () => {
    const h = walletWithHistory(10, 10n ** 9n);
    const store = storeFor(h.config, h.chain);
    const alias = join(h.walletDir, "alias-state");
    fs.symlinkSync(h.stateDir, alias);
    const other = new PaymentStore(alias);
    const cap = h.history + 2n * (PRINCIPAL + FEE);
    const config = { ...h.config, totalSpendingCapZec: zec(cap) };
    const lock = await acquireWalletLock(store, 5000, "maintenance");
    try {
      assert.equal(lock.exclusiveAcrossProcesses, true);
      budget.checkSpending(config, store, lock, PRINCIPAL, FEE, "f".repeat(64), "one");
      for (const id of ["alias-1", "alias-2"]) {
        const intent = { call_id: id, ts: now(), amount_zec: zec(PRINCIPAL), amount_zats: PRINCIPAL.toString(), recipient: ALLOWED,
          allowlist_hit: true, cap_zec: 0.1, view_key_fingerprint: null };
        other.writeIntent(intent as never);
        budget.authorizeCharged(config, other, lock, { callId: id, intent: intent as never, events: [] }, PRINCIPAL, FEE);
      }
      assert.throws(() => budget.checkSpending(config, store, lock, PRINCIPAL, FEE, "f".repeat(64), "two"), /allowance/);
    } finally { await lock.release(); }
    assert.equal(cached(store), recount(store));
  });

  it("F-91 log", () => {
    fs.appendFileSync(process.env.R18_COUNTS_LOG ?? join(tmpdir(), "r18-counts.log"), log.join("\n") + "\n");
  });
});
