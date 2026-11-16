import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, beforeEach, describe, it, mock } from "node:test";
import { fingerprintViewKey } from "../src/audit/log.ts";
import { MockChainAdapter } from "../src/chain/mock.ts";
import * as budget from "../src/payments/budget.ts";
import { acquireWalletLock, type WalletLock } from "../src/payments/lock.ts";
import { recoverPendingPayments } from "../src/payments/recovery.ts";
import { validatePaymentState } from "../src/payments/schema.ts";
import { PaymentStore, paymentParamsHash, resetPaymentStores, storeFor, walletStateDir } from "../src/payments/store.ts";
import { executePay } from "../src/tools/pay.ts";
import type { ChainAdapter } from "../src/chain/types.ts";
import type { Config, TxSummary } from "../src/types.ts";
import { ALLOWED, tempConfig } from "./helpers.ts";

/**
 * V12 run 18 (F-91): spending checks must not reprocess unchanged history. Tests marked
 * "fails before" fail on 844e819. The others pass on both and check that every cached
 * decision equals a full recount from disk, whatever happens to the store.
 */

// Absent before the fix (844e819): the tests that use it then fail, and are not marked "fails before".
const generation = (await import("../src/payments/generation.ts").catch(() => ({}))) as typeof import("../src/payments/generation.ts");
const setLimit = (limit?: number) => (budget as { setTallyLimitForTests?: (n?: number) => void }).setTallyLimitForTests?.(limit);
const now = () => new Date().toISOString();
const PRINCIPAL = 1000n, FEE = 10_000n, ONE = PRINCIPAL + FEE;
const zec = (zats: bigint) => `${zats / 100_000_000n}.${(zats % 100_000_000n).toString().padStart(8, "0")}`;
const GEN = (stateDir: string) => join(stateDir, "calls", "zshield-generation");
const wallets: string[] = [];
after(() => { for (const w of wallets) fs.rmSync(w, { recursive: true, force: true }); });

beforeEach(() => { resetPaymentStores(); setLimit(); });

/** A wallet whose store holds `n` paid calls, written before this process opened it. */
function walletWithHistory(n: number, capZats: bigint) {
  const walletDir = fs.mkdtempSync(join(tmpdir(), "zshield-r18-"));
  wallets.push(walletDir);
  const stateDir = walletStateDir(walletDir);
  const config = tempConfig({ totalSpendingCapZec: zec(capZats), rateLimitPerMin: 100_000, auditDir: join(walletDir, "audits") });
  const chain = new MockChainAdapter({ stateDir });
  storeFor(config, chain);
  resetPaymentStores();
  fs.mkdirSync(join(stateDir, "spending-budget"), { mode: 0o700 });
  fs.writeFileSync(join(stateDir, "spending-budget", "ledger.json"), JSON.stringify({ version: 2, total: "0" }), { mode: 0o600 });
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = `hist-${i.toString().padStart(5, "0")}-${randomBytes(4).toString("hex")}`;
    ids.push(id);
    writeCharged(stateDir, id, true);
  }
  return { walletDir, stateDir, config, chain, ids, history: BigInt(n) * ONE };
}

/** One charged, sent call written straight to disk, as an older version would. */
function writeCharged(stateDir: string, id: string, sent = false) {
  const dir = join(stateDir, "calls", id);
  fs.mkdirSync(dir, { mode: 0o700 });
  const t = String(Date.now()).padStart(15, "0");
  const write = (name: string, value: unknown) => fs.writeFileSync(join(dir, name), JSON.stringify(value), { mode: 0o600 });
  write("intent.json", { call_id: id, ts: now(), amount_zec: zec(PRINCIPAL), amount_zats: PRINCIPAL.toString(), recipient: ALLOWED, allowlist_hit: true, cap_zec: 0.1, view_key_fingerprint: null });
  write(`${t}-000000000001.json`, { ts: now(), call_id: id, state: "pending", calculated_fee_zats: FEE.toString(), by: "send" });
  write(`${t}-000000000002.json`, { ts: now(), call_id: id, state: "pending", transmit_authorized: true, charged_principal_zats: PRINCIPAL.toString(), charged_fee_zats: FEE.toString(), by: "send" });
  if (sent) write(`${t}-000000000003.json`, { ts: now(), call_id: id, state: "sent", txid: `mock_${id}`, by: "send" });
}

