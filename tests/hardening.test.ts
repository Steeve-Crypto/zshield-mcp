import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import * as live from "../src/chain/live.ts";
import { LiveChainAdapter, type CliRunner } from "../src/chain/live.ts";
import { SendOutcomeUnknownError } from "../src/chain/outcome.ts";
import type { ChainAdapter } from "../src/chain/types.ts";
import { acquireWalletLock } from "../src/payments/lock.ts";
import { recoverPendingPayments, RECOVERY_EXPIRY_MS } from "../src/payments/recovery.ts";
import { resetPaymentStores, storeFor } from "../src/payments/store.ts";
import { executePay } from "../src/tools/pay.ts";
import { paymentStatus } from "../src/tools/status.ts";
import type { AuditEntry, ChainHealth, Config, PaymentRequest } from "../src/types.ts";
import { seedCall, tempConfig } from "./helpers.ts";

// Hardening pass regression tests. Each one fails on the code before its commit.

const R = "utest1" + "r".repeat(100);
const T0 = Date.parse("2026-10-26T12:00:00Z");
const tx = (n: number) => n.toString(16).padStart(2, "0").repeat(32);

beforeEach(() => resetPaymentStores());

function liveCfg(): Config {
  const config = tempConfig({ chainMode: "live", chainNetwork: "testnet" });
  writeFileSync(config.allowlistPath, JSON.stringify({ recipients: [{ address: R }] }));
  return config;
}

function pendingRow(config: Config, callId: string, tip: number): void {
  const row: AuditEntry = {
    ts: new Date(T0).toISOString(), tool: "zcash_pay", call_id: callId, amount_zec: "0.0001", amount_zats: "10000", recipient: R,
    allowlist_hit: true, cap_zec: "0.01", status: "pending", view_key_fingerprint: "abc", memo: "rent", chain_tip: tip, wallet_height: tip,
  };
  seedCall(config, row);
}

function readOnlyChain(health: ChainHealth): ChainAdapter {
  return {
    async pay() { throw new Error("recovery must never send"); },
    async getBalance() { throw new Error("unused"); },
    async getReceiveAddress() { throw new Error("unused"); },
    async getHistory() { return []; },
    async getViewingKey() { return "uview"; },
    async checkHealth() { return health; },
  } as unknown as ChainAdapter;
}

describe("expiry: the pinned wallet lets a transaction live 120 blocks past its target", () => {
  const later = T0 + RECOVERY_EXPIRY_MS + 1;
  // The call recorded tip 1000. Target 1001, expiry 1121, then the margin (60): proof from 1182.
  it("is not proven not sent at the old 40 block expiry plus margin, nor at the new expiry plus a reorg margin", async () => {
    for (const walletHeight of [1071, 1121, 1160, 1181]) {
      resetPaymentStores();
      const config = tempConfig();
      pendingRow(config, "c1", 1000);
      const [row] = await recoverPendingPayments(config, readOnlyChain({ walletHeight, chainTip: walletHeight + 1, spendableZats: 0n }), { now: later });
      assert.equal(row.status, "unknown", `wallet height ${walletHeight} must not prove anything`);
    }
  });

  it("is proven not sent once the wallet is past the expiry plus margin, with the wall clock floor met", async () => {
    const config = tempConfig();
    pendingRow(config, "c1", 1000);
    const chain = readOnlyChain({ walletHeight: 1182, chainTip: 1183, spendableZats: 0n });
    const [early] = await recoverPendingPayments(config, chain, { now: T0 + 60_000 });
    assert.equal(early.status, "unknown", "the wall clock floor still applies");
    const [row] = await recoverPendingPayments(config, chain, { now: later });
    assert.equal(row.status, "not_found");
  });
});

