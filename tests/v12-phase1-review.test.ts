import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { describe, it, mock } from "node:test";
import { checkServerUrl } from "../src/config.ts";
import { createRedactor, displayUrl, redact, registerServerUrl } from "../src/redact.ts";
import { reserveAudit, AUDIT_SLOT_BYTES } from "../src/audit/budget.ts";
import { LiveChainAdapter, defaultRunner } from "../src/chain/live.ts";
import { WalletBusyError } from "../src/chain/walletlock.ts";
import { withWalletRead } from "../src/tools/read.ts";
import { acquireWalletLock, BusyError } from "../src/payments/lock.ts";
import { PaymentStore } from "../src/payments/store.ts";
import { reconcile } from "../src/payments/recovery.ts";
import { withReadBudget, withOperationBudget, WALLET_READ_BUDGET_MS, LIVE_PAYMENT_READ_WAIT_MS } from "../src/chain/read-budget.ts";
import type { ChainAdapter } from "../src/chain/types.ts";

const TX = "ab".repeat(32), R = "utest1" + "r".repeat(100);
function staged(tracked: boolean, authorized = false) {
  const store = new PaymentStore(fs.mkdtempSync(join(tmpdir(), "review-stage-")));
  store.ensureLayout();
  store.writeIntent({ call_id: "call", ts: new Date().toISOString(), amount_zec: "0.0001", amount_zats: "10000", recipient: R, allowlist_hit: true, cap_zec: "0.1", view_key_fingerprint: null, two_step: true, transmit_tracked: tracked });
  store.stageTxid("call", TX, new Date().toISOString());
  if (authorized) store.authorizeTransmit("call", new Date().toISOString());
  return store;
}
const absent = { getTransaction: async () => [], getHistory: async () => [] } as unknown as ChainAdapter;
const opts = { live: true, evidence: async () => ({ synced: false }) };

