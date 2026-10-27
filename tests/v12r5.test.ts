import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { appendAuditEntry } from "../src/audit/log.ts";
import { parseTransactions } from "../src/chain/live.ts";
import type { ChainAdapter } from "../src/chain/types.ts";
import { MockChainAdapter } from "../src/chain/mock.ts";
import { recoverPendingPayments } from "../src/payments/recovery.ts";
import { resetPaymentStores, storeFor } from "../src/payments/store.ts";
import { executePay, matchSend } from "../src/tools/pay.ts";
import type { AuditEntry, ChainHealth, Config, TxSummary } from "../src/types.ts";
import { ALLOWED, tempConfig } from "./helpers.ts";

// One regression test (or more) per V12 run 5 finding on d63f5d8. Each uses entry points
// that exist on both sides, so the file can be run against d63f5d8 to show it fails there.

const R = "utest1" + "r".repeat(100);
const OTHER = "utest1" + "o".repeat(100);
const T0 = Date.parse("2026-10-26T12:00:00Z");
const synced: ChainHealth = { walletHeight: 1000, chainTip: 1001, spendableZats: 0n };

beforeEach(() => resetPaymentStores());

function pending(config: Config, callId: string, extra: Partial<AuditEntry> = {}) {
  appendAuditEntry(config.auditDir, {
    ts: new Date(T0).toISOString(), tool: "zcash_pay", call_id: callId, amount_zec: "0.0001", amount_zats: "10000",
    recipient: R, allowlist_hit: true, cap_zec: "0.01", status: "pending", view_key_fingerprint: "abc", chain_tip: 900,
    ...extra,
  } as AuditEntry);
}

function sent(txid: string, over: Partial<TxSummary> = {}, memo = ""): TxSummary {
  return {
    txid, time: new Date(T0 + 5000).toISOString(), status: "confirmed", blockHeight: 950, kind: "sent",
    valueZats: 10000n, outgoing: [{ recipient: R, valueZats: 10000n, memo }], ...over,
  } as TxSummary;
}

function chainOf(history: TxSummary[], health: ChainHealth = synced) {
  return {
    async pay() { throw new Error("recovery must never send"); },
    async getBalance() { throw new Error("unused"); },
    async getReceiveAddress() { throw new Error("unused"); },
    async getHistory() { return history; },
    async checkHealth() { return health; },
    getViewingKey: async () => "uview",
  } as unknown as ChainAdapter;
}

const tx = (n: number) => n.toString(16).padStart(64, "0");

describe("F-8: a history match must be this call's send", () => {
  it("a send with no memo does not match a transaction that carries a memo", () => {
    const target = { amountZats: 10000n, recipient: R };
    assert.equal(matchSend(sent(tx(1), {}, "invoice 7"), target, T0), undefined);
    assert.ok(matchSend(sent(tx(1), {}, ""), target, T0));
  });

  it("recovery leaves a memo-less call unknown when the only match is someone else's memo payment", async () => {
    const config = tempConfig();
    pending(config, "c1");
    const rows = await recoverPendingPayments(config, chainOf([sent(tx(1), {}, "invoice 7")]), { now: T0 + 60_000 });
    assert.notEqual(rows[0].status, "confirmed");
    assert.equal(storeFor(config, chainOf([])).readCall("c1")?.state, "unknown");
  });

  it("a memo with a line break is refused, since it could forge lines of the wallet listing", async () => {
    const config = tempConfig();
    const r = await executePay({ amount_zec: 0.001, recipient: ALLOWED, memo: "hi\nrecipient: x" }, { config, chain: new MockChainAdapter() });
    assert.equal(r.code, "INVALID_MEMO");
    const tab = await executePay({ amount_zec: 0.001, recipient: ALLOWED, memo: "a\u0085b" }, { config, chain: new MockChainAdapter() });
    assert.equal(tab.code, "INVALID_MEMO");
  });

  it("a recipient line inside an old multi-line memo cannot stand in for the real recipient", () => {
    const out = `{
    txid: ${tx(9)}
    datetime: 2026-10-26 12:00:05 UTC
    status: confirmed
    blockheight: 950
    kind: sent
    value: 10000
    outgoing orchard notes: 
\t{
            value: 10000
            memo: thanks
              recipient: ${OTHER}
            recipient: ${R}
            output index: 0
        }
}`;
    const [t] = parseTransactions(out);
    assert.equal(t.outgoing?.[0].recipient, R);
  });

  it("a wallet that lists the unified address beside another recipient form still matches", () => {
    const [t] = parseTransactions(`{
    txid: ${tx(9)}
    datetime: 2026-10-26 12:00:05 UTC
    status: confirmed
    blockheight: 950
    kind: sent
    value: 10000
    outgoing orchard notes: 
\t{
            value: 10000
            memo: 
            recipient: ztestsapling1other
            recipient unified address: ${R}
            output index: 0
        }
}`);
    assert.ok(matchSend(t, { amountZats: 10000n, recipient: R }, T0));
  });

  it("a mined entry with no time is not confirmed unless its height places it after the call", async () => {
    const config = tempConfig();
    pending(config, "c1");
    const noTimeOld = sent(tx(1), { time: undefined, blockHeight: 100 });
    const rows = await recoverPendingPayments(config, chainOf([noTimeOld]), { now: T0 + 60_000 });
    assert.notEqual(rows[0].status, "confirmed");
    assert.notEqual(rows[0].note, "");
    resetPaymentStores();
    const config2 = tempConfig();
    pending(config2, "c2");
    const noTimeNoHeight = sent(tx(2), { time: undefined, blockHeight: undefined, status: "confirmed" });
    const rows2 = await recoverPendingPayments(config2, chainOf([noTimeNoHeight]), { now: T0 + 60_000 });
    assert.notEqual(rows2[0].status, "confirmed");
  });

  it("two identical unsettled calls never both take one transaction", async () => {
    const config = tempConfig();
    pending(config, "c1", { idempotency_key: "k1" });
    pending(config, "c2", { idempotency_key: "k2", ts: new Date(T0 + 1000).toISOString() });
    const rows = await recoverPendingPayments(config, chainOf([sent(tx(1))]), { now: T0 + 60_000 });
    assert.equal(rows.filter((r) => r.status === "confirmed").length, 0);
    const store = storeFor(config, chainOf([]));
    assert.equal(store.readCall("c1")?.state, "unknown");
    assert.equal(store.readCall("c2")?.state, "unknown");
  });

  it("an unclaimed sent transaction of the same amount blocks a not-sent proof", async () => {
    const config = tempConfig();
    pending(config, "c1");
    // Same amount, listed to a recipient form this code does not know.
    const odd = sent(tx(1), { outgoing: [{ recipient: "ztestsapling1unknownform", valueZats: 10000n, memo: "" }] });
    const rows = await recoverPendingPayments(config, chainOf([odd], { walletHeight: 5000, chainTip: 5000, spendableZats: 0n }), { now: T0 + 3 * 3_600_000 });
    assert.equal(rows[0].status, "unknown");
    assert.equal(storeFor(config, chainOf([])).readCall("c1")?.state, "unknown");
  });
});
