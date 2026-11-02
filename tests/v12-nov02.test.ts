import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it, mock } from "node:test";
import { LiveChainAdapter } from "../src/chain/live.ts";
import { HistoryProjector, projectHistory } from "../src/chain/history-stream.ts";
import { executePay } from "../src/tools/pay.ts";
import { paymentStatus } from "../src/tools/status.ts";
import { RECOVERY_EXPIRY_MS, recoverPendingPayments } from "../src/payments/recovery.ts";
import { resetPaymentStores, storeFor } from "../src/payments/store.ts";
import { writeAuditRow } from "../src/audit/log.ts";
import { assertSafeAncestors, appendPrivate, ensurePrivateDir } from "../src/fsafe.ts";
import { startupChecks } from "../src/startup.ts";
import type { ChainAdapter } from "../src/chain/types.ts";
import type { TxSummary } from "../src/types.ts";
import { tempConfig } from "./helpers.ts";

afterEach(() => mock.restoreAll());

const TX = "ab".repeat(32),
  R = "utest1" + "r".repeat(100),
  T0 = Date.now() - 3 * RECOVERY_EXPIRY_MS;
function world() {
  const config = tempConfig({ chainMode: "live", chainNetwork: "testnet" });
  fs.writeFileSync(config.allowlistPath, JSON.stringify({ recipients: [{ address: R }] }));
  let history: TxSummary[] = [],
    sends = 0;
  const chain = {
    mode: "live",
    getViewingKey: async () => "uview-test",
    getHistory: async () => history,
    getTransaction: async () => history,
    checkHealth: async () => ({ chainTip: 2001, walletHeight: 2000, spendableZats: 100000n }),
    syncWallet: async () => ({ complete: true, elapsedMs: 0 }),
    walletHeight: async () => 2000,
    pay: async () => {
      sends++;
      throw new Error("must not send");
    },
  } as unknown as ChainAdapter;
  const store = storeFor(config, chain);
  store.writeIntent({
    call_id: "original",
    ts: new Date(T0).toISOString(),
    amount_zec: "0.0001",
    amount_zats: "10000",
    recipient: R,
    allowlist_hit: true,
    cap_zec: "0.1",
    view_key_fingerprint: "fp",
    idempotency_key: "original-key",
    chain_tip: 1000,
    wallet_height: 1000,
    two_step: true,
  });
  store.stageTxid("original", TX, new Date(T0).toISOString());
  store.bindKey("original-key", "original", "parameters");
  return {
    config,
    chain,
    store,
    sends: () => sends,
    mined: () => {
      history = [{ txid: TX, status: "confirmed", blockHeight: 1100, kind: "sent", valueZats: 10000n, verified: true }];
    },
  };
}

