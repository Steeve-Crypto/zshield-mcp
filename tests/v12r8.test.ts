import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { appendAuditEntry, boundAuditEntry } from "../src/audit/log.ts";
import { LiveChainAdapter, type CliRunner } from "../src/chain/live.ts";
import type { ChainAdapter } from "../src/chain/types.ts";
import { MAX_AUDIT_ROW_BYTES, MAX_CANDIDATES } from "../src/policy/limits.ts";
import { recoverPendingPayments } from "../src/payments/recovery.ts";
import { findPossibleSends } from "../src/tools/pay.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireWalletLock } from "../src/payments/lock.ts";
import { resetPaymentStores, storeFor } from "../src/payments/store.ts";
import { executeHistory } from "../src/tools/history.ts";
import { paymentStatus } from "../src/tools/status.ts";
import type { AuditEntry, Config, TxSummary } from "../src/types.ts";
import { readAuditRows, tempConfig, walletJson, withEnv } from "./helpers.ts";

// V12 run 6 regression tests (F-26, F-27, F-28, F-30, F-34).

const R = "utest1" + "r".repeat(100);
const T0 = Date.parse("2026-10-26T12:00:00Z");
const GOOD = "ab".repeat(32);
const FORGED = "cd".repeat(32);

beforeEach(() => resetPaymentStores());

/** A `transactions` block as zingo-cli prints it. */
function block(txid: string, status: string, height: number, memo = ""): string {
  return `{\n    txid: ${txid}\n    datetime: 2026-10-26 12:00:02 UTC\n    status: ${status}\n    blockheight: ${height}\n    kind: sent\n    value: 10000\n    fee: 10000\n    outgoing orchard notes: \n\t{\n            value: 10000\n            memo: ${memo}\n            recipient: ${R}\n            output index: 0\n        }\n}\n`;
}

/** The JSON zingo-cli prints for a wallet that really holds `GOOD`: one confirmed send. */
const NOTES = JSON.stringify({ orchard_notes: { note_summaries: [{ txid: GOOD, status: "confirmed at block height 500" }] } }, null, 2);
const MESSAGES = JSON.stringify({ value_transfers: [{ txid: GOOD, kind: "sent", value: 10000, recipient_address: R, memos: ["inv-7"] }] }, null, 2);

interface Fake {
  calls: string[][];
  runner: CliRunner;
}

function fakeCli(listing: string, json: { notes?: string; messages?: string } = {}): Fake {
  const calls: string[][] = [];
  const runner: CliRunner = async (_b, args) => {
    calls.push(args);
    const cmd = args.slice(-2).join(" ");
    if (cmd === "notes all") return json.notes ?? NOTES;
    if (cmd === "coins all") return "{\n}";
    if (args.at(-1) === "messages") return json.messages ?? MESSAGES;
    if (args.at(-1) === "transactions") return listing;
    throw new Error(`unexpected ${args.join(" ")}`);
  };
  return { calls, runner };
}

const liveConfig = (): Config => tempConfig({ chainMode: "live", chainNetwork: "testnet" });