describe("Phase 1 follow-up regressions", () => {
  it("327841 restart recovers a staged call before transmit authorization, without consulting chain absence", async () => {
    const store = staged(true);
    const restarted = new PaymentStore(store.dir);
    const row = await reconcile(restarted.readCall("call")!, absent, opts);
    assert.equal(row.status, "not_sent");
  });
  it("327841 authorization crash and legacy calculated/absent entries remain ambiguous", async () => {
    // Authorized+absent and legacy untracked+absent stay unknown (no local non-broadcast proof).
    for (const store of [staged(true, true), staged(false)]) {
      assert.equal((await reconcile(store.readCall("call")!, absent, opts)).status, "unknown");
    }
    // Tracked without authorize is local not_sent (F-53). Authorized calculated stays unknown/resumable.
    const calculated = {
      getTransaction: async () => [{ txid: TX, kind: "sent", status: "calculated", valueZats: 10000n, verified: true, outgoing: [{ recipient: R, valueZats: 10000n, memo: "" }] }],
      getHistory: async () => [],
    } as unknown as ChainAdapter;
    assert.equal((await reconcile(staged(true, false).readCall("call")!, calculated, opts)).status, "not_sent");
    assert.equal((await reconcile(staged(true, true).readCall("call")!, calculated, opts)).status, "unknown");
  });
  it("327841 adapter fences before authorization and WalletBusyError remains proven pre-start", async () => {
    for (const busy of [false, true]) {
      const order: string[] = [];
      const chain = new LiveChainAdapter({ network: "testnet", runner: async (_bin, _args, options) => {
        if (options?.input?.startsWith("transmit")) { order.push("transmit"); throw new WalletBusyError("wrapper busy", "busy"); }
        return `{\n  "fee": 10000\n}\n{\n  "txids": [\n    "${TX}"\n  ]\n}\n`;
      } });
      await assert.rejects(chain.pay({ amountZats: 10000n, recipient: R,
        stage: () => { order.push("stage"); },
        fence: () => { if (!busy && order.includes("stage")) throw new Error("fence lost"); },
        beforeTransmit: () => { order.push("authorize"); },
      }), busy ? WalletBusyError : /fence lost/);
      assert.deepEqual(order, busy ? ["stage", "authorize", "transmit"] : ["stage"]);
    }
  });
  it("327842 path credentials require HTTPS, explicit opt-in, and sufficient decoded length", () => {
    const url = "https://lwd.example/customer123/secret%2Dtoken123";
    assert.throws(() => checkServerUrl(url, {}), /credentials/);
    assert.throws(() => checkServerUrl(url.replace("https:", "http:"), { ZSHIELD_ALLOW_URL_CREDENTIALS: "1" }), /https/);
    assert.throws(() => checkServerUrl("https://lwd.example/tiny", { ZSHIELD_ALLOW_URL_CREDENTIALS: "1" }), /at least/);
    assert.equal(checkServerUrl(url, { ZSHIELD_ALLOW_URL_CREDENTIALS: "1" }), url);
    createRedactor().run(() => {
      registerServerUrl(url);
      const text = redact(`${url} customer123 secret-token123 secret%2Dtoken123`);
      assert.ok(!/customer123|secret.token123/.test(text));
      assert.equal(displayUrl(url), "https://lwd.example/[redacted]");
    });
    for (const path of ["/longsecret/../", "/longsecret/%2e%2e/", "/longsecret/.%2e/"]) {
      assert.throws(() => checkServerUrl(`https://lwd.example${path}`, {}), /dot segments/);
    }
    assert.equal(checkServerUrl("http://lwd.example:9067/", {}), "http://lwd.example:9067/");
  });
  it("327849 diagnostic reservations use constant inodes and cannot consume financial slots", () => {
    const root = fs.mkdtempSync(join(tmpdir(), "review-budget-"));
    const file = join(root, "fallback.jsonl");
    const budget = { auditDiagnosticMaxBytes: 150 * AUDIT_SLOT_BYTES, auditMaxBytes: AUDIT_SLOT_BYTES };
    for (let i = 0; i < 150; i++) reserveAudit(file, false, budget, false);
    assert.throws(() => reserveAudit(file, false, budget, false), /capacity exhausted/);
    reserveAudit(file, true, budget, false);
    assert.deepEqual(fs.readdirSync(`${file}.budget`).sort(), ["baseline.json", "diagnostic.counter", "payment.counter"]);
    assert.throws(() => reserveAudit(file, true, budget, false), /capacity exhausted/);
  });
  it("327849 concurrent processes share capacity and retain legacy charges", async () => {
    const root = fs.mkdtempSync(join(tmpdir(), "review-concurrent-"));
    const file = join(root, "fallback.jsonl");
    reserveAudit(file, false, { auditDiagnosticMaxBytes: 8 * AUDIT_SLOT_BYTES }, false);
    fs.writeFileSync(join(`${file}.budget`, "diagnostic-0"), "");
    const script = `import {reserveAudit,AUDIT_SLOT_BYTES} from './src/audit/budget.ts'; let count=0; for(let i=0;i<10;i++){try{reserveAudit(process.argv[1],false,{auditDiagnosticMaxBytes:8*AUDIT_SLOT_BYTES},false);count++}catch{}}console.log(count)`;
    const results = await Promise.all(Array.from({ length: 4 }, () => new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, file]);
      let out = ""; child.stdout.on("data", d => out += d); child.on("error", reject);
      child.on("close", code => code === 0 ? resolve(Number(out.trim())) : reject(new Error(`child ${code}`)));
    })));
    assert.equal(results.reduce((a,b) => a+b, 0), 6);
    assert.equal(fs.statSync(join(`${file}.budget`, "diagnostic.counter")).size, 7);
  });
  it("327847 bounds status sync and following commands by the same read deadline", async () => {
    let timeout = 0, grace: number | undefined;
    const chain = new LiveChainAdapter({ network: "testnet", runner: async () => '{"height":1000}', syncer: async (_bin, _args, options) => {
      timeout = options.timeoutMs; grace = options.quitGraceMs;
      return { complete: false, elapsedMs: 0 };
    } });
    await withReadBudget(() => chain.syncWallet(600000));
    assert.ok(timeout > 0 && timeout <= WALLET_READ_BUDGET_MS);
    assert.equal(grace, 500);
  });
  it("327847 sequential commands consume a shared deadline rather than restarting it", async () => {
    let clock = 1000;
    const timers: number[] = [];
    const adapter = new LiveChainAdapter({ network: "testnet", runner: async (_b, args, options) => {
      timers.push(options!.timeoutMs!);
      if (args.at(-1) === "balance") {
        clock += 35;
        return fs.readFileSync(new URL("./fixtures/zingo/balance.txt", import.meta.url), "utf8");
      }
      return '{"spendable_balance":10000}';
    } });
    const hook = mock.method(Date, "now", () => clock);
    try { await withOperationBudget(40, () => adapter.getBalance()); }
    finally { hook.mock.restore(); }
    assert.deepEqual(timers, [40, 5]);
  });
  it("327847 local admission precedes OS holders; wallet lock still excludes cross-process reads", async () => {
    const store = new PaymentStore(fs.mkdtempSync(join(tmpdir(), "review-gate-")));
    store.requireOsLock = true;
    const read = await acquireWalletLock(store, 0, "zcash_balance");
    const writer = acquireWalletLock(store, 3000, "zcash_pay");
    try {
      // Local-first: a payment waiting behind an in-process read has not spawned its OS holder yet.
      const priority = spawnSync("perl", ["-e", "use Fcntl qw(:flock); open(my $f,'>>',$ARGV[0]) or die; exit(flock($f,LOCK_SH|LOCK_NB)?0:75)", join(store.dir, "send-priority.flock")]);
      assert.equal(priority.status, 0, "waiting payment must not hold the turnstile before local admission");
      // The wallet lock itself still excludes another process's zero-wait read.
      await assert.rejects(() => acquireWalletLock({ dir: store.dir, requireOsLock: true }, 0, "zcash_balance"), (e) => e instanceof BusyError || /Busy/.test(String(e)));
    } finally {
      await read.release();
      const lock = await writer;
      await lock.release();
    }
  });
  it("327847 a read process ignoring SIGTERM is killed before the waiting payment times out", async () => {
    const store = new PaymentStore(fs.mkdtempSync(join(tmpdir(), "review-read-")));
    store.requireOsLock = true;
    let started!: () => void;
    const running = new Promise<void>(r => started = r);
    const chain = new LiveChainAdapter({ network: "testnet", runner: (_bin, _args, options) => {
      started();
      return defaultRunner(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], options);
    } });
    const read = withWalletRead(store, "balance", () => chain.getBalance()).then(() => assert.fail("read should time out"), e => assert.match(e.message, /stopped/));
    await running;
    const lock = await acquireWalletLock(store, LIVE_PAYMENT_READ_WAIT_MS, "zcash_pay");
    try { await read; lock.assertHeld(); } finally { await lock.release(); }
  });
});