describe("a signed payment that is not resolved blocks new sends from the wallet", () => {
  function liveChain(failWith?: Error, base = 0x31) {
    const counts = { sent: 0 };
    const chain = {
      mode: "live",
      async getViewingKey() { return "uviewtest1" + "q".repeat(80); },
      async checkHealth() { return { walletHeight: 1000, chainTip: 1000, spendableZats: 10_000_000n }; },
      async pay(req: PaymentRequest) {
        req.stage?.(tx(base + counts.sent));
        if (failWith) throw failWith;
        counts.sent++;
        return { txid: tx(base + counts.sent), amountZats: req.amountZats, recipient: req.recipient, mode: "live" };
      },
      async getBalance() { throw new Error("unused"); },
      async getReceiveAddress() { throw new Error("unused"); },
      async getHistory() { return []; },
    } as unknown as ChainAdapter;
    return { chain, counts };
  }

  it("after a transmit error, another key is refused until the first is resolved", async () => {
    const config = liveCfg();
    const bad = liveChain(new SendOutcomeUnknownError("transmit failed", tx(0x31)));
    const first = await executePay({ amount_zec: "0.0001", recipient: R, idempotency_key: "k1" }, { config, chain: bad.chain });
    assert.equal(first.code, "SEND_UNCONFIRMED");
    const store = storeFor(config, bad.chain);
    assert.equal(store.readCall(JSON.parse(first.text).call_id)?.state, "unknown", "a transmit error is unknown, never not_sent");

    const good = liveChain(undefined, 0x51);
    const second = await executePay({ amount_zec: "0.0001", recipient: R, idempotency_key: "k2" }, { config, chain: good.chain });
    assert.equal(second.code, "UNRESOLVED_PAYMENT");
    assert.equal(good.counts.sent, 0, "nothing may be sent beside an unresolved payment");

    // Once the first payment is settled (mined), sending resumes.
    store.advance({ ts: new Date().toISOString(), call_id: JSON.parse(first.text).call_id, state: "mined", txid: tx(0x31), by: "status" });
    const third = await executePay({ amount_zec: "0.0001", recipient: R, idempotency_key: "k3" }, { config, chain: good.chain });
    assert.equal(third.code, undefined, third.text);
    assert.equal(good.counts.sent, 1);
  });

  it("a send that failed before it was signed does not block the wallet", async () => {
    const config = liveCfg();
    const chain = {
      mode: "live",
      async getViewingKey() { return "uviewtest1" + "q".repeat(80); },
      async checkHealth() { return { walletHeight: 1000, chainTip: 1000, spendableZats: 10_000_000n }; },
      async pay() { throw new Error("zingo-cli send error: insufficient funds. Nothing was sent."); },
    } as unknown as ChainAdapter;
    await executePay({ amount_zec: "0.0001", recipient: R, idempotency_key: "k1" }, { config, chain });
    const ok = liveChain(undefined, 0x51);
    const next = await executePay({ amount_zec: "0.0001", recipient: R, idempotency_key: "k2" }, { config, chain: ok.chain });
    assert.equal(next.code, undefined);
  });
});

describe("transmit always carries the txid", () => {
  it("transmitCommand refuses anything but a 64 digit lowercase hex txid", () => {
    const fn = (live as unknown as { transmitCommand?: (t: string) => string }).transmitCommand;
    assert.equal(typeof fn, "function");
    assert.equal(fn!(tx(0xab)), `transmit ${tx(0xab)}\nquit\n`);
    for (const bad of ["", " ", "transmit", "ab".repeat(31), "AB".repeat(32), `${tx(1)}\ntransmit`, `${tx(1)} `]) {
      assert.throws(() => fn!(bad), /valid transaction id/, JSON.stringify(bad));
    }
  });

  it("every transmit the adapter runs names the staged txid, and none is bare", async () => {
    const staged = tx(0x44);
    const inputs: string[] = [];
    const runner: CliRunner = async (_bin, args, opts) => {
      if (args.includes("export_ufvk")) return JSON.stringify({ ufvk: "uviewtest1" + "q".repeat(80), birthday: 1 });
      if (opts?.input !== undefined) inputs.push(opts.input);
      if (opts?.input?.startsWith("send '")) return `{\n  "fee": 10000\n}\n{\n  "txids": [\n    "${staged}"\n  ]\n}\n`;
      return `{\n  "txids": [\n    "${staged}"\n  ]\n}\n`;
    };
    const a = new LiveChainAdapter({ network: "testnet", runner });
    await a.pay({ amountZats: 10_000n, recipient: R });
    const transmits = inputs.flatMap((i) => i.split("\n")).filter((l) => /\btransmit\b/.test(l));
    assert.deepEqual(transmits, [`transmit ${staged}`]);
    for (const i of inputs) assert.ok(!/(^|\n)transmit\s*(\n|$)/.test(i), "a bare transmit");
  });
});

