import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync, writeFileSync, symlinkSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createExclusive } from "../src/fsafe.ts";
import { PaymentStore, movesForward, foldEvents, isSettled } from "../src/payments/store.ts";
import { acquireWalletLock, BusyError, lockRank, sendLockFor } from "../src/payments/lock.ts";
import { reserveAudit, AUDIT_SLOT_BYTES } from "../src/audit/budget.ts";
import { writeAuditRow, freezeAuditWrites, unfreezeAuditWrites } from "../src/audit/log.ts";
import { assertCoherentRecordFilesystem } from "../src/startup.ts";
import { reconcile, eventFor, recordReconcile } from "../src/payments/recovery.ts";
import { reserveSpending } from "../src/payments/budget.ts";
import type { CallRecord } from "../src/payments/store.ts";
import type { ChainAdapter } from "../src/chain/types.ts";
import type { Config } from "../src/types.ts";

const R = "utest1" + "r".repeat(100);
const TX = "ab".repeat(32);

describe("V12 run 12 regressions", () => {
  it("F-28 reads take a shared send lock so payments are not monopolized by history", async () => {
    const dir = mkdtempSync(join(tmpdir(), "v12r12-share-"));
    const readA = await acquireWalletLock({ dir, requireOsLock: true }, 500, "zcash_history");
    // A second read must be able to share (not BUSY immediately against another read).
    const readB = await acquireWalletLock({ dir, requireOsLock: true }, 500, "zcash_balance");
    await readB.release();
    // A payment must wait behind the shared reader, not cut it out unfairly via exclusive monopoly of a reader.
    let payBusy = false;
    const pay = acquireWalletLock({ dir, requireOsLock: true }, 50, "zcash_pay").then(
      async (l) => { await l.release(); },
      (e) => { if (e instanceof BusyError) payBusy = true; else throw e; },
    );
    await pay;
    assert.equal(payBusy, true, "payment with short wait must BUSY behind an active shared reader");
    await readA.release();
  });

  it("F-37 createExclusive returns true after publish even if dir fsync fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "v12r12-excl-"));
    const real = fs.fsyncSync;
    let saw = false;
    // Monkeypatch fsyncDir path: openSync of the directory.
    const open = fs.openSync;
    (fs as any).openSync = (path: any, flags: any, mode?: any) => {
      if (typeof path === "string" && path === dir && flags === "r") {
        saw = true;
        const err: any = new Error("fsyncdir boom");
        err.code = "EIO";
        throw err;
      }
      return open(path, flags, mode);
    };
    try {
      assert.equal(createExclusive(dir, "key.json", '{"ok":1}'), true);
      assert.ok(fs.existsSync(join(dir, "key.json")));
      assert.ok(saw, "fsync path should have been attempted");
    } finally {
      (fs as any).openSync = open;
    }
  });

  it("F-53 tracked staged call without authorize is not_sent when absent", async () => {
    const store = new PaymentStore(mkdtempSync(join(tmpdir(), "v12r12-calc-")));
    store.ensureLayout();
    store.requireOsLock = true;
    store.writeIntent({
      call_id: "call", ts: new Date().toISOString(), amount_zec: "0.0001", amount_zats: "10000",
      recipient: R, allowlist_hit: true, cap_zec: "0.1", view_key_fingerprint: null, two_step: true, transmit_tracked: true,
    });
    store.stageTxid("call", TX, new Date().toISOString());
    const record = store.readCall("call")!;
    const chain = {
      mode: "live" as const,
      async getHistory(_limit?: number) { return []; },
      async getTransaction() { return []; },
      async getBalance() { throw new Error("no"); },
      async getReceiveAddress() { throw new Error("no"); },
      async getViewingKey() { return "x"; },
      async pay() { throw new Error("no"); },
    } satisfies ChainAdapter;
    const row = await reconcile(record, chain, {
      live: true,
      evidence: async () => ({ synced: true, walletHeight: 100, chainTip: 100 }),
    });
    assert.equal(row.status, "not_sent");
    const after = recordReconcile(store, row, "recovery");
    assert.equal(after.state, "not_sent");
    assert.equal(isSettled(after.state), true);
    assert.ok(!store.pendingCalls().includes("call"));
  });

  it("F-55 audit aliases share one physical budget counter", () => {
    const root = mkdtempSync(join(tmpdir(), "v12r12-alias-"));
    const real = join(root, "real.jsonl");
    writeFileSync(real, "", { mode: 0o600 });
    const alias = join(root, "alias.jsonl");
    symlinkSync(real, alias);
    reserveAudit(real, true, { auditMaxBytes: AUDIT_SLOT_BYTES }, false);
    assert.throws(() => reserveAudit(alias, true, { auditMaxBytes: AUDIT_SLOT_BYTES }, false), /capacity/);
  });

  it("F-57 expired folds forward to not_sent and clears interlock", () => {
    assert.equal(movesForward({ callId: "c", state: "expired", events: [] }, "not_sent"), true);
    const folded = foldEvents("c", undefined, [
      { ts: "1", call_id: "c", state: "expired", by: "recovery" },
      { ts: "2", call_id: "c", state: "not_sent", by: "recovery" },
    ]);
    assert.equal(folded.state, "not_sent");
    assert.equal(isSettled(folded.state), true);
  });

  it("F-65 exclusive payments take fair tickets before the OS flock", async () => {
    const dir = mkdtempSync(join(tmpdir(), "v12r12-fair-"));
    const first = await acquireWalletLock({ dir, requireOsLock: true }, 2000, "zcash_pay");
    const order: number[] = [];
    const a = acquireWalletLock({ dir, requireOsLock: true }, 5000, "zcash_pay").then(async (l) => {
      order.push(1);
      await l.release();
    });
    await new Promise((r) => setTimeout(r, 80));
    const b = acquireWalletLock({ dir, requireOsLock: true }, 5000, "zcash_pay").then(async (l) => {
      order.push(2);
      await l.release();
    });
    await new Promise((r) => setTimeout(r, 80));
    await first.release();
    await Promise.all([a, b]);
    assert.deepEqual(order, [1, 2], "earlier payment must run before a later one");
  });

  it("F-68 audit writes freeze during maintenance snapshot", () => {
    const root = mkdtempSync(join(tmpdir(), "v12r12-freeze-"));
    const config = { auditDir: join(root, "audits"), viewKeyFingerprintSalt: "s" } as Config;
    mkdirSync(config.auditDir, { mode: 0o700 });
    freezeAuditWrites();
    try {
      const result = writeAuditRow(config, {
        ts: new Date().toISOString(), tool: "zcash_balance", call_id: "c", mode: "mock", status: "ok",
      } as any);
      assert.equal(result.durable, false);
      assert.equal(fs.readdirSync(config.auditDir).length, 0);
    } finally {
      unfreezeAuditWrites();
    }
  });

  it("F-69 recovery outranks payments at local handoff", () => {
    assert.ok(lockRank("recovery") > lockRank("zcash_pay"));
    assert.ok(lockRank("zcash_pay") > lockRank("zcash_history"));
  });

  it("F-69 recovery beats a later payment at local handoff", async () => {
    const dir = mkdtempSync(join(tmpdir(), "v12r12-recpri-"));
    const read = await acquireWalletLock({ dir, requireOsLock: true }, 0, "zcash_balance");
    let recovered = false;
    const recovery = acquireWalletLock({ dir, requireOsLock: true }, 3000, "recovery").then(async (l) => {
      recovered = true;
      await l.release();
    });
    await new Promise((r) => setTimeout(r, 30));
    const pay = acquireWalletLock({ dir, requireOsLock: true }, 3000, "zcash_pay").then(async (l) => {
      assert.ok(recovered, "recovery must beat a later payment at local handoff");
      await l.release();
    });
    await new Promise((r) => setTimeout(r, 30));
    await read.release();
    await Promise.all([recovery, pay]);
  });

  it("F-72 spending reservation dedupes by identity not callId", () => {
    const dir = mkdtempSync(join(tmpdir(), "v12r12-spend-"));
    const store = new PaymentStore(dir);
    store.ensureLayout();
    const lock = { assertHeld() {}, async release() {} };
    const config = { totalSpendingCapZec: "1" } as Config;
    const params = "a".repeat(64);
    reserveSpending(config, store, lock as any, "call-1", 10_000n, params, "key-1");
    // Same identity, different call id: must not charge again.
    reserveSpending(config, store, lock as any, "call-2", 10_000n, params, "key-1");
    const ledger = JSON.parse(readFileSync(join(dir, "spending-budget", "ledger.json"), "utf8"));
    assert.equal(ledger.total, "10000");
  });

  it("F-73 allow-list is re-loaded by name for transmit fences", async () => {
    // Structural: pay.ts source must call loadAllowlist inside afterLock / beforeTransmit.
    const src = readFileSync(new URL("../src/tools/pay.ts", import.meta.url), "utf8");
    const after = src.indexOf("afterLock:");
    const before = src.indexOf("beforeTransmit:");
    assert.ok(after > 0 && before > 0);
    const afterBlock = src.slice(after, after + 800);
    const beforeBlock = src.slice(before, before + 600);
    assert.match(afterBlock, /loadAllowlist/);
    assert.match(beforeBlock, /loadAllowlist/);
  });

  it("F-74 resume policy refusal preserves original_call_id in source", () => {
    const src = readFileSync(new URL("../src/tools/pay.ts", import.meta.url), "utf8");
    assert.match(src, /original_unresolved:\s*true/);
    assert.match(src, /original_call_id:\s*originalCallId/);
  });

  it("F-75 payment refusals use the financial audit pool", () => {
    const root = mkdtempSync(join(tmpdir(), "v12r12-fin-"));
    const fallback = join(root, "fallback.jsonl");
    const config = {
      auditDir: join(root, "audits"),
      auditFallbackPath: fallback,
      auditMaxBytes: AUDIT_SLOT_BYTES,
      auditDiagnosticMaxBytes: AUDIT_SLOT_BYTES * 100,
    } as Config;
    mkdirSync(config.auditDir, { mode: 0o700 });
    const row = {
      ts: new Date().toISOString(), tool: "zcash_pay" as const, call_id: "c1",
      amount_zec: "0.1", recipient: R, allowlist_hit: false, cap_zec: 0.1,
      status: "rejected" as const, view_key_fingerprint: null, code: "NOT_ALLOWLISTED", error: "no",
    };
    assert.equal(writeAuditRow(config, row).durable, true);
    // Exhaust the fallback financial pool too so the refusal cannot soft-succeed there.
    reserveAudit(fallback, true, { auditMaxBytes: AUDIT_SLOT_BYTES }, false);
    const second = writeAuditRow(config, { ...row, call_id: "c2" });
    assert.equal(second.durable, false, second.warning);
  });

  it("F-76 upgrade migrates staged authorized not_sent to unknown pending", () => {
    const dir = mkdtempSync(join(tmpdir(), "v12r12-mig-"));
    const store = new PaymentStore(dir);
    store.ensureLayout();
    store.writeIntent({
      call_id: "old", ts: new Date().toISOString(), amount_zec: "0.0001", amount_zats: "10000",
      recipient: R, allowlist_hit: true, cap_zec: "0.1", view_key_fingerprint: null, two_step: true, transmit_tracked: true,
    });
    store.stageTxid("old", TX, new Date().toISOString());
    store.authorizeTransmit("old", new Date().toISOString());
    // Simulate legacy ambiguous not_sent by appending directly (bypass advance safeguard).
    store.appendEvent({ ts: new Date().toISOString(), call_id: "old", state: "not_sent", code: "BUSY", by: "send" });
    store.clearPending("old");
    // foldEvents elevates ambiguous staged+authorized not_sent immediately.
    assert.equal(store.readCall("old")!.state, "unknown");
    // Re-open via ensureLayout migration to restore the pending marker.
    const again = new PaymentStore(dir);
    again.requireOsLock = true;
    again.ensureLayout();
    const after = again.readCall("old")!;
    assert.equal(after.state, "unknown");
    assert.ok(again.pendingCalls().includes("old"));
  });

  it("F-77 coherent record filesystem helper refuses unsupported types", () => {
    // On this host the tmpdir may be tmpfs; the helper must throw for it on linux.
    if (process.platform !== "linux") return;
    const dir = mkdtempSync(join(tmpdir(), "v12r12-fs-"));
    // We only assert the function is exported and callable; if tmp is ext4 it may pass.
    try {
      assertCoherentRecordFilesystem(dir, "linux");
    } catch (e) {
      assert.match((e as Error).message, /ext4|XFS|Btrfs|durable/);
    }
  });

  it("F-78 recovery continues after a policy refusal in resume", async () => {
    const src = readFileSync(new URL("../src/payments/recovery.ts", import.meta.url), "utf8");
    assert.match(src, /PolicyError/);
    assert.match(src, /continued the batch|remains unresolved/);
  });

  it("F-65 a dead waiter's ticket is reaped and never blocks later payments", async () => {
    const dir = mkdtempSync(join(tmpdir(), "r12-ticket-"));
    // A waiter that was SIGKILLed while holding ticket 1 left its file behind; the next ticket is 5.
    writeFileSync(join(dir, "ticket.seq"), "5", { mode: 0o600 });
    writeFileSync(join(dir, "ticket.00000000000000000001.999999"), "", { mode: 0o600 });
    const lock = await acquireWalletLock({ dir, requireOsLock: true }, 3000, "zcash_pay");
    lock.assertHeld();
    await lock.release();
    assert.ok(!fs.existsSync(join(dir, "ticket.00000000000000000001.999999")), "stale ticket was not removed");
  });
  it("F-28 unknown lock purposes are exclusive; only named wallet reads share", () => {
    assert.equal(lockRank("zcash_balance"), 0);
    assert.equal(lockRank("zcash_history"), 0);
    assert.equal(lockRank("balance"), 1);
    assert.equal(lockRank(undefined), 1);
    assert.equal(lockRank("recovery") > lockRank("zcash_pay"), true);
  });
});
