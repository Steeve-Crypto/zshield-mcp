import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, rmSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, it } from "node:test";
import { appendAuditEntry } from "../src/audit/log.ts";
import { parseTransactions } from "../src/chain/live.ts";
import type { ChainAdapter } from "../src/chain/types.ts";
import { MockChainAdapter } from "../src/chain/mock.ts";
import { defaultRunner, LiveChainAdapter, type CliRunner } from "../src/chain/live.ts";
import * as filelock from "../src/payments/filelock.ts";
import * as recovery from "../src/payments/recovery.ts";
import { acquireWalletLock } from "../src/payments/lock.ts";
import { readAuditRows } from "./helpers.ts";
import { recoverPendingPayments } from "../src/payments/recovery.ts";
import { resetPaymentStores, storeFor } from "../src/payments/store.ts";
import { executePay, matchSend } from "../src/tools/pay.ts";
import { paymentStatus } from "../src/tools/status.ts";
import type { AuditEntry, ChainHealth, Config, TxSummary } from "../src/types.ts";
import { ALLOWED, tempConfig } from "./helpers.ts";

// One regression test (or more) per V12 run 5 finding on d63f5d8. Each uses entry points
// that exist on both sides, so the file can be run against d63f5d8 to show it fails there.

const R = "utest1" + "r".repeat(100);
const OTHER = "utest1" + "o".repeat(100);
const T0 = Date.parse("2026-10-26T12:00:00Z");
const synced: ChainHealth = { walletHeight: 1000, chainTip: 1001, spendableZats: 0n };

beforeEach(() => resetPaymentStores());

function pending(config: Config, callId: string, extra: Partial<AuditEntry> = {}) {
  appendAuditEntry(config.auditDir, {
    ts: new Date(T0).toISOString(), tool: "zcash_pay", call_id: callId, amount_zec: "0.0001", amount_zats: "10000",
    recipient: R, allowlist_hit: true, cap_zec: "0.01", status: "pending", view_key_fingerprint: "abc", chain_tip: 900,
    ...extra,
  } as AuditEntry);
}

function sent(txid: string, over: Partial<TxSummary> = {}, memo = ""): TxSummary {
  return {
    txid, time: new Date(T0 + 5000).toISOString(), status: "confirmed", blockHeight: 950, kind: "sent",
    valueZats: 10000n, outgoing: [{ recipient: R, valueZats: 10000n, memo }], ...over,
  } as TxSummary;
}

function chainOf(history: TxSummary[], health: ChainHealth = synced) {
  return {
    async pay() { throw new Error("recovery must never send"); },
    async getBalance() { throw new Error("unused"); },
    async getReceiveAddress() { throw new Error("unused"); },
    async getHistory() { return history; },
    async checkHealth() { return health; },
    getViewingKey: async () => "uview",
  } as unknown as ChainAdapter;
}

const tx = (n: number) => n.toString(16).padStart(64, "0");