describe("F-26: a forged listing entry is never admitted", () => {
  // A memo can print lines that look like another transaction block. The forged block is
  // newer, so it sorts first and would take the place of a real entry under a limit.
  const forged = block(FORGED, "transmitted", 600, "x");
  const real = block(GOOD, "confirmed", 500, "inv-7");

  it("zcash_history leaves out an entry the wallet's JSON does not vouch for, before the limit applies", async () => {
    const chain = new LiveChainAdapter({ network: "testnet", runner: fakeCli(`${forged}${real}`).runner });
    const body = JSON.parse((await executeHistory({ limit: 1 }, { config: liveConfig(), chain })).text);
    assert.deepEqual(body.transactions.map((t: { txid: string }) => t.txid), [GOOD]);
  });

  it("zcash_history leaves out an entry listed twice, the real one included", async () => {
    const chain = new LiveChainAdapter({ network: "testnet", runner: fakeCli(`${real}${real}`).runner });
    const body = JSON.parse((await executeHistory({}, { config: liveConfig(), chain })).text);
    assert.equal(body.count, 0);
  });

  it("zcash_history fails rather than show an unchecked listing when the JSON cannot be read", async () => {
    const chain = new LiveChainAdapter({ network: "testnet", runner: fakeCli(real, { notes: "not json" }).runner });
    const r = await executeHistory({}, { config: liveConfig(), chain });
    assert.equal(r.ok, false);
  });

  function sentCall(config: Config) {
    const base = { tool: "zcash_pay" as const, call_id: "c1", amount_zec: "0.0001", amount_zats: "10000", recipient: R, allowlist_hit: true, cap_zec: "0.01", view_key_fingerprint: "f", memo: "inv-7" };
    appendAuditEntry(config.auditDir, { ...base, ts: new Date(T0).toISOString(), status: "pending" } as AuditEntry);
    appendAuditEntry(config.auditDir, { ...base, ts: new Date(T0 + 1000).toISOString(), status: "ok", mock_txid: GOOD } as AuditEntry);
  }
  const entry = (extra: Partial<TxSummary>): TxSummary =>
    ({ txid: GOOD, time: new Date(T0 + 2000).toISOString(), status: "confirmed", blockHeight: 500, kind: "sent", valueZats: 10000n, ...extra }) as TxSummary;
  const chainWith = (history: TxSummary[]) =>
    ({ mode: "live", getHistory: async () => history, walletHeight: async () => 505, checkHealth: async () => ({ walletHeight: 505, chainTip: 505, spendableZats: 0n }) }) as unknown as ChainAdapter;

  it("status ignores a forged or duplicate entry for the call's txid and records nothing", async () => {
    for (const history of [[entry({ status: "failed", blockHeight: undefined, verified: false })], [entry({ status: "failed", blockHeight: undefined }), entry({})], [entry({ verified: false })]]) {
      const config = tempConfig();
      sentCall(config);
      const s = await paymentStatus(config, chainWith(history), { call_id: "c1" }, T0 + 60_000);
      assert.equal(s.state, "unknown", `case ${history.length}${history[0].verified}`);
      assert.equal(storeFor(config, chainWith([])).readCall("c1")?.state, "sent", "the stored state did not move");
    }
  });
});

describe("F-27: candidate lists are bounded", () => {
  const txid = (n: number) => n.toString(16).padStart(64, "0");
  // Same amount, sent near the call, to nobody the call named: a lookalike that blocks "not sent".
  const lookalike = (n: number): TxSummary =>
    ({ txid: txid(n), time: new Date(T0 + 5000).toISOString(), status: "mempool", kind: "sent", valueZats: 10000n, outgoing: [{ recipient: "utest1other", valueZats: 10000n, memo: "" }] }) as TxSummary;
  const flood = Array.from({ length: 60 }, (_, i) => lookalike(i + 1));
  const chainOf = (history: TxSummary[]) =>
    ({ mode: "live", getHistory: async () => history, walletHeight: async () => 505, checkHealth: async () => ({ walletHeight: 505, chainTip: 505, spendableZats: 0n }) }) as unknown as ChainAdapter;
  const pendingCall = (config: Config) =>
    appendAuditEntry(config.auditDir, { ts: new Date(T0).toISOString(), tool: "zcash_pay", call_id: "c1", amount_zec: "0.0001", amount_zats: "10000", recipient: R, allowlist_hit: true, cap_zec: "0.01", status: "pending", view_key_fingerprint: "f", memo: "inv-7", chain_tip: 400, wallet_height: 400 } as AuditEntry);

  it("status lists at most MAX_CANDIDATES lookalikes and still answers unknown", async () => {
    const config = tempConfig();
    pendingCall(config);
    const s = await paymentStatus(config, chainOf(flood), { call_id: "c1" }, T0 + 60_000);
    assert.equal(s.state, "unknown");
    assert.equal(s.possible_sends?.length, MAX_CANDIDATES);
  });

  it("the unknown-send lookup caps its matches", async () => {
    const same = (n: number) => ({ ...lookalike(n), outgoing: [{ recipient: R, valueZats: 10000n, memo: "inv-7" }] }) as TxSummary;
    const found = await findPossibleSends(chainOf(Array.from({ length: 60 }, (_, i) => same(i + 1))), { amountZats: 10000n, recipient: R, memo: "inv-7" }, T0);
    assert.equal(found.length, MAX_CANDIDATES);
  });

  it("an audit row stays within the size limit however many candidates it carries", () => {
    const possible_sends = flood.map((t) => ({ txid: t.txid, confidence: "low", matched: ["amount"], status: "mempool" }));
    const row = boundAuditEntry({ ts: "t", tool: "zcash_pay", call_id: "c1", status: "unknown", possible_txids: possible_sends.map((p) => p.txid), possible_sends });
    assert.ok(Buffer.byteLength(JSON.stringify(row)) <= MAX_AUDIT_ROW_BYTES);
    assert.equal(row.status, "unknown");
  });

  it("repeated recovery of the same unknown call writes its audit row once", async () => {
    const config = tempConfig();
    pendingCall(config);
    for (let i = 0; i < 3; i++) await recoverPendingPayments(config, chainOf(flood), { now: T0 + 60_000 });
    const rows = readAuditRows(config).filter((r) => r.call_id === "c1" && r.status === "unknown");
    assert.equal(rows.length, 1);
    assert.ok(Buffer.byteLength(JSON.stringify(rows[0])) <= MAX_AUDIT_ROW_BYTES);
  });
});