/** One charged call written through the store API, as another current process would. */
function storeCharge(store: PaymentStore, id: string) {
  store.writeIntent({ call_id: id, ts: now(), amount_zec: zec(PRINCIPAL), amount_zats: PRINCIPAL.toString(), recipient: ALLOWED, allowlist_hit: true, cap_zec: 0.1, view_key_fingerprint: null });
  store.authorizeTransmit(id, now(), { principal: PRINCIPAL, fee: FEE });
}

/** Counts while `run` runs: record reads and folder listings of history calls, and other reads. */
async function measure(stateDir: string, history: Set<string>, run: () => Promise<unknown> | unknown) {
  const counts = { historyReads: 0, historyListings: 0, otherReads: 0, recordOpens: 0 };
  const realRead = PaymentStore.prototype.readCall;
  const read = mock.method(PaymentStore.prototype, "readCall", function (this: PaymentStore, id: string) {
    if (history.has(id)) counts.historyReads++; else counts.otherReads++;
    return realRead.call(this, id);
  });
  const calls = join(resolve(stateDir), "calls") + "/";
  const callOf = (p: string) => p.startsWith(calls) ? p.slice(calls.length).split("/")[0] : undefined;
  const realOpen = fs.openSync;
  const open = mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
    const c = callOf(String(args[0]));
    if (c && history.has(c)) counts.recordOpens++;
    return realOpen(...args);
  });
  const realList = fs.readdirSync;
  const list = mock.method(fs, "readdirSync", (...args: Parameters<typeof fs.readdirSync>) => {
    const c = callOf(String(args[0]));
    if (c && history.has(c)) counts.historyListings++;
    return (realList as (...a: unknown[]) => unknown)(...args);
  });
  try { await run(); } finally { read.mock.restore(); open.mock.restore(); list.mock.restore(); }
  return counts;
}

const pay = (h: { config: Config; chain: ChainAdapter }, input: Record<string, unknown>) =>
  executePay({ amount_zec: zec(PRINCIPAL), recipient: ALLOWED, ...input }, { config: h.config, chain: h.chain });
const code = (out: { text: string }) => JSON.parse(out.text).code ?? (JSON.parse(out.text).ok ? "OK" : "ERROR");

/** The full recount from disk with no tally: the reference every cached decision must equal. */
function recount(store: PaymentStore): bigint {
  const fn = (budget as { recountSpentZats?: (s: PaymentStore) => bigint | undefined }).recountSpentZats ?? budget.spentZats;
  return fn(store) ?? 0n;
}

/** Under an exclusive wallet lock: fits exactly at the recounted total, refused one zat less. */
async function decidesLikeRecount(config: Config, store: PaymentStore, expected?: bigint) {
  const total = recount(store);
  if (expected !== undefined) assert.equal(total, expected);
  const lock = await acquireWalletLock(store, 5000, "maintenance");
  try {
    const check = (cap: bigint) => budget.checkSpending({ ...config, totalSpendingCapZec: zec(cap) }, store, lock, PRINCIPAL, FEE, "f".repeat(64), `probe-${randomBytes(4).toString("hex")}`);
    assert.throws(() => check(total + ONE - 1n), /allowance/, "decided from a count above the true one");
    check(total + ONE);
    assert.throws(() => check(total + ONE - 1n), /allowance/, "a cached decision differs from the recount");
    check(total + ONE);
  } finally { await lock.release(); }
}

async function locked<T>(store: PaymentStore, fn: (lock: WalletLock) => T): Promise<T> {
  const lock = await acquireWalletLock(store, 5000, "maintenance");
  try { return fn(lock); } finally { await lock.release(); }
}

const log: string[] = [];
function report(line: string) { log.push(line); console.log(`# F-91 ${line}`); }

