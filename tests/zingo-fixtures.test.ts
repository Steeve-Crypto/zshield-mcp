import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import { appendAuditEntry } from "../src/audit/log.ts";
import {
  LiveChainAdapter,
  parseBalance,
  parseLatestBlockHeight,
  parseSpendable,
  parseTransactions,
  parseWalletHeight,
  type CliRunner,
} from "../src/chain/live.ts";
import type { WalletSyncer } from "../src/chain/sync.ts";
import { acquireWalletLock } from "../src/payments/lock.ts";
import { resetPaymentStores as resetPaymentIndexes } from "../src/payments/store.ts";
import { matchSend } from "../src/tools/pay.ts";
import { paymentStatus } from "../src/tools/status.ts";
import { seedCall, tempConfig, walletJson } from "./helpers.ts";

// Captured read-only from the testnet wallet on Oct 27 2026. Nothing was sent to capture them.
const fixture = (n: string) => readFileSync(new URL(`./fixtures/zingo/${n}`, import.meta.url), "utf8");
const TXID = "50b19b866eaa2bb6146e0e560ad28c0e4dab014ae6b81b9830ae9e3f65fe0196";
const RECIPIENT =
  "utest1tkzp6v69yg97zyv8c908xvkmell8p97vmgs7dq30v3cxghsjxkaslg2ff90slfscscf9gs8mftg2ucf5raa36w4zehug0feluukfahv0";
const SENT_AT = Date.parse("2026-10-27T12:48:55.660Z");

beforeEach(() => resetPaymentIndexes());

describe("parsers on real zingo-cli output", () => {
  it("transactions: the reliable-sends payment is a confirmed send with its note", () => {
    const txs = parseTransactions(fixture("transactions.txt"));
    assert.equal(txs.length, 3);
    const t = txs.find((x) => x.txid === TXID)!;
    assert.equal(t.status, "confirmed");
    assert.equal(t.blockHeight, 4547481);
    assert.equal(t.kind, "sent");
    assert.equal(t.valueZats, 10000n);
    assert.equal(t.feeZats, 10000n);
    assert.equal(t.time, "2026-10-27T12:50:38.000Z");
    assert.deepEqual(t.outgoing, [{ recipient: RECIPIENT, valueZats: 10000n, memo: "zshield reliable sends" }]);
    // Newest first.
    assert.equal(txs[0].txid, TXID);
  });

  it("transactions: the send matches its audit row on recipient, amount and memo", () => {
    const t = parseTransactions(fixture("transactions.txt")).find((x) => x.txid === TXID)!;
    const m = matchSend(t, { amountZats: 10000n, recipient: RECIPIENT, memo: "zshield reliable sends" }, SENT_AT);
    assert.equal(m?.confidence, "high");
    assert.deepEqual(m?.matched, ["recipient", "amount", "memo", "time"]);
    assert.equal(matchSend(t, { amountZats: 10000n, recipient: RECIPIENT, memo: "other" }, SENT_AT), undefined);
  });

  it("balance, spendable, info and height", () => {
    assert.deepEqual(parseBalance(fixture("balance.txt")), { confirmedZats: 12370000n, unconfirmedZats: 0n });
    assert.equal(parseSpendable(fixture("spendable-synced.txt")), 12370000n);
    assert.equal(parseSpendable(fixture("spendable-after-cut-sync.txt")), 0n);
    assert.equal(parseLatestBlockHeight(fixture("info-nosync.txt")), 4547637);
    assert.equal(parseWalletHeight(fixture("height-synced.txt")), 4547641);
  });
});

describe("zcash_payment_status syncs first, on real zingo-cli output", () => {
  function setup(syncComplete: boolean | "busy") {
    const config = tempConfig({ chainMode: "live" });
    const base = { tool: "zcash_pay" as const, call_id: "806e0f74", amount_zec: "0.0001", amount_zats: "10000", recipient: RECIPIENT, allowlist_hit: true, cap_zec: "0.01", view_key_fingerprint: "3cafd3c7bb2e8887", memo: "zshield reliable sends", idempotency_key: "reliable-sends-20261027-01" };
    const dir = mkdtempSync(join(tmpdir(), "zshield-wallet-"));
    seedCall(
      config,
      { ...base, ts: new Date(SENT_AT).toISOString(), status: "pending", params_sha256: "p" },
      { stateDir: dir },
      { ...base, ts: new Date(SENT_AT + 70_000).toISOString(), status: "ok", mock_txid: TXID }
    );
    const calls: string[][] = [];
    const syncs: number[] = [];
    const runner: CliRunner = async (_b, args) => {
      calls.push(args);
      const last = args.at(-1);
      const json = walletJson(args, [{ txid: TXID, height: 4547481, memos: [{ recipient: RECIPIENT, memo: "zshield reliable sends", value: 10000 }] }]);
      if (json !== undefined) return json;
      if (last === "transactions") return fixture("transactions.txt");
      if (last === "height") return fixture("height-synced.txt");
      throw new Error(`unexpected ${args.join(" ")}`);
    };
    const syncer: WalletSyncer = async (_b, _a, o) => {
      syncs.push(o.timeoutMs);
      return syncComplete === true ? { complete: true, elapsedMs: 5 } : { complete: false, elapsedMs: o.timeoutMs, detail: `sync did not finish within ${o.timeoutMs} ms` };
    };
    const chain = new LiveChainAdapter({ network: "testnet", dataDir: dir, stateDir: dir, runner, syncer });
    return { config, chain, calls, syncs };
  }

  it("reports mined with confirmations after a finished sync, reading history offline", async () => {
    const { config, chain, calls, syncs } = setup(true);
    const s = await paymentStatus(config, chain, { idempotency_key: "reliable-sends-20261027-01" });
    assert.equal(s.state, "mined");
    assert.equal(s.txid, TXID);
    assert.equal(s.block_height, 4547481);
    assert.equal(s.wallet_height, 4547641);
    assert.equal(s.confirmations, 161);
    assert.equal(s.stale, undefined);
    assert.equal(syncs.length, 1);
    assert.ok(calls.every((a) => a.includes("--offline") && !a.includes("--server")));
  });

  it("uses STATUS_SYNC_TIMEOUT_MS and flags a sync that timed out as stale, with the wallet height", async () => {
    const { config, chain, syncs } = setup(false);
    const prev = process.env.STATUS_SYNC_TIMEOUT_MS;
    process.env.STATUS_SYNC_TIMEOUT_MS = "4321";
    try {
      const s = await paymentStatus(config, chain, { call_id: "806e0f74" });
      assert.deepEqual(syncs, [4321]);
      assert.equal(s.stale, true);
      assert.equal(s.state, "mined");
      assert.equal(s.wallet_height, 4547641);
      assert.match(s.sync_note!, /did not finish within 4321 ms/);
    } finally {
      if (prev === undefined) delete process.env.STATUS_SYNC_TIMEOUT_MS;
      else process.env.STATUS_SYNC_TIMEOUT_MS = prev;
    }
  });

  it("does not wait for or disturb a send that holds the wallet: BUSY, no sync, no wallet read", async () => {
    const { config, chain, syncs, calls } = setup("busy");
    const held = await acquireWalletLock({ dir: chain.stateDir!, requireOsLock: true }, 0, "zcash_pay");
    try {
      await assert.rejects(() => paymentStatus(config, chain, { call_id: "806e0f74" }), (e: { code?: string }) => e.code === "BUSY");
    } finally {
      await held.release();
    }
    assert.deepEqual(syncs, []);
    assert.deepEqual(calls, []);
  });
});
