// The wallet lock (V12 F-14, F-38): one OS lock held by the paying process for the whole send,
// stage and transmit, and released only when it finishes or dies.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { acquireWalletLock, BusyError } from "../../src/payments/lock.ts";
import { commands, killGroup, pauseFile, proc, sends, sleep, until, world } from "./helpers.ts";

const LOCK_DRIVER = fileURLToPath(new URL("./fixtures/lock-driver.mts", import.meta.url));
const TSX = import.meta.resolve("tsx");

function holder(dir: string, holdMs: number) {
  const child = spawn(process.execPath, ["--import", TSX, LOCK_DRIVER, dir, String(holdMs)], { detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ZSHIELD_LOCK_LEASE_MS: "1000" } });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  return { child, acquired: () => until(() => out.includes("acquired"), "the holder to take the lock") };
}

describe("wallet lock", { timeout: 180_000 }, () => {
  it("no_two_zingo_processes: payers and readers on one wallet never run two zingo-cli at once", async () => {
    const w = world();
    const env = { SEND_QUEUE_WAIT_MS: "60000", ZINGO_READ_TIMEOUT_MS: "60000", ZINGO_HEALTH_TIMEOUT_MS: "60000" };
    const payers = ["k1", "k2", "k3", "k4"].map((k, i) => proc(w, `p${i}`, ["pay", k, `0.00${i + 1}`], env).done);
    const all = await Promise.all(payers);
    const reads = await Promise.all([0, 1].map((i) => proc(w, `r${i}`, ["reads", "4"], env).done));
    assert.deepEqual(all.map((r) => r.status), ["ok", "ok", "ok", "ok"], JSON.stringify(all.map((r) => r.code)));
    assert.equal(sends(w).length, 4);
    assert.ok(reads.every((r) => Array.isArray(r.codes)));
  });

  for (const [point, label] of [
    ["fence1", "before the build"],
    ["fence2", "before the transmit"],
  ] as const) {
    it(`F-14 a holder frozen ${label} keeps the lock: nobody else sends, and it sends once when it wakes`, async () => {
      const w = world();
      const p = pauseFile(w, `pause-${point}`);
      const a = proc(w, "a", ["pay", "inv-2a"], { PAUSE_AT: point, PAUSE_FILE: p.f });
      await until(p.reached, `A to reach ${point}`);
      killGroup(a.child, "SIGSTOP");
      await sleep(1600); // longer than the old 1 s lease, which no longer exists
      const b = proc(w, "b", ["pay", "inv-2b"], { SEND_QUEUE_WAIT_MS: "1500" });
      const rb = await b.done;
      assert.equal(rb.code, "BUSY", `B must not send while A holds the lock: ${JSON.stringify(rb).slice(0, 300)}`);
      assert.equal(commands(w).filter((c) => c.ppid === b.child.pid).length, 0, "B started a wallet process while A held the lock");
      const frozenSends = sends(w).length;
      assert.ok(frozenSends <= 0, `${frozenSends} transmits while A was frozen before its transmit`);
      p.go();
      killGroup(a.child, "SIGCONT");
      const ra = await a.done;
      assert.equal(ra.status, "ok", JSON.stringify(ra).slice(0, 300));
      assert.equal(sends(w).length, 1, "exactly one payment on the chain");
    });
  }

  it("F-14 a live holder that stalls is never replaced by a timer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zshield-inv-lock-"));
    const h = holder(dir, 60_000);
    try {
      await h.acquired();
      killGroup(h.child, "SIGSTOP");
      await sleep(2500); // far past the 1 s lease the old code could be told to use
      process.env.ZSHIELD_LOCK_LEASE_MS = "1000";
      await assert.rejects(() => acquireWalletLock({ dir, requireOsLock: true }, 0, "inv-waiter"), (e) => e instanceof BusyError);
    } finally {
      killGroup(h.child, "SIGCONT");
      killGroup(h.child, "SIGKILL");
    }
  });

  it("the lock goes the moment its holder is killed, with no stale-lock wait", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zshield-inv-lock-"));
    const h = holder(dir, 60_000);
    await h.acquired();
    killGroup(h.child, "SIGKILL");
    const started = Date.now();
    const lock = await acquireWalletLock({ dir, requireOsLock: true }, 5000, "inv-after-kill");
    assert.ok(Date.now() - started < 3000, "taking the lock after the holder died was slow");
    await lock.release();
  });

  it("a second holder in one process waits its turn, then gets the lock", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zshield-inv-lock-"));
    const first = await acquireWalletLock({ dir, requireOsLock: true }, 0, "first");
    const second = acquireWalletLock({ dir, requireOsLock: true }, 5000, "second");
    await sleep(200);
    await first.release();
    const lock = await second;
    lock.assertHeld();
    await lock.release();
    await assert.rejects(async () => lock.assertHeld(), /lock/i);
  });

  it("F-38 no read runs between stage and transmit: reads are BUSY while a send holds the lock, and work after", async () => {
    const w = world();
    const p = pauseFile(w, "pause-gap");
    const a = proc(w, "a", ["pay", "inv-4"], { PAUSE_AT: "fence2", PAUSE_FILE: p.f });
    await until(p.reached, "A to finish staging");
    const reader = await proc(w, "r", ["reads", "1"], { STATUS_KEY: "inv-4" }).done;
    assert.deepEqual(reader.codes, ["BUSY", "BUSY", "BUSY", "BUSY"], "balance, address, history and status must all be BUSY");
    p.go();
    const ra = await a.done;
    assert.equal(ra.status, "ok", JSON.stringify(ra));
    const log = commands(w);
    const calc = log.findIndex((c) => c.cmd === "calculate");
    const tx = log.findIndex((c) => c.cmd === "transmit");
    assert.ok(calc >= 0 && tx > calc, `expected calculate then transmit: ${JSON.stringify(log.map((c) => c.cmd))}`);
    const between = log.slice(calc + 1, tx).filter((c) => c.ppid !== a.child.pid);
    assert.equal(between.length, 0, `another process ran [${between.map((c) => c.cmd).join(", ")}] between calculate and transmit`);
    const after = await proc(w, "r2", ["reads", "1"], { STATUS_KEY: "inv-4" }).done;
    assert.deepEqual(after.codes, ["ok", "ok", "ok", "ok"], "reads work once the send is done");
  });

  it("a send whose lock holder dies stops before it builds anything", async () => {
    const w = world();
    const p = pauseFile(w, "pause-lost");
    const a = proc(w, "a", ["pay", "inv-lost"], { PAUSE_AT: "fence1", PAUSE_FILE: p.f });
    await until(p.reached, "A to reach its first fence");
    const holderPid = execFileSync("pgrep", ["-P", String(a.child.pid), "perl"]).toString().trim().split("\n")[0];
    assert.ok(holderPid, "the paying process has a lock holder child");
    process.kill(Number(holderPid), "SIGKILL");
    await sleep(300);
    p.go();
    const ra = await a.done;
    assert.equal(ra.code, "BUSY", JSON.stringify(ra).slice(0, 300));
    assert.equal(sends(w).length, 0, "nothing may be transmitted after the lock is lost");
  });
});
