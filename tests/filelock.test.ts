import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { acquireFileLock, WALLET_LOCK_FILE } from "../src/payments/filelock.ts";
import { BusyError } from "../src/payments/lock.ts";
import { LiveChainAdapter } from "../src/chain/live.ts";
import { resetPaymentStores as resetPaymentIndexes } from "../src/payments/store.ts";
import { executePay } from "../src/tools/pay.ts";
import type { CliRunner } from "../src/chain/live.ts";
import { readAuditRows, tempConfig, withUfvk } from "./helpers.ts";

const dir = () => mkdtempSync(join(tmpdir(), "zshield-lock-"));
const lockPath = (d: string) => join(d, WALLET_LOCK_FILE);
const deadPid = () => spawnSync(process.execPath, ["-e", "0"]).pid!;

describe("wallet lock file", () => {
  it("is created with mode 0600 and the holder's pid, and removed on release", async () => {
    const d = dir();
    const lease = await acquireFileLock(d, { waitMs: 0, purpose: "test" });
    const release = () => lease.release();
    const info = JSON.parse(readFileSync(lockPath(d), "utf8"));
    assert.equal(info.pid, process.pid);
    assert.equal(info.host, hostname());
    assert.equal(info.purpose, "test");
    if (process.platform !== "win32") assert.equal(statSync(lockPath(d)).mode & 0o777, 0o600);
    release();
    assert.equal(existsSync(lockPath(d)), false);
  });

  it("refuses a second holder with BusyError, then admits it after release", async () => {
    const d = dir();
    const lease = await acquireFileLock(d, { waitMs: 0, purpose: "first" });
    const release = () => lease.release();
    await assert.rejects(acquireFileLock(d, { waitMs: 0, purpose: "second" }), (e) => e instanceof BusyError && /pid \d+, first/.test(e.message));
    release();
    (await acquireFileLock(d, { waitMs: 0, purpose: "second" })).release();
  });

  it("waits up to waitMs for the holder to let go", async () => {
    const d = dir();
    const lease = await acquireFileLock(d, { waitMs: 0, purpose: "first" });
    const release = () => lease.release();
    setTimeout(() => lease.release(), 150);
    const t = Date.now();
    (await acquireFileLock(d, { waitMs: 2000, purpose: "second" })).release();
    assert.ok(Date.now() - t >= 100);
  });

  it("breaks a lock whose process is gone", async () => {
    const d = dir();
    writeFileSync(lockPath(d), JSON.stringify({ pid: deadPid(), host: hostname(), started: new Date().toISOString(), purpose: "zcash_pay", token: "x" }), { mode: 0o600 });
    const lease = await acquireFileLock(d, { waitMs: 0, purpose: "after crash" });
    const release = () => lease.release();
    assert.equal(JSON.parse(readFileSync(lockPath(d), "utf8")).pid, process.pid);
    release();
  });

  it("breaks a lock whose lease was not renewed, even if its pid is alive", async () => {
    const d = dir();
    const old = new Date(Date.now() - 31 * 60_000).toISOString();
    writeFileSync(lockPath(d), JSON.stringify({ pid: process.pid, host: hostname(), started: old, purpose: "zcash_pay", token: "x" }));
    const past = new Date(Date.now() - 120_000);
    utimesSync(lockPath(d), past, past);
    (await acquireFileLock(d, { waitMs: 0, purpose: "t" })).release();
  });

  it("keeps a fresh lock from another host, whose pid cannot be checked here", async () => {
    const d = dir();
    writeFileSync(lockPath(d), JSON.stringify({ pid: deadPid(), host: "other-host", started: new Date().toISOString(), purpose: "zcash_pay", token: "x" }));
    await assert.rejects(acquireFileLock(d, { waitMs: 0, purpose: "t" }), BusyError);
  });

  it("keeps an unreadable lock while it is young and breaks it once old", async () => {
    const d = dir();
    writeFileSync(lockPath(d), "");
    await assert.rejects(acquireFileLock(d, { waitMs: 0, purpose: "t" }), BusyError);
    const past = new Date(Date.now() - 120_000);
    utimesSync(lockPath(d), past, past);
    (await acquireFileLock(d, { waitMs: 0, purpose: "t" })).release();
  });

  it("release leaves alone a lock that is no longer this one", async () => {
    const d = dir();
    const lease = await acquireFileLock(d, { waitMs: 0, purpose: "t" });
    const release = () => lease.release();
    writeFileSync(lockPath(d), JSON.stringify({ pid: 1, host: "other-host", started: new Date().toISOString(), purpose: "x", token: "y" }));
    release();
    assert.equal(existsSync(lockPath(d)), true);
  });

  it("is shared with another process on the same wallet", async () => {
    const d = dir();
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "-e",
        `import("${new URL("../src/payments/filelock.ts", import.meta.url).pathname}").then(async (m) => { const r = await m.acquireFileLock(${JSON.stringify(d)}, { waitMs: 0, purpose: "child" }); console.log("held"); setTimeout(() => { r.release(); process.exit(0); }, 600); });`,
      ],
      { stdio: ["ignore", "pipe", "inherit"] }
    );
    await new Promise<void>((res) => child.stdout.on("data", (b) => String(b).includes("held") && res()));
    await assert.rejects(acquireFileLock(d, { waitMs: 0, purpose: "parent" }), /pid \d+, child/);
    (await acquireFileLock(d, { waitMs: 10_000, purpose: "parent" })).release();
    await new Promise((r) => child.on("exit", r));
  });

  it("a send refused because another process holds the wallet sends nothing and writes no pending row", async () => {
    resetPaymentIndexes();
    const d = dir();
    writeFileSync(lockPath(d), JSON.stringify({ pid: process.pid, host: hostname(), started: new Date().toISOString(), purpose: "other process", token: "z" }));
    let sends = 0;
    const runner: CliRunner = async () => {
      sends++;
      return '{"txids":["' + "a".repeat(64) + '"]}';
    };
    const chain = new LiveChainAdapter({ network: "testnet", runner: withUfvk(runner), dataDir: d, stateDir: d });
    const R = "utest1" + "s".repeat(100);
    const allow = join(d, "allow.json");
    writeFileSync(allow, JSON.stringify({ recipients: [{ address: R }] }));
    const config = tempConfig({ chainMode: "live", allowlistPath: allow, sendQueueWaitMs: 200 });
    const res = await executePay({ amount_zec: "0.0001", recipient: R }, { config, chain });
    assert.equal(res.code, "BUSY");
    assert.match(res.text, /Another zshield-mcp process holds the wallet lock/);
    assert.equal(sends, 0);
    assert.deepEqual(readAuditRows(config).map((r) => r.status), ["error"]);
  });
});