describe("F-8: a history match must be this call's send", () => {
  it("a send with no memo does not match a transaction that carries a memo", () => {
    const target = { amountZats: 10000n, recipient: R };
    assert.equal(matchSend(sent(tx(1), {}, "invoice 7"), target, T0), undefined);
    assert.ok(matchSend(sent(tx(1), {}, ""), target, T0));
  });

  it("recovery leaves a memo-less call unknown when the only match is someone else's memo payment", async () => {
    const config = tempConfig();
    pending(config, "c1");
    const rows = await recoverPendingPayments(config, chainOf([sent(tx(1), {}, "invoice 7")]), { now: T0 + 60_000 });
    assert.notEqual(rows[0].status, "confirmed");
    assert.equal(storeFor(config, chainOf([])).readCall("c1")?.state, "unknown");
  });

  it("a memo with a line break is refused, since it could forge lines of the wallet listing", async () => {
    const config = tempConfig();
    const r = await executePay({ amount_zec: 0.001, recipient: ALLOWED, memo: "hi\nrecipient: x" }, { config, chain: new MockChainAdapter() });
    assert.equal(r.code, "INVALID_MEMO");
    const tab = await executePay({ amount_zec: 0.001, recipient: ALLOWED, memo: "a\u0085b" }, { config, chain: new MockChainAdapter() });
    assert.equal(tab.code, "INVALID_MEMO");
  });

  it("a recipient line inside an old multi-line memo cannot stand in for the real recipient", () => {
    const out = `{
    txid: ${tx(9)}
    datetime: 2026-10-26 12:00:05 UTC
    status: confirmed
    blockheight: 950
    kind: sent
    value: 10000
    outgoing orchard notes: 
\t{
            value: 10000
            memo: thanks
              recipient: ${OTHER}
            recipient: ${R}
            output index: 0
        }
}`;
    const [t] = parseTransactions(out);
    assert.equal(t.outgoing?.[0].recipient, R);
  });

  it("a wallet that lists the unified address beside another recipient form still matches", () => {
    const [t] = parseTransactions(`{
    txid: ${tx(9)}
    datetime: 2026-10-26 12:00:05 UTC
    status: confirmed
    blockheight: 950
    kind: sent
    value: 10000
    outgoing orchard notes: 
\t{
            value: 10000
            memo: 
            recipient: ztestsapling1other
            recipient unified address: ${R}
            output index: 0
        }
}`);
    assert.ok(matchSend(t, { amountZats: 10000n, recipient: R }, T0));
  });

  it("a mined entry with no time is not confirmed unless its height places it after the call", async () => {
    const config = tempConfig();
    pending(config, "c1");
    const noTimeOld = sent(tx(1), { time: undefined, blockHeight: 100 });
    const rows = await recoverPendingPayments(config, chainOf([noTimeOld]), { now: T0 + 60_000 });
    assert.notEqual(rows[0].status, "confirmed");
    assert.notEqual(rows[0].note, "");
    resetPaymentStores();
    const config2 = tempConfig();
    pending(config2, "c2");
    const noTimeNoHeight = sent(tx(2), { time: undefined, blockHeight: undefined, status: "confirmed" });
    const rows2 = await recoverPendingPayments(config2, chainOf([noTimeNoHeight]), { now: T0 + 60_000 });
    assert.notEqual(rows2[0].status, "confirmed");
  });

  it("two identical unsettled calls never both take one transaction", async () => {
    const config = tempConfig();
    pending(config, "c1", { idempotency_key: "k1" });
    pending(config, "c2", { idempotency_key: "k2", ts: new Date(T0 + 1000).toISOString() });
    const rows = await recoverPendingPayments(config, chainOf([sent(tx(1))]), { now: T0 + 60_000 });
    assert.equal(rows.filter((r) => r.status === "confirmed").length, 0);
    const store = storeFor(config, chainOf([]));
    assert.equal(store.readCall("c1")?.state, "unknown");
    assert.equal(store.readCall("c2")?.state, "unknown");
  });

  it("an unclaimed sent transaction of the same amount blocks a not-sent proof", async () => {
    const config = tempConfig();
    pending(config, "c1");
    // Same amount, listed to a recipient form this code does not know.
    const odd = sent(tx(1), { outgoing: [{ recipient: "ztestsapling1unknownform", valueZats: 10000n, memo: "" }] });
    const rows = await recoverPendingPayments(config, chainOf([odd], { walletHeight: 5000, chainTip: 5000, spendableZats: 0n }), { now: T0 + 3 * 3_600_000 });
    assert.equal(rows[0].status, "unknown");
    assert.equal(storeFor(config, chainOf([])).readCall("c1")?.state, "unknown");
  });
});

// F-21: stale-lock races and split-brain leases.

const LOCK_DRIVER = fileURLToPath(new URL("./fixtures/lock-driver.mts", import.meta.url));
const TSX = import.meta.resolve("tsx");