describe("V12 November 2 root causes", () => {
  it("327483 absence past every height/time margin stays unresolved, then a deep reorg can reveal the original", async () => {
    const w = world();
    const first = await paymentStatus(w.config, w.chain, { call_id: "original" });
    assert.equal(first.state, "unknown");
    assert.ok(w.store.pendingCalls().includes("original"));
    const retry = await executePay({ recipient: R, amount_zec: "0.0001", idempotency_key: "new-key" }, w);
    assert.equal(retry.code, "UNRESOLVED_PAYMENT");
    assert.equal(w.sends(), 0);
    w.mined();
    assert.equal((await paymentStatus(w.config, w.chain, { call_id: "original" })).state, "mined");
  });
  it("327483 legacy terminal expiry is re-indexed after restart and status rechecks the chain", async () => {
    const w = world();
    w.store.advance({
      call_id: "original",
      ts: new Date().toISOString(),
      state: "expired",
      code: "PAYMENT_EXPIRED",
      note: "old finite-margin proof",
      by: "recovery",
    });
    w.store.clearPending("original");
    resetPaymentStores();
    assert.ok(storeFor(w.config, w.chain).pendingCalls().includes("original"));
    assert.equal((await paymentStatus(w.config, w.chain, { call_id: "original" })).state, "unknown");
    const retry = await executePay({ recipient: R, amount_zec: "0.0001", idempotency_key: "new-key" }, w);
    assert.equal(retry.code, "UNRESOLVED_PAYMENT");
    w.mined();
    const rows = await recoverPendingPayments(w.config, w.chain);
    assert.equal(rows[0].status, "confirmed");
    assert.equal((await paymentStatus(w.config, w.chain, { call_id: "original" })).state, "mined");
  });
  it("327483 a wallet failed observation also stays interlocked until positive reconciliation", async () => {
    const w = world();
    w.chain.getTransaction = async () => [
      { txid: TX, status: "failed", kind: "sent", valueZats: 10000n, verified: true },
    ];
    assert.equal((await paymentStatus(w.config, w.chain, { call_id: "original" })).state, "failed");
    assert.ok(w.store.pendingCalls().includes("original"));
    assert.equal(
      (await executePay({ recipient: R, amount_zec: "0.0001", idempotency_key: "retry-after-failed" }, w)).code,
      "UNRESOLVED_PAYMENT",
    );
    w.chain.getTransaction = async () => [
      { txid: TX, status: "confirmed", blockHeight: 1100, kind: "sent", valueZats: 10000n, verified: true },
    ];
    assert.equal((await paymentStatus(w.config, w.chain, { call_id: "original" })).state, "mined");
  });
  it(
    "327484 real process output over 16 MiB in BOTH JSON and listing still resolves the selected txid",
    { timeout: 30000 },
    async () => {
      const dir = fs.mkdtempSync(join(tmpdir(), "zshield-large-history-"));
      const chain = new LiveChainAdapter({
        network: "testnet",
        dataDir: dir,
        zingoBin: fileURLToPath(new URL("./fixtures/large-history.mjs", import.meta.url)),
      });
      storeFor(tempConfig(), chain);
      const entries = await chain.getTransaction(TX, { offline: true });
      assert.equal(entries.length, 1);
      assert.equal(entries[0].verified, true);
      assert.equal(entries[0].blockHeight, 1100);
      // No full-history fallback is allowed in recovery or status.
      chain.getHistory = async () => {
        throw new Error("full history is unavailable");
      };
      const w = world();
      w.chain.getHistory = chain.getHistory;
      w.chain.getTransaction = chain.getTransaction.bind(chain);
      assert.equal((await paymentStatus(w.config, w.chain, { call_id: "original" })).state, "mined");
    },
  );
  it("327484 streaming checks duplicates after the real entry and rejects incomplete JSON", () => {
    const block = `{\n    txid: ${TX}\n    status: confirmed\n    kind: sent\n    value: 1\n}\n`;
    assert.equal(
      (projectHistory(block + block, { format: "transactions", txids: [TX] }).match(/txid:/g) ?? []).length,
      2,
    );
    assert.throws(
      () => projectHistory(`{"notes":[{"txid":"${TX}","status":"confirmed"}`, { format: "json", txids: [TX] }),
      /Incomplete/,
    );
    const memo = JSON.stringify({
      value_transfers: [{ txid: "cd".repeat(32), memos: [`{"txid":"${TX}","status":"confirmed"}`] }],
    });
    assert.deepEqual(JSON.parse(projectHistory(memo, { format: "json", txids: [TX] })).value_transfers, []);
  });
  it("327484 oversized unrelated records do not block a later selected identity", () => {
    const other = "cd".repeat(32);
    const huge = {
      value_transfers: [
        { txid: other, memos: Array.from({ length: 3000 }, () => "x".repeat(512)) },
        { txid: TX, kind: "sent", value: 1, memos: ["ok"] },
      ],
    };
    const projected = JSON.parse(projectHistory(JSON.stringify(huge), { format: "json", txids: [TX] }));
    assert.equal(projected.value_transfers.length, 1);
    assert.equal(projected.value_transfers[0].txid, TX);
    const listing = `{\n    txid: ${other}\n${"        memo: padding\n".repeat(100000)}}\n{\n    txid: ${TX}\n    status: confirmed\n    kind: sent\n    value: 1\n}\n`;
    const result = projectHistory(listing, { format: "transactions", txids: [TX] });
    assert.ok(result.includes(TX));
    assert.ok(!result.includes(other));
  });
  it("327495 a trusted lexical alias cannot be retargeted after the first audit append", () => {
    const root = fs.mkdtempSync(join(tmpdir(), "zshield-alias-")),
      a = join(root, "a"),
      b = join(root, "b"),
      alias = join(root, "alias");
    fs.mkdirSync(a);
    fs.mkdirSync(b);
    fs.symlinkSync(a, alias);
    ensurePrivateDir(join(alias, "logs"));
    appendPrivate(join(alias, "logs", "first.jsonl"), "{}\n");
    fs.unlinkSync(alias);
    fs.symlinkSync(b, alias);
    const result = writeAuditRow(
      { auditDir: join(alias, "logs") },
      { ts: new Date().toISOString(), tool: "zcash_balance", call_id: "x", mode: "mock", status: "ok" },
      () => {},
    );
    assert.equal(result.durable, false);
    assert.deepEqual(fs.readdirSync(b), []);
  });
  it(
    "327495 lexical ancestor ownership is checked before following a symlink, including the independent fallback",
    { skip: process.platform === "win32" },
    () => {
      const root = fs.mkdtempSync(join(tmpdir(), "zshield-namespace-")),
        target = join(root, "target"),
        alias = join(root, "other-user-alias");
      fs.mkdirSync(target);
      fs.symlinkSync(target, alias);
      const realLstat = fs.lstatSync;
      mock.method(fs, "lstatSync", (p: fs.PathLike, ...args: any[]) => {
        const st = (realLstat as any)(p, ...args);
        return String(p) === alias ? Object.assign(Object.create(st), { uid: 65534 }) : st;
      });
      assert.throws(() => assertSafeAncestors(join(alias, "audit.jsonl")), /owned/);
      const config = tempConfig({ auditFallbackPath: join(alias, "fallback.jsonl") });
      assert.throws(() => startupChecks(config), /owned/);
    },
  );
});
