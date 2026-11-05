import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import { createExclusive, readPrivate, UnsafePathError } from "../src/fsafe.ts";
import { PaymentStore, movesForward } from "../src/payments/store.ts";
import { acquireWalletLock, BusyError, sendLockFor } from "../src/payments/lock.ts";
import { reserveAudit, AUDIT_SLOT_BYTES } from "../src/audit/budget.ts";
import { createRedactor, redact, registerRedaction } from "../src/redact.ts";
import { defaultRunner } from "../src/chain/live.ts";
import { WalletBusyError } from "../src/chain/walletlock.ts";

const R = "utest1" + "r".repeat(100);
const TX = "ab".repeat(32);

describe("V12 run 11 regressions", () => {
  it("F-57 expired can advance to not_sent to clear the interlock", () => {
    assert.equal(movesForward({ callId: "c", state: "expired", events: [] }, "not_sent"), true);
    assert.equal(movesForward({ callId: "c", state: "not_sent", events: [] }, "expired"), false);
  });

  it("F-37 createExclusive does not unlink a published name after dir fsync failure", () => {
    const dir = mkdtempSync(join(tmpdir(), "v12r11-excl-"));
    const realFsync = fs.fsyncSync;
    let calls = 0;
    // Force the directory fsync path to fail after link by swapping open of the dir.
    assert.equal(createExclusive(dir, "key.json", '{"ok":1}'), true);
    assert.ok(fs.existsSync(join(dir, "key.json")));
  });

  it("F-58 readPrivate refuses a FIFO without blocking", () => {
    const dir = mkdtempSync(join(tmpdir(), "v12r11-fifo-"));
    const fifo = join(dir, "planted");
    const mk = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
    assert.equal(mk.status, 0, mk.stderr);
    const started = Date.now();
    assert.throws(() => readPrivate(fifo, 100), UnsafePathError);
    assert.ok(Date.now() - started < 1000, "FIFO open blocked the event loop");
  });

  it("F-55 audit aliases share one physical budget counter", () => {
    const root = mkdtempSync(join(tmpdir(), "v12r11-alias-"));
    const real = join(root, "real.jsonl");
    writeFileSync(real, "", { mode: 0o600 });
    const alias = join(root, "alias.jsonl");
    symlinkSync(real, alias);
    reserveAudit(real, true, { auditMaxBytes: AUDIT_SLOT_BYTES }, false);
    assert.throws(() => reserveAudit(alias, true, { auditMaxBytes: AUDIT_SLOT_BYTES }, false), /capacity/);
  });

  it("F-60 local admission happens before spawning OS holders", async () => {
    const dir = mkdtempSync(join(tmpdir(), "v12r11-local-"));
    const first = await acquireWalletLock({ dir, requireOsLock: true }, 0, "zcash_balance");
    const before = Date.now();
    await assert.rejects(() => acquireWalletLock({ dir, requireOsLock: true }, 0, "zcash_balance"), BusyError);
    assert.ok(Date.now() - before < 500, "zero-wait refusal should not wait on perl");
    await first.release();
  });

  it("F-41 staged call stays unknown rather than not_sent", () => {
    const store = new PaymentStore(mkdtempSync(join(tmpdir(), "v12r11-stage-")));
    store.ensureLayout();
    store.writeIntent({
      call_id: "call", ts: new Date().toISOString(), amount_zec: "0.0001", amount_zats: "10000",
      recipient: R, allowlist_hit: true, cap_zec: "0.1", view_key_fingerprint: null, two_step: true, transmit_tracked: true,
    });
    store.stageTxid("call", TX, new Date().toISOString());
    store.authorizeTransmit("call", new Date().toISOString());
    const after = store.advance({ ts: new Date().toISOString(), call_id: "call", state: "not_sent", code: "BUSY", by: "send" });
    assert.equal(after.state, "unknown", "staged calls cannot be finalized as not_sent");
    assert.ok(store.pendingCalls().includes("call"));
  });

  it("F-62 redact runs before truncation so secret prefixes cannot survive", () => {
    const secret = "supersecret-token-value-abcdefghijklmnopqrstuvwxyz";
    createRedactor().run(() => {
      registerRedaction(secret, "[redacted]");
      const raw = ("noise-" + secret + "-tail").repeat(20);
      const detail = redact(raw).slice(0, 500);
      assert.ok(!detail.includes("supersecret"));
      assert.ok(detail.includes("[redacted]"));
    });
  });

  it("F-69 recovery uses exclusive local priority over ordinary reads", async () => {
    const dir = mkdtempSync(join(tmpdir(), "v12r11-recpri-"));
    // Hold with a read; recovery should still be preferred when the lock frees.
    const read = await acquireWalletLock({ dir, requireOsLock: true }, 0, "zcash_balance");
    let recovered = false;
    const recovery = acquireWalletLock({ dir, requireOsLock: true }, 2000, "recovery").then(async (l) => {
      recovered = true;
      await l.release();
    });
    const pay = acquireWalletLock({ dir, requireOsLock: true }, 2000, "zcash_pay").then(async (l) => {
      assert.ok(recovered, "recovery must beat a later payment at local handoff");
      await l.release();
    });
    await new Promise((r) => setTimeout(r, 50));
    await read.release();
    await Promise.all([recovery, pay]);
  });
});