describe("read tools while another process holds the wallet", () => {
  it("read the wallet file offline instead of starting a sync that would race the send", async () => {
    const { executeBalance } = await import("../src/tools/balance.ts");
    const { executeHistory } = await import("../src/tools/history.ts");
    const { executeReceiveAddress } = await import("../src/tools/address.ts");
    const d = dir();
    const calls: string[][] = [];
    const runner: CliRunner = async (_b, args) => {
      calls.push(args);
      const cmd = args.at(-1);
      if (cmd === "balance") return '{"confirmed_orchard_balance": 5, "confirmed_sapling_balance": 0, "confirmed_transparent_balance": 0, "unconfirmed_orchard_balance": 0, "unconfirmed_sapling_balance": 0, "unconfirmed_transparent_balance": 0}';
      if (cmd === "spendable_balance") return '{"spendable_balance": 5}';
      if (cmd === "transactions") return "[]";
      if (cmd === "addresses") return '[{"encoded_address": "utest1' + "q".repeat(100) + '"}]';
      throw new Error(cmd);
    };
    const chain = new LiveChainAdapter({ network: "testnet", runner, dataDir: d, stateDir: d });
    const config = tempConfig({ chainMode: "live" });
    const busy = () => writeFileSync(lockPath(d), JSON.stringify({ pid: process.pid, host: hostname(), started: new Date().toISOString(), purpose: "zcash_pay", token: "b" }));
    busy();
    await executeBalance({ config, chain });
    await executeHistory({}, { config, chain });
    await executeReceiveAddress({ config, chain });
    assert.ok(calls.length >= 3);
    assert.ok(calls.every((a) => a.includes("--offline") && !a.includes("--server")), JSON.stringify(calls));
    // Free wallet: the normal online read, under the lock, which is released after.
    calls.length = 0;
    const { rmSync } = await import("node:fs");
    rmSync(lockPath(d));
    await executeBalance({ config, chain });
    assert.ok(calls.every((a) => a.includes("--server")));
    assert.equal(existsSync(lockPath(d)), false);
  });
});