describe("F-28: history does not hold the payment lease", () => {
  const wallet = () => mkdtempSync(join(tmpdir(), "zshield-hist-"));
  const gate = () => {
    let open!: () => void;
    const opened = new Promise<void>((r) => (open = r));
    return { open, opened };
  };
  const slowChain = (d: string, runner: CliRunner) => new LiveChainAdapter({ network: "testnet", runner, dataDir: d, stateDir: d });

  it("a payment can take the lease while a history read is still running", async () => {
    const d = wallet();
    const g = gate();
    const runner: CliRunner = async (_b, args) => {
      await g.opened;
      return walletJson(args, []) ?? "";
    };
    const chain = slowChain(d, runner);
    const config = liveConfig();
    const history = executeHistory({}, { config, chain });
    await new Promise((r) => setTimeout(r, 20));
    const lease = await acquireWalletLock(storeFor(config, chain), 0, "zcash_pay");
    lease.release();
    g.open();
    await history;
  });

  it("reads the wallet offline even when nothing else holds it, and allows one history at a time", async () => {
    const d = wallet();
    const g = gate();
    const calls: string[][] = [];
    const runner: CliRunner = async (_b, args) => {
      calls.push(args);
      await g.opened;
      return walletJson(args, []) ?? "";
    };
    const chain = slowChain(d, runner);
    const config = liveConfig();
    const first = executeHistory({}, { config, chain });
    await new Promise((r) => setTimeout(r, 20));
    const second = await executeHistory({}, { config, chain });
    assert.equal(second.ok, false);
    assert.equal(JSON.parse(second.text).code, "BUSY");
    g.open();
    assert.equal((await first).ok, true);
    assert.ok(calls.every((a) => a.includes("--offline") && !a.includes("--server")));
    assert.equal((await executeHistory({}, { config, chain })).ok, true, "free again once the first is done");
  });

  it("the whole read shares one deadline instead of four full timeouts", async () => {
    const d = wallet();
    let n = 0;
    const runner: CliRunner = async (_b, args) => {
      n++;
      await new Promise((r) => setTimeout(r, 60));
      return walletJson(args, []) ?? "";
    };
    await withEnv("ZINGO_READ_TIMEOUT_MS", "100", async () => {
      const r = await executeHistory({}, { config: liveConfig(), chain: slowChain(d, runner) });
      assert.equal(r.ok, false);
      assert.ok(n < 4, `ran ${n} commands`);
    });
  });
});