describe("startup check: the testnet server is on the expected consensus branch", () => {
  const runnerWith = (info: string): CliRunner => async (_bin, args) => {
    if (args.includes("info")) return info;
    if (args.includes("height")) return '{ "height": 1000 }';
    return '{ "spendable_balance": 100000000 }';
  };
  const mk = (info: string) => new LiveChainAdapter({ network: "testnet", runner: runnerWith(info) });

  it("a server on another consensus branch refuses the send", async () => {
    await assert.rejects(mk('{ "chain_name": "test", "consensus_branch_id": "c8e71055", "latest_block_height": 1000 }').checkHealth({ sync: false }), /consensus branch c8e71055/);
  });

  it("a server that reports another chain is refused", async () => {
    await assert.rejects(mk('{ "chain_name": "main", "consensus_branch_id": "77190ad9", "latest_block_height": 1000 }').checkHealth({ sync: false }), /not testnet/);
  });

  it("the expected branch passes, and an info that names none is not refused", async () => {
    const ok = await mk('{ "chain_name": "test", "consensus_branch_id": "77190ad9", "latest_block_height": 1000 }').checkHealth({ sync: false });
    assert.equal(ok.chainTip, 1000);
    const bare = await mk('{ "latest_block_height": 1000 }').checkHealth({ sync: false });
    assert.equal(bare.chainTip, 1000);
  });
});

describe("the lock file and the operation index", () => {
  it("a lock file that is not a regular file is refused at once, never waited on", async () => {
    const config = tempConfig();
    const store = storeFor(config, {});
    const fifo = join(store.dir, "send.flock");
    execFileSync("mkfifo", [fifo]);
    const t0 = Date.now();
    await assert.rejects(acquireWalletLock({ dir: store.dir, requireOsLock: true }, 200, "test"), /could not be opened/);
    assert.ok(Date.now() - t0 < 2000, "must not hang on a FIFO");
  });

  it("an operation index entry that points at another call finds nothing", async () => {
    const config = tempConfig();
    const store = storeFor(config, {});
    const mk = (id: string, op: string) => seedCallWithOp(config, id, op);
    mk("call-a", "op_" + "a".repeat(32));
    mk("call-b", "op_" + "b".repeat(32));
    // Point b's id at call a: the answer must not be call a.
    const dir = (store as unknown as { sub(n: string): string }).sub("ops");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `op_${"c".repeat(32)}.json`), JSON.stringify({ call_id: "call-a" }));
    await assert.rejects(paymentStatus(config, readOnlyChain({ walletHeight: 1000, chainTip: 1000, spendableZats: 0n }), { operation_id: "op_" + "c".repeat(32) } as never), /No zcash_pay call/);
    const good = await paymentStatus(config, readOnlyChain({ walletHeight: 1000, chainTip: 1000, spendableZats: 0n }), { operation_id: "op_" + "a".repeat(32) } as never);
    assert.equal(good.call_id, "call-a");
  });
});

function seedCallWithOp(config: Config, callId: string, op: string): void {
  const store = storeFor(config, {});
  store.writeIntent({
    call_id: callId, operation_id: op, ts: new Date(T0).toISOString(), amount_zec: "0.0001", amount_zats: "10000", recipient: R,
    allowlist_hit: true, cap_zec: "0.01", view_key_fingerprint: "abc",
  } as never);
  store.advance({ ts: new Date(T0).toISOString(), call_id: callId, state: "sent", txid: tx(callId === "call-a" ? 1 : 2), by: "send" });
}