/** A second real process paying on the same wallet. */
function childPay(h: { walletDir: string; stateDir: string; config: Config }, key: string, wait = false) {
  const script = `
    import { MockChainAdapter } from ${JSON.stringify(resolve("src/chain/mock.ts"))};
    import { executePay } from ${JSON.stringify(resolve("src/tools/pay.ts"))};
    const config = ${JSON.stringify({ ...h.config, auditDir: join(h.walletDir, `child-audit-${key}`) })};
    const out = await executePay({ amount_zec: ${JSON.stringify(zec(PRINCIPAL))}, recipient: ${JSON.stringify(ALLOWED)}, idempotency_key: ${JSON.stringify(key)} },
      { config, chain: new MockChainAdapter({ stateDir: ${JSON.stringify(h.stateDir)} }) });
    const r = JSON.parse(out.text); console.log(r.ok ? "OK" : r.code);`;
  if (!wait) {
    const child = spawnSync(process.execPath, ["--import", "tsx", "-e", script], { encoding: "utf8", cwd: resolve(".") });
    return Promise.resolve({ out: child.stdout.trim(), err: child.stderr });
  }
  return new Promise<{ out: string; err: string }>((done) => {
    const child = spawn(process.execPath, ["--import", "tsx", "-e", script], { cwd: resolve("."), stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", () => done({ out: out.trim(), err }));
  });
}

describe("V12 run 18 regressions", () => {
  it("F-91 repeated cap refusals re-read no unchanged history (fails before)", async () => {
    const h = walletWithHistory(100, 100n * ONE + 5_000n);
    const ids = new Set(h.ids);
    const fresh = await measure(h.stateDir, ids, async () => assert.equal(code(await pay(h, { idempotency_key: "refused" })), "SPENDING_BUDGET_REFUSED"));
    report(`fresh process, store open and first refusal, 100 calls: ${JSON.stringify(fresh)}`);
    assert.ok(fresh.historyReads <= 200, "a fresh process read a history call more than once for the store and once for the count");
    const again = await measure(h.stateDir, ids, async () => {
      for (let i = 0; i < 5; i++) assert.equal(code(await pay(h, { idempotency_key: "refused" })), "SPENDING_BUDGET_REFUSED");
      for (let i = 0; i < 5; i++) assert.equal(code(await pay(h, { idempotency_key: `refused-${i}` })), "SPENDING_BUDGET_REFUSED");
    });
    report(`10 repeated refusals after warm-up, 100 calls: ${JSON.stringify(again)}`);
    assert.equal(again.historyReads, 0, "a refusal re-read unchanged history");
    assert.equal(again.historyListings, 0, "a refusal listed unchanged call folders");
    assert.equal(again.recordOpens, 0, "a refusal opened unchanged record files");
  });

  const opens: Record<number, number> = {};
  for (const size of [100, 2000]) {
    it(`F-91 one payment re-reads only its own call across all its checks, ${size} calls (fails before)`, async () => {
      const h = walletWithHistory(size, 10n ** 9n);
      const ids = new Set(h.ids);
      assert.equal(code(await pay(h, { idempotency_key: "warm" })), "OK");
      const store = storeFor(h.config, h.chain);
      const one = await measure(h.stateDir, ids, async () => assert.equal(code(await pay(h, { idempotency_key: `paid-${size}` })), "OK"));
      report(`one payment after warm-up, ${size} calls: ${JSON.stringify(one)}`);
      assert.equal(one.historyReads, 0, "a payment re-read unchanged history");
      assert.equal(one.historyListings, 0, "a payment listed unchanged call folders");
      assert.equal(one.recordOpens, 0, "a payment opened unchanged record files");
      opens[size] = one.otherReads;
      if (size === 2000) assert.equal(opens[2000], opens[100], "work per payment grew with history");
      await decidesLikeRecount(h.config, store, h.history + 2n * ONE);
    });
  }

  it("F-91 another process's payment is never missed and only its call is re-read; a restart recounts (fails before)", async () => {
    const h = walletWithHistory(100, 100n * ONE + 2n * ONE);
    const ids = new Set(h.ids);
    const store = storeFor(h.config, h.chain);
    assert.equal(code(await pay(h, { idempotency_key: "here-1" })), "OK");
    // A second real process pays the last allowance this process's tally still holds free.
    const child = await childPay(h, "there-1");
    assert.equal(child.out, "OK", child.err);
    assert.equal(recount(store), h.history + 2n * ONE);
    const next = await measure(h.stateDir, ids, async () =>
      assert.equal(code(await pay(h, { idempotency_key: "here-2" })), "SPENDING_BUDGET_REFUSED", "a stale tally authorized spending another process already used"));
    report(`next payment after another process paid, 100 calls: ${JSON.stringify(next)}`);
    assert.equal(next.historyReads, 0, "unchanged history was re-read after another process wrote");
    assert.ok(next.otherReads >= 1, "the other process's call was never read");
    await decidesLikeRecount(h.config, store);
    resetPaymentStores();
    const restart = await measure(h.stateDir, ids, async () => assert.equal(code(await pay(h, { idempotency_key: "here-2" })), "SPENDING_BUDGET_REFUSED"));
    report(`restart, first refusal, 100 calls: ${JSON.stringify(restart)}`);
    assert.ok(restart.historyReads <= 200, "a restart read a history call more than twice");
    await decidesLikeRecount(h.config, storeFor(h.config, h.chain), h.history + 2n * ONE);
  });

  it("F-91 two real processes paying at once never exceed the cap", async () => {
    const h = walletWithHistory(30, 30n * ONE + 2n * ONE);
    const store = storeFor(h.config, h.chain);
    assert.equal(code(await pay(h, { idempotency_key: "warm" })), "OK");
    // One allowance left. This process (warm tally) and two fresh processes race for it.
    const [here, a, b] = await Promise.all([pay(h, { idempotency_key: "race-here" }), childPay(h, "race-a", true), childPay(h, "race-b", true)]);
    const outcomes = [code(here), a.out, b.out];
    assert.equal(outcomes.filter((o) => o === "OK").length, 1, `${JSON.stringify(outcomes)} ${a.err} ${b.err}`);
    assert.ok(outcomes.every((o) => o === "OK" || o === "SPENDING_BUDGET_REFUSED" || o === "BUSY"), JSON.stringify(outcomes));
    assert.equal(recount(store), h.history + 2n * ONE);
    await decidesLikeRecount(h.config, store);
  });

  it("F-91 cached decisions equal the full recount after pay, recovery and a restart", async () => {
    const h = walletWithHistory(20, 10n ** 9n);
    const store = storeFor(h.config, h.chain);
    for (const key of ["a", "b", "a"]) assert.equal(code(await pay(h, { idempotency_key: key })), "OK");
    await decidesLikeRecount(h.config, store, h.history + 2n * ONE);
    await recoverPendingPayments(h.config, h.chain);
    await decidesLikeRecount(h.config, store, h.history + 2n * ONE);
    resetPaymentStores();
    await decidesLikeRecount(h.config, storeFor(h.config, h.chain), h.history + 2n * ONE);
  });

  it("F-91 cached decisions equal the full recount after migration and resume", async () => {
    const VF = "uviewtest1" + "q".repeat(80), TX = "e8".repeat(32), R = "utest1" + "r".repeat(100);
    const input = { amount_zec: "0.0001", recipient: R, idempotency_key: "r18-legacy", memo: "m" };
    const config = tempConfig({ chainMode: "live", chainNetwork: "testnet", totalSpendingCapZec: "0.001", auditMaxBytes: 64 * 8193, auditRefusalMaxBytes: 64 * 8193 });
    fs.writeFileSync(config.allowlistPath, JSON.stringify({ recipients: [{ address: R }] }));
    let entry: TxSummary = { txid: TX, status: "calculated", kind: "sent", valueZats: 10000n, feeZats: 10000n, verified: true, outgoing: [{ recipient: R, valueZats: 10000n, memo: input.memo }] };
    const chain = {
      mode: "live", stagesBeforeBroadcast: true,
      getViewingKey: async () => VF, getTransaction: async () => [entry], getHistory: async () => [entry],
      checkHealth: async () => ({ walletHeight: 1000, chainTip: 1000, spendableZats: 100000n }),
      syncWallet: async () => ({ complete: true, elapsedMs: 0 }), walletHeight: async () => 1000,
      pay: async () => { assert.fail("never build a new transaction"); },
      resumeSigned: async (_txid: string, o: { fence: () => void }) => { o.fence(); entry = { ...entry, status: "confirmed", blockHeight: 999 }; },
    } as unknown as ChainAdapter;
    const store = storeFor(config, chain);
    store.writeIntent({ call_id: "old", ts: now(), amount_zec: "0.0002", amount_zats: "20000", recipient: R, allowlist_hit: true, cap_zec: "0.1",
      view_key_fingerprint: null, idempotency_key: "old", params_sha256: "b".repeat(64), two_step: true, transmit_tracked: true } as never);
    store.stageTxid("old", "b1".repeat(32), now());
    store.appendEvent({ ts: now(), call_id: "old", state: "pending", calculated_fee_zats: "10000", by: "send" });
    store.authorizeTransmit("old", now());
    await locked(store, (lock) => budget.initializeHistoricalBudget(store, lock));
    store.advance({ ts: now(), call_id: "old", state: "mined", txid: "b1".repeat(32), block_height: 990, by: "recovery" });
    await decidesLikeRecount(config, store, 30_000n);
    const hash = paymentParamsHash(input);
    store.writeIntent({ call_id: "legacy", ts: now(), amount_zats: "10000", allowlist_hit: true, cap_zec: "0.1", ...input,
      view_key_fingerprint: fingerprintViewKey(VF, config.viewKeyFingerprintSalt), two_step: true, params_sha256: hash } as never);
    store.bindKey(input.idempotency_key, "legacy", hash);
    store.stageTxid("legacy", TX, now());
    store.appendEvent({ ts: now(), call_id: "legacy", state: "pending", calculated_fee_zats: "10000", by: "send" });
    const out = await executePay({ ...input, resume: true }, { config, chain });
    assert.equal(JSON.parse(out.text).transmission_attempted, true, out.text);
    await decidesLikeRecount(config, store, 50_000n);
  });

  it("F-91 a corrupt record written by another writer refuses every payment and resets nothing", async () => {
    const h = walletWithHistory(10, 10n ** 9n);
    const store = storeFor(h.config, h.chain);
    await decidesLikeRecount(h.config, store);
    // Another process writes an event that is not a valid record into a history call.
    const other = new PaymentStore(h.stateDir);
    generation.announce(other.dir, h.ids[3]);
    fs.writeFileSync(join(h.stateDir, "calls", h.ids[3], "999999999999999-ffffffffffff.json"), "{not json", { mode: 0o600 });
    const refuse = () => locked(store, (lock) => assert.throws(() => budget.checkSpending(h.config, store, lock, PRINCIPAL, FEE, "f".repeat(64), "after-corrupt"), /cannot authorize/));
    await refuse();
    // Refusing again while nothing changed reads no history: a broken store is no work amplifier.
    const again = await measure(h.stateDir, new Set(h.ids), async () => { for (let i = 0; i < 3; i++) await refuse(); });
    assert.equal(again.historyReads, 0, JSON.stringify(again));
    resetPaymentStores();
    await refuse();
    assert.throws(() => budget.spentZats(store));
    // Repaired, the count is the same as before: nothing was reset to zero.
    fs.unlinkSync(join(h.stateDir, "calls", h.ids[3], "999999999999999-ffffffffffff.json"));
    generation.announce(other.dir, h.ids[3]);
    await decidesLikeRecount(h.config, store, h.history);
  });

  it("F-91 a missing or corrupt generation rebuilds in full and never counts zero", async () => {
    const h = walletWithHistory(10, 10n ** 9n);
    const store = storeFor(h.config, h.chain);
    storeCharge(store, "gen-1");
    await decidesLikeRecount(h.config, store, h.history + ONE);
    const state = join(GEN(h.stateDir), "state.json");
    for (const damage of [() => fs.unlinkSync(state), () => fs.writeFileSync(state, "garbage"), () => fs.writeFileSync(state, JSON.stringify({ v: 1, epoch: "0".repeat(32), gen: 0, head: "0".repeat(32), recent: [] }))]) {
      damage();
      // An unannounced charge, as a writer without the generation would leave it.
      writeCharged(h.stateDir, `unannounced-${randomBytes(3).toString("hex")}`);
      await decidesLikeRecount(h.config, store);
      assert.ok(generation.readGeneration(h.stateDir), "the generation was not re-created");
    }
    await decidesLikeRecount(h.config, store, h.history + 4n * ONE);
  });

  it("F-91 a restored snapshot, older or diverging, is never taken for a continuation", async () => {
    const h = walletWithHistory(10, 10n ** 9n);
    const store = storeFor(h.config, h.chain);
    storeCharge(store, "before-snapshot");
    await decidesLikeRecount(h.config, store, h.history + ONE);
    const snapshot = fs.mkdtempSync(join(h.walletDir, "snap-"));
    fs.cpSync(join(h.stateDir, "calls"), join(snapshot, "calls"), { recursive: true });
    const other = new PaymentStore(h.stateDir);
    for (let i = 0; i < 3; i++) storeCharge(other, `after-snapshot-${i}`);
    await decidesLikeRecount(h.config, store, h.history + 4n * ONE);
    // Restore: the snapshot's calls replace the live ones (the calls folder itself is pinned,
    // so its contents are replaced). The generation goes backwards.
    // Folders this process opened are pinned, so the restore removes what the snapshot lacks
    // and puts back the snapshot's files in place.
    const restore = () => {
      const keep = new Set(fs.readdirSync(join(snapshot, "calls")));
      for (const n of fs.readdirSync(join(h.stateDir, "calls"))) if (!keep.has(n)) fs.rmSync(join(h.stateDir, "calls", n), { recursive: true });
      for (const n of fs.readdirSync(join(snapshot, "calls", "zshield-generation"))) {
        fs.writeFileSync(join(GEN(h.stateDir), n), fs.readFileSync(join(snapshot, "calls", "zshield-generation", n)), { mode: 0o600 });
      }
    };
    restore();
    await decidesLikeRecount(h.config, store, h.history + ONE);
    // New writes after the restore pass the generation this process last saw.
    for (let i = 0; i < 4; i++) storeCharge(other, `after-restore-${i}`);
    await decidesLikeRecount(h.config, store, h.history + 5n * ONE);
    // Restore again, and write exactly as many records as were lost: same generation number.
    await decidesLikeRecount(h.config, store);
    const seen = generation.readGeneration(h.stateDir)!;
    restore();
    while (generation.readGeneration(h.stateDir)!.gen < seen.gen - 1) generation.announce(h.stateDir, "before-snapshot");
    storeCharge(other, "same-gen");
    assert.ok(generation.readGeneration(h.stateDir)!.gen >= seen.gen);
    await decidesLikeRecount(h.config, store, h.history + 2n * ONE);
  });

  it("F-91 older binaries fail closed: every file of the generation folder is an invalid call event to them", async () => {
    const h = walletWithHistory(2, 10n ** 9n);
    storeCharge(storeFor(h.config, h.chain), "makes-generation");
    const names = fs.readdirSync(GEN(h.stateDir)).filter((n) => !n.startsWith(".tmp-"));
    assert.ok(names.includes("format.json") && names.includes("state.json"), JSON.stringify(names));
    // What 844e819's readCall does with the folder: no intent, so every file is an event.
    assert.equal(fs.existsSync(join(GEN(h.stateDir), "intent.json")), false);
    for (const n of names) assert.throws(() => validatePaymentState("event", JSON.parse(fs.readFileSync(join(GEN(h.stateDir), n), "utf8"))), /Invalid persisted payment record/);
    // The folder name is a valid call id to older versions, so they do read it.
    assert.match("zshield-generation", /^[A-Za-z0-9_-][A-Za-z0-9._:-]{0,127}$/);
    // Even with the state removed (a failed write), format.json still stops them.
    fs.unlinkSync(join(GEN(h.stateDir), "state.json"));
    assert.ok(fs.existsSync(join(GEN(h.stateDir), "format.json")));
  });

  it("F-91 a failed generation write (ENOSPC) invalidates it, so nothing is missed; if that fails too, nothing is written", async () => {
    const h = walletWithHistory(5, 10n ** 9n);
    const store = storeFor(h.config, h.chain);
    await decidesLikeRecount(h.config, store);
    const realRename = fs.renameSync;
    const full = mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
      if (String(to).endsWith(join("zshield-generation", "state.json"))) throw Object.assign(new Error("no space"), { code: "ENOSPC" });
      return realRename(from, to);
    });
    try { storeCharge(new PaymentStore(h.stateDir), "while-full"); } finally { full.mock.restore(); }
    assert.equal(generation.readGeneration(h.stateDir), undefined, "a stale generation survived a failed announcement");
    await decidesLikeRecount(h.config, store, h.history + ONE);
    // Both the announcement and the invalidation fail: the record must not be written.
    const rename = mock.method(fs, "renameSync", () => { throw Object.assign(new Error("io"), { code: "EIO" }); });
    const realUnlink = fs.unlinkSync;
    const unlink = mock.method(fs, "unlinkSync", (p: fs.PathLike) => {
      if (String(p).endsWith(join("zshield-generation", "state.json"))) throw Object.assign(new Error("io"), { code: "EIO" });
      return realUnlink(p);
    });
    try {
      assert.throws(() => new PaymentStore(h.stateDir).writeIntent({ call_id: "never", ts: now(), amount_zec: zec(PRINCIPAL), amount_zats: PRINCIPAL.toString(), recipient: ALLOWED, allowlist_hit: true, cap_zec: 0.1, view_key_fingerprint: null }));
    } finally { rename.mock.restore(); unlink.mock.restore(); }
    assert.equal(fs.existsSync(join(h.stateDir, "calls", "never")), false);
    await decidesLikeRecount(h.config, store, h.history + ONE);
  });

  it("F-91 a crash after an announcement and before its write only re-reads that call", async () => {
    const h = walletWithHistory(50, 10n ** 9n);
    const store = storeFor(h.config, h.chain);
    await decidesLikeRecount(h.config, store);
    generation.announce(h.stateDir, h.ids[7]);
    generation.announce(h.stateDir, "crashed-before-intent");
    const counts = await measure(h.stateDir, new Set(h.ids), () => decidesLikeRecount(h.config, store, h.history));
    assert.ok(counts.historyReads <= 50 + 1, JSON.stringify(counts));
  });

  it("F-91 memory stays bounded: past the identity bound the count is recomputed, never cached", async () => {
    const h = walletWithHistory(12, 10n ** 9n);
    const store = storeFor(h.config, h.chain);
    setLimit(5);
    await decidesLikeRecount(h.config, store, h.history);
    const second = await measure(h.stateDir, new Set(h.ids), () => locked(store, (lock) => budget.checkSpending(h.config, store, lock, PRINCIPAL, FEE, "f".repeat(64), "k")));
    assert.ok(second.historyReads >= 12, "a tally past its bound was kept");
    setLimit();
    await decidesLikeRecount(h.config, store, h.history);
  });

  it("F-91 more writes than the generation window rebuild in full", async () => {
    const h = walletWithHistory(5, 10n ** 9n);
    const store = storeFor(h.config, h.chain);
    await decidesLikeRecount(h.config, store);
    const other = new PaymentStore(h.stateDir);
    storeCharge(other, "in-window-gap");
    for (let i = 0; i < generation.RECENT_WINDOW + 5; i++) generation.announce(h.stateDir, h.ids[0]);
    await decidesLikeRecount(h.config, store, h.history + ONE);
  });

  it("F-91 writes through a symlinked path to the same store are seen in the same lock hold", async () => {
    const h = walletWithHistory(10, 10n ** 9n);
    const store = storeFor(h.config, h.chain);
    const alias = join(h.walletDir, "alias-state");
    fs.symlinkSync(h.stateDir, alias);
    const other = new PaymentStore(alias);
    const config = { ...h.config, totalSpendingCapZec: zec(h.history + 2n * ONE) };
    await locked(store, (lock) => {
      assert.equal(lock.exclusiveAcrossProcesses, true);
      budget.checkSpending(config, store, lock, PRINCIPAL, FEE, "f".repeat(64), "one");
      for (const id of ["alias-1", "alias-2"]) {
        const intent = { call_id: id, ts: now(), amount_zec: zec(PRINCIPAL), amount_zats: PRINCIPAL.toString(), recipient: ALLOWED, allowlist_hit: true, cap_zec: 0.1, view_key_fingerprint: null };
        other.writeIntent(intent as never);
        budget.authorizeCharged(config, other, lock, { callId: id, intent: intent as never, events: [] }, PRINCIPAL, FEE);
      }
      assert.throws(() => budget.checkSpending(config, store, lock, PRINCIPAL, FEE, "f".repeat(64), "two"), /allowance/);
    });
    await decidesLikeRecount(h.config, store, h.history + 2n * ONE);
  });

  it("F-91 without an exclusive OS lock every decision recounts in full", async () => {
    const h = walletWithHistory(10, 10n ** 9n);
    const store = storeFor(h.config, h.chain);
    const lock = { assertHeld() {}, async release() {} } as WalletLock;
    const cap = h.history + 2n * ONE;
    const check = (key: string) => budget.checkSpending({ ...h.config, totalSpendingCapZec: zec(cap) }, store, lock, PRINCIPAL, FEE, "f".repeat(64), key);
    check("first");
    writeCharged(h.stateDir, "foreign-1");
    check("second");
    writeCharged(h.stateDir, "foreign-2");
    assert.throws(() => check("third"), /allowance/, "an in-process lock trusted a cached count");
  });

  it("F-91 the read-only count never trusts or updates the tally after a write", async () => {
    const h = walletWithHistory(10, 10n ** 9n);
    const store = storeFor(h.config, h.chain);
    await decidesLikeRecount(h.config, store);
    assert.equal(budget.spentZats(store), h.history);
    storeCharge(new PaymentStore(h.stateDir), "unlocked-reader");
    assert.equal(budget.spentZats(store), h.history + ONE);
    await decidesLikeRecount(h.config, store, h.history + ONE);
  });

  it("F-91 a ledger changed on disk is never decided from the old total", async () => {
    const h = walletWithHistory(10, 10n ** 9n);
    const store = storeFor(h.config, h.chain);
    await decidesLikeRecount(h.config, store);
    fs.writeFileSync(join(h.stateDir, "spending-budget", "ledger.json"), JSON.stringify({ version: 2, total: "500000" }), { mode: 0o600 });
    await decidesLikeRecount(h.config, store, h.history + 500_000n);
  });

  it("F-91 a clock moved backwards changes nothing: detection uses no timestamps", async () => {
    const h = walletWithHistory(10, 10n ** 9n);
    const store = storeFor(h.config, h.chain);
    await decidesLikeRecount(h.config, store);
    const clock = mock.method(Date, "now", () => 1_000);
    try { storeCharge(new PaymentStore(h.stateDir), "past"); } finally { clock.mock.restore(); }
    await decidesLikeRecount(h.config, store, h.history + ONE);
  });

  it("F-91 a symlinked generation file is never trusted or written through", async () => {
    const h = walletWithHistory(5, 10n ** 9n);
    const store = storeFor(h.config, h.chain);
    storeCharge(store, "first");
    await decidesLikeRecount(h.config, store, h.history + ONE);
    const state = join(GEN(h.stateDir), "state.json");
    const elsewhere = join(h.walletDir, "planted.json");
    fs.copyFileSync(state, elsewhere);
    fs.unlinkSync(state);
    fs.symlinkSync(elsewhere, state);
    const planted = fs.readFileSync(elsewhere, "utf8");
    assert.equal(generation.readGeneration(h.stateDir), undefined);
    await decidesLikeRecount(h.config, store, h.history + ONE);
    // A writer replaces the link with a new epoch; the link's target is never written.
    storeCharge(new PaymentStore(h.stateDir), "after-link");
    assert.equal(fs.lstatSync(state).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(elsewhere, "utf8"), planted);
    await decidesLikeRecount(h.config, store, h.history + 2n * ONE);
  });

  it("F-91 a write whose call name is too long for the generation makes readers rebuild", async () => {
    const h = walletWithHistory(5, 10n ** 9n);
    const store = storeFor(h.config, h.chain);
    await decidesLikeRecount(h.config, store);
    storeCharge(new PaymentStore(h.stateDir), `long-${"x".repeat(100)}`);
    assert.equal(generation.readGeneration(h.stateDir)!.recent.at(-1)![1], "*");
    await decidesLikeRecount(h.config, store, h.history + ONE);
  });

  it("F-91 log", () => {
    if (process.env.F91_COUNTS_LOG) fs.appendFileSync(process.env.F91_COUNTS_LOG, log.join("\n") + "\n");
  });
});
