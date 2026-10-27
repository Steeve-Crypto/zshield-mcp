import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { appendAuditEntry } from "../src/audit/log.ts";
import type { ChainAdapter } from "../src/chain/types.ts";
import { resetPaymentStores as resetPaymentIndexes, storeFor } from "../src/payments/store.ts";
import { RECOVERY_EXPIRY_MS, recoverPendingPayments } from "../src/payments/recovery.ts";
import type { AuditEntry, ChainHealth, Config, TxSummary } from "../src/types.ts";
import { readAuditRows, tempConfig } from "./helpers.ts";

const R = "utest1" + "r".repeat(100);
const T0 = Date.parse("2026-10-26T12:00:00Z");

function pending(config: Config, callId: string, extra: Partial<AuditEntry> = {}) {
  const row: AuditEntry = {
    ts: new Date(T0).toISOString(),
    tool: "zcash_pay",
    call_id: callId,
    amount_zec: "0.0001",
    amount_zats: "10000",
    recipient: R,
    allowlist_hit: true,
    cap_zec: "0.01",
    status: "pending",
    view_key_fingerprint: "abc",
    memo: "rent",
    chain_tip: 900,
    wallet_height: 900,
    ...extra,
  };
  appendAuditEntry(config.auditDir, row);
}

function sent(txid: string, opts: Partial<TxSummary> = {}, memo = "rent"): TxSummary {
  return {
    txid,
    time: new Date(T0 + 5000).toISOString(),
    status: "confirmed",
    blockHeight: 500,
    kind: "sent",
    valueZats: -10000n,
    outgoing: [{ recipient: R, valueZats: 10000n, memo }],
    ...opts,
  };
}

/** A chain that only reads. Any send fails the test. */
function chain(history: TxSummary[] | (() => Promise<TxSummary[]>), health?: ChainHealth | Error) {
  const calls = { pay: 0, history: 0 };
  const c: ChainAdapter = {
    async pay() {
      calls.pay++;
      throw new Error("recovery must never send");
    },
    async getBalance() {
      throw new Error("unused");
    },
    async getReceiveAddress() {
      throw new Error("unused");
    },
    async getHistory() {
      calls.history++;
      return typeof history === "function" ? history() : history;
    },
    getViewingKey: async () => "uview",
  } as unknown as ChainAdapter;
  if (health) {
    c.checkHealth = async () => {
      if (health instanceof Error) throw health;
      return health;
    };
  }
  return { c, calls };
}

const synced: ChainHealth = { walletHeight: 1000, chainTip: 1001, spendableZats: 0n };
const late = T0 + RECOVERY_EXPIRY_MS + 1;
const recoveryRows = (config: Config) => readAuditRows(config).filter((r) => r.tool === "zcash_pay_recovery");

beforeEach(() => resetPaymentIndexes());