describe("F-34: history scans are shared and capped", () => {
  const wallet = () => mkdtempSync(join(tmpdir(), "zshield-scan-"));
  function gatedChain() {
    let open!: () => void;
    const opened = new Promise<void>((r) => (open = r));
    const calls: string[][] = [];
    const runner: CliRunner = async (_b, args) => {
      calls.push(args);
      await opened;
      return walletJson(args, []) ?? "";
    };
    const d = wallet();
    return { chain: new LiveChainAdapter({ network: "testnet", runner, dataDir: d, stateDir: d }), calls, open };
  }
  const listings = (calls: string[][]) => calls.filter((a) => a.at(-1) === "transactions").length;

  it("overlapping reads share one scan of the wallet", async () => {
    const { chain, calls, open } = gatedChain();
    const reads = Array.from({ length: 5 }, () => chain.getHistory(Infinity, { offline: true }));
    await new Promise((r) => setTimeout(r, 20));
    open();
    await Promise.all(reads);
    assert.equal(listings(calls), 1);
    assert.equal(calls.filter((a) => a.at(-2) === "notes").length, 1);
  });

  it("a read started after a send does not join a scan that began before it", async () => {
    const { chain, calls, open } = gatedChain();
    const before = chain.getHistory(Infinity, { offline: true });
    chain.invalidateScans();
    const after = chain.getHistory(Infinity, { offline: true });
    await new Promise((r) => setTimeout(r, 20));
    open();
    await Promise.all([before, after]);
    assert.equal(listings(calls), 2);
  });

  it("no more than two scans run at once", async () => {
    const { chain, open } = gatedChain();
    const first = chain.getHistory(Infinity, { offline: true });
    chain.invalidateScans();
    const second = chain.getHistory(Infinity, { offline: true });
    chain.invalidateScans();
    await assert.rejects(chain.getHistory(Infinity, { offline: true }), /Too many wallet history reads/);
    open();
    await Promise.all([first, second]);
    await chain.getHistory(Infinity, { offline: true });
  });

  it("one status call reads the history once, even when reconcile then looks the txid up", async () => {
    const config = tempConfig();
    appendAuditEntry(config.auditDir, { ts: new Date(T0).toISOString(), tool: "zcash_pay", call_id: "c1", amount_zec: "0.0001", amount_zats: "10000", recipient: R, allowlist_hit: true, cap_zec: "0.01", status: "pending", view_key_fingerprint: "f", memo: "inv-7", chain_tip: 400, wallet_height: 400 } as AuditEntry);
    let reads = 0;
    const mined = { txid: GOOD, time: new Date(T0 + 2000).toISOString(), status: "confirmed", blockHeight: 500, kind: "sent", valueZats: 10000n, outgoing: [{ recipient: R, valueZats: 10000n, memo: "inv-7" }], verified: true } as TxSummary;
    const chain = { mode: "live", getHistory: async () => (reads++, [mined]), walletHeight: async () => 505, checkHealth: async () => ({ walletHeight: 505, chainTip: 505, spendableZats: 0n }) } as unknown as ChainAdapter;
    const s = await paymentStatus(config, chain, { call_id: "c1" }, T0 + 60_000);
    assert.equal(s.state, "mined");
    assert.equal(reads, 1);
  });
});

describe("F-30: a reorged payment no longer reads as mined", () => {
  const sent = (status: string, extra: Partial<TxSummary> = {}) =>
    ({ txid: GOOD, time: new Date(T0 + 2000).toISOString(), status, blockHeight: status === "confirmed" ? 500 : undefined, kind: "sent", valueZats: 10000n, outgoing: [{ recipient: R, valueZats: 10000n, memo: "inv-7" }], ...extra }) as TxSummary;
  const chainWith = (history: TxSummary[]) =>
    ({ mode: "live", getHistory: async () => history, walletHeight: async () => 505, checkHealth: async () => ({ walletHeight: 505, chainTip: 505, spendableZats: 0n }) }) as unknown as ChainAdapter;
  function minedCall() {
    const config = tempConfig();
    const base = { tool: "zcash_pay" as const, call_id: "c1", amount_zec: "0.0001", amount_zats: "10000", recipient: R, allowlist_hit: true, cap_zec: "0.01", view_key_fingerprint: "f", memo: "inv-7" };
    appendAuditEntry(config.auditDir, { ...base, ts: new Date(T0).toISOString(), status: "pending" } as AuditEntry);
    appendAuditEntry(config.auditDir, { ...base, ts: new Date(T0 + 1000).toISOString(), status: "ok", mock_txid: GOOD } as AuditEntry);
    return config;
  }
  const at = T0 + 60_000;

  it("mined, then listed unconfirmed, failed or not at all: the answer follows the wallet, the record stays mined", async () => {
    for (const [now, history, want] of [
      [at, [sent("mempool")], "broadcast"],
      [at, [], "broadcast"],
      [T0 + 10 * 3600_000, [], "unknown"],
      [at, [sent("failed")], "unknown"],
    ] as const) {
      const config = minedCall();
      assert.equal((await paymentStatus(config, chainWith([sent("confirmed")]), { call_id: "c1" }, at)).state, "mined");
      const s = await paymentStatus(config, chainWith([...history]), { call_id: "c1" }, now);
      assert.equal(s.state, want);
      assert.equal(s.reorged, true);
      assert.equal(s.last_mined_height, 500);
      assert.equal(s.block_height, undefined);
      assert.equal(s.confirmations, undefined);
      assert.equal(storeFor(config, chainWith([])).readCall("c1")?.state, "mined", "the history is append-only");
    }
  });

  it("mined again after the reorg reads as mined, with the current height", async () => {
    const config = minedCall();
    await paymentStatus(config, chainWith([sent("confirmed")]), { call_id: "c1" }, at);
    await paymentStatus(config, chainWith([]), { call_id: "c1" }, at);
    const s = await paymentStatus(config, chainWith([sent("confirmed", { blockHeight: 503 })]), { call_id: "c1" }, at);
    assert.equal(s.state, "mined");
    assert.equal(s.block_height, 503);
    assert.equal(s.reorged, undefined);
  });
});