function lockProc(dir: string, args: string[], leaseMs: number) {
  const child = spawn(process.execPath, ["--import", TSX, LOCK_DRIVER, dir, ...args], {
    env: { PATH: process.env.PATH ?? "", ZSHIELD_LOCK_LEASE_MS: String(leaseMs) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout!.on("data", (d) => (out += d));
  const events = new Promise<{ event: string; t: number; message?: string }[]>((resolve) =>
    child.on("close", () => resolve(out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))))
  );
  return { child, events, started: async (): Promise<void> => { while (!out.includes("acquired")) await new Promise((r) => setTimeout(r, 20)); } };
}

describe("F-21: leases", () => {
  it("a waiter with a short lease does not break a live holder with a long one (two processes)", async () => {
    const d = mkdtempSync(join(tmpdir(), "zshield-lease-"));
    const holder = lockProc(d, ["3500", "0"], 600_000);
    await holder.started();
    // The holder renews every 150 s here, so by the waiter's own 1 s lease it looks old.
    const waiter = lockProc(d, ["100", "2500"], 1000);
    const [h, w] = await Promise.all([holder.events, waiter.events]);
    assert.deepEqual(w.map((e) => e.event), ["busy"], "the waiter must not take a lock whose holder is alive and within its own lease");
    assert.ok(h.some((e) => e.event === "held"), "the holder still holds at the end");
  });

  it("the lock file records its lease time and a renewal counter", async () => {
    const d = mkdtempSync(join(tmpdir(), "zshield-lease-"));
    const lease = await filelock.acquireFileLock(d, { waitMs: 0, purpose: "t", leaseMs: 4000 });
    const first = JSON.parse(readFileSync(join(d, "wallet.lock"), "utf8"));
    assert.equal(first.leaseMs, 4000);
    lease.assertHeld();
    lease.assertHeld();
    const later = JSON.parse(readFileSync(join(d, "wallet.lock"), "utf8"));
    assert.ok(parseInt(later.gen, 16) > parseInt(first.gen, 16), "the counter moves on every renewal");
    assert.equal(later.token, first.token);
    lease.release();
  });

  it("breaking a stale lock that was renewed after it was judged puts it back", async () => {
    const d = mkdtempSync(join(tmpdir(), "zshield-lease-"));
    const lease = await filelock.acquireFileLock(d, { waitMs: 0, purpose: "t", leaseMs: 1000 });
    const path = join(d, "wallet.lock");
    const judged = readFileSync(path, "utf8");
    const old = new Date(Date.now() - 60_000);
    utimesSync(path, old, old); // what the waiter saw: an old mtime
    // The holder renews after the waiter looked and before it moves the file.
    lease.assertHeld();
    filelock.breakStaleLockForTest(path, judged, { leaseMs: 1000 });
    assert.ok(statSync(path).isFile(), "the live lock is still in place");
    lease.assertHeld();
    lease.release();
  });

  it("a renewal that lands during the move is seen: the file is put back, not removed", async () => {
    const d = mkdtempSync(join(tmpdir(), "zshield-lease-"));
    const path = join(d, "wallet.lock");
    const lease = await filelock.acquireFileLock(d, { waitMs: 0, purpose: "t", leaseMs: 1000 });
    const old = new Date(Date.now() - 60_000);
    utimesSync(path, old, old);
    const judged = readFileSync(path, "utf8");
    let aside = "";
    filelock.breakStaleLockForTest(path, judged, {
      leaseMs: 1000,
      afterMove: () => {
        // The holder's heartbeat touches the inode it already holds, as the move leaves it.
        const now = new Date();
        for (const f of readdirSync(d)) if (f.includes(".stale-")) { aside = f; utimesSync(join(d, f), now, now); }
      },
    });
    assert.ok(aside, "the file was moved aside");
    assert.ok(statSync(path).isFile(), "and put back");
    lease.assertHeld();
    lease.release();
  });

  it("four processes taking the lease in turn never overlap, even with a one second lease", async () => {
    const d = mkdtempSync(join(tmpdir(), "zshield-lease-"));
    const marker = join(d, "critical");
    const procs = [0, 1, 2, 3].map(() => lockProc(d, ["250", "20000", "4", marker], 1000));
    const all = (await Promise.all(procs.map((p) => p.events))).flat();
    assert.equal(all.filter((e) => e.event === "overlap").length, 0);
    assert.equal(all.filter((e) => e.event === "lost").length, 0);
    assert.equal(all.filter((e) => e.event === "acquired").length, 16);
  });
});



// F-14: every path where a holder could send while another process holds the wallet.

function liveCfg(): Config {
  const config = tempConfig({ chainMode: "live", chainNetwork: "testnet" });
  writeFileSync(config.allowlistPath, JSON.stringify({ recipients: [{ address: R }] }));
  return config;
}

type Req = import("../src/types.ts").PaymentRequest;

/** A live-mode chain whose health check and send are scripted. `store` is filled in once the store exists. */
function liveChain(hooks: { health?: () => void; pay?: (req: Req) => void; reading?: () => ChainHealth; history?: () => TxSummary[] }) {
  const counts = { sent: 0 };
  const chain = {
    mode: "live",
    async getViewingKey() { return "uviewtest1" + "q".repeat(80); },
    async checkHealth() { hooks.health?.(); return hooks.reading?.() ?? { walletHeight: 1000, chainTip: 1000, spendableZats: 10_000_000n }; },
    async pay(req: Req) {
      hooks.pay?.(req);
      counts.sent++;
      return { txid: tx(77), amountZats: req.amountZats, recipient: req.recipient, mode: "live" };
    },
    async getBalance() { throw new Error("unused"); },
    async getReceiveAddress() { throw new Error("unused"); },
    async getHistory() { return hooks.history?.() ?? []; },
  } as unknown as ChainAdapter;
  return { chain, counts };
}

describe("F-14: nothing sends without the lease", () => {
  it("a lease lost at the last moment before the wallet process starts stops the send", async () => {
    const config = liveCfg();
    let dir = "";
    const { chain, counts } = liveChain({
      pay: (req) => {
        // Another process takes over right here, after every earlier check passed.
        rmSync(join(dir, "wallet.lock"));
        req.fence?.();
      },
    });
    dir = storeFor(config, chain).dir;
    const r = await executePay({ amount_zec: "0.0001", recipient: R, idempotency_key: "k-fence" }, { config, chain });
    assert.equal(counts.sent, 0, "the send must not go out");
    assert.equal(r.code, "BUSY");
    assert.equal(storeFor(config, chain).readCall(JSON.parse(r.text).call_id)?.state, "not_sent");
  });

  it("the live adapter runs the fence before it starts zingo-cli, and does not start it when the fence throws", async () => {
    let started = 0;
    const runner: CliRunner = async () => { started++; return '{ "txids": ["' + tx(5) + '"] }'; };
    const a = new LiveChainAdapter({ network: "testnet", runner });
    await assert.rejects(a.pay({ amountZats: 1000n, recipient: R, fence: () => { throw new Error("lost"); } }), /lost/);
    assert.equal(started, 0);
  });

  it("a key bound by another call during the health check makes this call a replay that writes nothing", async () => {
    const config = liveCfg();
    let store: ReturnType<typeof storeFor> | undefined;
    const { chain, counts } = liveChain({
      health: () => {
        // The other call took the key while this one sat in its health check.
        store!.writeIntent({ call_id: "other", ts: new Date().toISOString(), amount_zec: "0.0001", amount_zats: "10000", recipient: R, allowlist_hit: true, cap_zec: config.spendingCapZec, view_key_fingerprint: "f", idempotency_key: "k-bound", params_sha256: "p".repeat(64) } as never);
        store!.bindKey("k-bound", "other", "p".repeat(64));
      },
    });
    store = storeFor(config, chain);
    await executePay({ amount_zec: "0.0001", recipient: R, idempotency_key: "k-bound" }, { config, chain });
    assert.equal(counts.sent, 0);
    const mine = readAuditRows(config).filter((r) => r.call_id !== "other");
    assert.deepEqual(mine.filter((r) => r.status === "pending"), [], "no pending row and no intent for a call that was not going to send");
  });
});

describe("F-14: bounded work", () => {
  it("a wallet process that ignores SIGTERM is killed after its timeout", async () => {
    const d = mkdtempSync(join(tmpdir(), "zshield-kill-"));
    const bin = join(d, "stubborn.mjs");
    writeFileSync(bin, "#!/usr/bin/env node\nprocess.on('SIGTERM', () => {});\nsetTimeout(() => {}, 9000);\n");
    chmodSync(bin, 0o700);
    const t = Date.now();
    await assert.rejects(defaultRunner(bin, [], { timeoutMs: 200, killGraceMs: 300 } as never));
    assert.ok(Date.now() - t < 4000, `stopped after ${Date.now() - t} ms`);
  });

  it("startup recovery takes a bounded number of calls per run and gives up its bounded lock wait", async () => {
    assert.ok(recovery.RECOVERY_MAX_CALLS <= 200);
    assert.ok(recovery.RECOVERY_BUDGET_MS <= 300_000);
    assert.ok(recovery.RECOVERY_LOCK_WAIT_MS * recovery.RECOVERY_LOCK_ATTEMPTS <= 600_000);
    const config = tempConfig();
    for (let i = 0; i < 130; i++) pending(config, `c${i}`, { idempotency_key: `k${i}`, recipient: R + (i % 7) });
    const rows = await recoverPendingPayments(config, chainOf([]) as never, { now: T0 + 60_000, maxCalls: 20 } as never);
    assert.equal(rows.length, 20);
  });

  it("recovery stops taking calls when its time budget is spent", async () => {
    const config = tempConfig();
    for (let i = 0; i < 10; i++) pending(config, `c${i}`, { idempotency_key: `k${i}`, recipient: R + i });
    const rows = await recoverPendingPayments(config, chainOf([]) as never, { now: T0 + 60_000, budgetMs: 0 } as never);
    assert.ok(rows.length <= 1, `handled ${rows.length}`);
  });

  it("recovery lets timers run between calls, so the lease heartbeat is not starved", async () => {
    const config = tempConfig();
    for (let i = 0; i < 60; i++) pending(config, `c${i}`, { idempotency_key: `k${i}`, recipient: R + i });
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    await recoverPendingPayments(config, chainOf([]) as never, { now: T0 + 60_000 });
    clearInterval(timer);
    assert.ok(ticks > 0, "no timer fired while recovery ran");
  });

  it("recovery gives up on a wallet lock another process keeps", async () => {
    const config = tempConfig();
    pending(config, "c1");
    const c = chainOf([]);
    const held = await acquireWalletLock(storeFor(config, c), 0, "other");
    const t = Date.now();
    const rows = await recoverPendingPayments(config, c, { now: T0 + 60_000, lockWaitMs: 50, lockAttempts: 2, lockPauseMs: 10 } as never);
    held.release();
    assert.deepEqual(rows, []);
    assert.ok(Date.now() - t < 5000);
  });
});

// F-22: a low or lying chain tip must not turn a send into a proof of non-send.

describe("F-22: the chain tip cannot be trusted low", () => {
  const funds = 10_000_000n;

  it("a server tip far below the wallet's own height refuses the send", async () => {
    const config = liveCfg();
    const { chain, counts } = liveChain({ reading: () => ({ walletHeight: 4_500_000, chainTip: 100, spendableZats: funds }) });
    const r = await executePay({ amount_zec: "0.0001", recipient: R }, { config, chain });
    assert.equal(counts.sent, 0);
    assert.equal(r.code, "CHAIN_ERROR");
    assert.match(r.text, /below the wallet's own height/);
  });

  it("a tip below one recorded before refuses the send, even when it agrees with the wallet", async () => {
    const config = liveCfg();
    let reading: ChainHealth = { walletHeight: 1000, chainTip: 1000, spendableZats: funds };
    const { chain, counts } = liveChain({ reading: () => reading });
    assert.equal((await executePay({ amount_zec: "0.0001", recipient: R }, { config, chain })).ok, true);
    assert.equal(storeFor(config, chain).readTipMark(), 1000);
    reading = { walletHeight: 480, chainTip: 480, spendableZats: funds };
    const r = await executePay({ amount_zec: "0.0002", recipient: R }, { config, chain });
    assert.equal(r.code, "CHAIN_ERROR");
    assert.equal(counts.sent, 1, "only the first send went out");
    assert.equal(storeFor(config, chain).readTipMark(), 1000, "the mark never goes down");
  });

  it("a tip reported far above the wallet does not raise the recorded mark far above it", async () => {
    const config = liveCfg();
    config.healthMaxLagBlocks = 10_000;
    const { chain } = liveChain({ reading: () => ({ walletHeight: 1000, chainTip: 9000, spendableZats: funds }) });
    await executePay({ amount_zec: "0.0001", recipient: R }, { config, chain });
    assert.equal(storeFor(config, chain).readTipMark(), 1010);
  });

  it("the recorded anchor is the highest of the server tip, the wallet height, and the mark", async () => {
    const config = liveCfg();
    const { chain } = liveChain({ reading: () => ({ walletHeight: 1005, chainTip: 1000, spendableZats: funds }) });
    const r = await executePay({ amount_zec: "0.0001", recipient: R }, { config, chain });
    const intent = storeFor(config, chain).readCall(JSON.parse(r.text).call_id)?.intent;
    assert.equal(intent?.chain_tip, 1005);
    assert.equal(intent?.wallet_height, 1005);
  });

  it("expiry is measured from the wallet's own height at send time, not only the server's tip", async () => {
    const config = liveCfg();
    pending(config, "c1", { chain_tip: 100, wallet_height: 990 } as Partial<AuditEntry>);
    const early = await recoverPendingPayments(config, chainOf([], { walletHeight: 1100, chainTip: 1101, spendableZats: 0n }), { now: T0 + recovery.RECOVERY_EXPIRY_MS + 1 });
    assert.equal(early[0].status, "not_found", "1100 is past 990 + 40 + margin");
    const config2 = liveCfg();
    pending(config2, "c2", { chain_tip: 100, wallet_height: 990 } as Partial<AuditEntry>);
    const notYet = await recoverPendingPayments(config2, chainOf([], { walletHeight: 1000, chainTip: 1001, spendableZats: 0n }), { now: T0 + recovery.RECOVERY_EXPIRY_MS + 1 });
    assert.equal(notYet[0].status, "unknown", "1000 is not past 990 + 40 + margin");
  });

  it("a server tip below the anchor, or below the wallet, is no proof of expiry", async () => {
    const config = liveCfg();
    pending(config, "c1", { chain_tip: 900, wallet_height: 900 } as Partial<AuditEntry>);
    const late = T0 + recovery.RECOVERY_EXPIRY_MS + 1;
    const low = await recoverPendingPayments(config, chainOf([], { walletHeight: 1100, chainTip: 100, spendableZats: 0n }), { now: late });
    assert.equal(low[0].status, "unknown");
    assert.match(low[0].note, /cannot be trusted/);
    assert.equal(storeFor(config, chainOf([])).readCall("c1")?.state, "unknown");
  });

  it("a server tip below the highest one recorded is no proof of expiry", async () => {
    const config = liveCfg();
    pending(config, "c1", { chain_tip: 900, wallet_height: 900 } as Partial<AuditEntry>);
    storeFor(config, chainOf([])).raiseTipMark(5000);
    const rows = await recoverPendingPayments(config, chainOf([], { walletHeight: 1100, chainTip: 1101, spendableZats: 0n }), { now: T0 + recovery.RECOVERY_EXPIRY_MS + 1 });
    assert.equal(rows[0].status, "unknown");
  });

  it("a call recorded without the wallet's own height cannot be proven expired from its server tip", async () => {
    const config = liveCfg();
    pending(config, "c1", { chain_tip: 100 });
    const rows = await recoverPendingPayments(config, chainOf([], { walletHeight: 5000, chainTip: 5001, spendableZats: 0n }), { now: T0 + recovery.RECOVERY_EXPIRY_MS + 1 });
    assert.equal(rows[0].status, "unknown");
    assert.match(rows[0].note, /without the wallet's own height/);
  });

  it("heights alone never prove expiry: the call must also be old enough", async () => {
    const config = liveCfg();
    pending(config, "c1", { chain_tip: 900, wallet_height: 900 } as Partial<AuditEntry>);
    const rows = await recoverPendingPayments(config, chainOf([], { walletHeight: 5000, chainTip: 5001, spendableZats: 0n }), { now: T0 + 60_000 });
    assert.equal(rows[0].status, "unknown");
  });
});

// F-23: a transaction the wallet marks failed must not replay as a payment.

describe("F-23: failed sends", () => {
  const key = "k-failed";
  function setup() {
    const config = liveCfg();
    let history: TxSummary[] = [];
    const { chain, counts } = liveChain({ history: () => history });
    const asTx = (status: string, extra: Partial<TxSummary> = {}) =>
      ({ txid: tx(77), time: new Date().toISOString(), status, kind: "sent", valueZats: 10000n, outgoing: [{ recipient: R, valueZats: 10000n, memo: "" }], ...extra }) as TxSummary;
    return { config, chain, counts, setHistory: (h: TxSummary[]) => (history = h), asTx };
  }
  const pay = (config: Config, chain: ChainAdapter) => executePay({ amount_zec: "0.0001", recipient: R, idempotency_key: key }, { config, chain });

  it("status records failed, and a replay of the same key reports the failure and sends nothing", async () => {
    const { config, chain, counts, setHistory, asTx } = setup();
    assert.equal((await pay(config, chain)).ok, true);
    setHistory([asTx("failed")]);
    const s = await paymentStatus(config, chain, { idempotency_key: key });
    assert.equal(s.state, "failed");
    assert.equal(s.code, "PAYMENT_FAILED");
    const callId = s.call_id;
    assert.equal(storeFor(config, chain).readCall(callId)?.state, "failed");
    const again = await pay(config, chain);
    assert.equal(again.ok, false);
    assert.equal(again.code, "PAYMENT_FAILED");
    assert.equal(JSON.parse(again.text).txid, tx(77));
    assert.equal(counts.sent, 1, "the key does not send again");
  });

  it("a replay stays failed after the wallet stops listing the transaction", async () => {
    const { config, chain, counts, setHistory, asTx } = setup();
    await pay(config, chain);
    setHistory([asTx("failed")]);
    await paymentStatus(config, chain, { idempotency_key: key });
    setHistory([]);
    const s = await paymentStatus(config, chain, { idempotency_key: key });
    assert.equal(s.state, "failed");
    assert.match(s.message, /failed record stays/);
    assert.equal((await pay(config, chain)).code, "PAYMENT_FAILED");
    assert.equal(counts.sent, 1);
  });

  it("a transaction seen mined later wins over a failed record, and mined is never moved back to failed", async () => {
    const { config, chain, setHistory, asTx } = setup();
    await pay(config, chain);
    setHistory([asTx("failed")]);
    await paymentStatus(config, chain, { idempotency_key: key });
    setHistory([asTx("confirmed", { blockHeight: 1001 })]);
    assert.equal((await paymentStatus(config, chain, { idempotency_key: key })).state, "mined");
    const callId = (await paymentStatus(config, chain, { idempotency_key: key })).call_id;
    assert.equal(storeFor(config, chain).readCall(callId)?.state, "mined");
    setHistory([asTx("failed")]);
    const s = await paymentStatus(config, chain, { idempotency_key: key });
    assert.equal(s.state, "mined");
    assert.equal(storeFor(config, chain).readCall(callId)?.state, "mined");
    const replay = await pay(config, chain);
    assert.equal(replay.ok, true);
  });

  it("a wallet that has not marked it failed leaves the replay as the original success", async () => {
    const { config, chain, counts, setHistory, asTx } = setup();
    await pay(config, chain);
    setHistory([asTx("mempool")]);
    assert.equal((await paymentStatus(config, chain, { idempotency_key: key })).state, "broadcast");
    const r = await pay(config, chain);
    assert.equal(r.ok, true);
    assert.equal(counts.sent, 1);
  });
});