describe("crash recovery on startup", () => {
  it("confirms a mined send that matches and never resends", async () => {
    const config = tempConfig();
    pending(config, "c1", { idempotency_key: "k1" });
    const { c, calls } = chain([sent("aa".repeat(32))], synced);
    const rows = await recoverPendingPayments(config, c, { now: T0 + 60_000 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "confirmed");
    assert.equal(rows[0].txid, "aa".repeat(32));
    assert.equal(rows[0].block_height, 500);
    assert.equal(rows[0].confidence, "high");
    assert.equal(rows[0].idempotency_key, "k1");
    assert.equal(calls.pay, 0);
    assert.equal(recoveryRows(config).length, 1);
  });

  it("reads the wallet history once for many pending calls", async () => {
    const config = tempConfig();
    for (let i = 0; i < 5; i++) pending(config, `m${i}`, { memo: `m${i}` });
    const { c, calls } = chain([sent("aa".repeat(32), {}, "m3")], synced);
    const rows = await recoverPendingPayments(config, c, { now: T0 + 60_000 });
    assert.equal(rows.length, 5);
    assert.equal(rows.filter((r) => r.status === "confirmed").length, 1);
    assert.equal(calls.history, 1);
  });

  it("does not confirm on amount alone", async () => {
    const config = tempConfig();
    pending(config, "c1", { chain_tip: 990, wallet_height: 990 });
    const other = sent("bb".repeat(32), { outgoing: [{ recipient: "utest1other", valueZats: 10000n, memo: "rent" }] });
    const { c } = chain([other, sent("cc".repeat(32), {}, "different memo")], synced);
    const [row] = await recoverPendingPayments(config, c, { now: T0 + 60_000 });
    assert.equal(row.status, "unknown");
    assert.equal(row.txid, undefined);
  });

  it("not_found only once a synced wallet has scanned past the expiry height", async () => {
    const config = tempConfig();
    pending(config, "c1");
    const early = await recoverPendingPayments(config, chain([], { walletHeight: 940, chainTip: 941, spendableZats: 0n }).c, { now: late });
    assert.equal(early[0].status, "unknown");
    assert.match(early[0].note, /expiry/);

    const behind = await recoverPendingPayments(config, chain([], { ...synced, walletHeight: 900 }).c, { now: late });
    assert.equal(behind[0].status, "unknown");
    assert.match(behind[0].note, /not synced/);

    const offline = await recoverPendingPayments(config, chain([], new Error("no server")).c, { now: late });
    assert.equal(offline[0].status, "unknown");

    const done = await recoverPendingPayments(config, chain([], synced).c, { now: late });
    assert.equal(done[0].status, "not_found");
  });

  it("a match that is not mined yet stays unknown with the candidate", async () => {
    const config = tempConfig();
    pending(config, "c1");
    const { c } = chain([sent("dd".repeat(32), { status: "transmitted", blockHeight: undefined })], synced);
    const [row] = await recoverPendingPayments(config, c, { now: late });
    assert.equal(row.status, "unknown");
    assert.equal(row.possible_sends?.[0].txid, "dd".repeat(32));
  });

  it("unknown when history cannot be read", async () => {
    const config = tempConfig();
    pending(config, "c1");
    const { c } = chain(async () => {
      throw new Error("zingo-cli timed out");
    }, synced);
    const [row] = await recoverPendingPayments(config, c, { now: late });
    assert.equal(row.status, "unknown");
    assert.match(row.note, /timed out/);
  });

  it("skips calls with a result row and settled recoveries, retries unknown ones after a restart", async () => {
    const config = tempConfig();
    pending(config, "done", { chain_tip: 990, wallet_height: 990 });
    appendAuditEntry(config.auditDir, {
      ts: new Date(T0 + 1).toISOString(), tool: "zcash_pay", call_id: "done", amount_zec: "0.0001", recipient: R,
      allowlist_hit: true, cap_zec: "0.01", status: "ok", view_key_fingerprint: "abc",
    });
    pending(config, "open", { chain_tip: 990, wallet_height: 990 });
    const first = chain([], synced);
    assert.deepEqual((await recoverPendingPayments(config, first.c, { now: T0 + 60_000 })).map((r) => [r.call_id, r.status]), [["open", "unknown"]]);

    // Restart: the index is rebuilt from disk, recovery rows included.
    resetPaymentIndexes();
    const second = chain([sent("ee".repeat(32))], synced);
    const again = await recoverPendingPayments(config, second.c, { now: T0 + 60_000 });
    assert.deepEqual(again.map((r) => r.status), ["confirmed"]);
    assert.equal(storeFor(config, second.c).readCall("open")?.state, "mined");

    resetPaymentIndexes();
    const third = chain([], synced);
    assert.deepEqual(await recoverPendingPayments(config, third.c), []);
    assert.equal(third.calls.history, 0);
  });

  it("does nothing when there is nothing to recover", async () => {
    const { c, calls } = chain([], synced);
    assert.deepEqual(await recoverPendingPayments(tempConfig(), c), []);
    assert.equal(calls.history, 0);
  });
});

describe("recovery and sends", () => {
  it("holds the send lock, so a send waits until recovery is done", async () => {
    const { sendLockFor } = await import("../src/payments/lock.ts");
    const { storeFor } = await import("../src/payments/store.ts");
    const config = tempConfig();
    pending(config, "c1");
    let finish!: () => void;
    const gate = new Promise<void>((r) => (finish = r));
    const { c } = chain(async () => {
      await gate;
      return [];
    }, synced);
    const run = recoverPendingPayments(config, c, { now: T0 + 60_000 });
    await new Promise((r) => setTimeout(r, 10));
    await assert.rejects(sendLockFor(storeFor(config, c).dir).acquire(5), /BUSY|busy|another/i);
    finish();
    await run;
    const release = await sendLockFor(storeFor(config, c).dir).acquire(5);
    release();
  });
});
