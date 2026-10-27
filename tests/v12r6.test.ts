import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { buildSendInput, LiveChainAdapter, parseTransactions } from "../src/chain/live.ts";
import { MockChainAdapter } from "../src/chain/mock.ts";
import { memoProblem } from "../src/policy/limits.ts";
import { paymentParamsHash, resetPaymentStores, storeFor } from "../src/payments/store.ts";
import { executePay, matchSend } from "../src/tools/pay.ts";
import { ALLOWED, tempConfig } from "./helpers.ts";
import type { TxSummary } from "../src/types.ts";

// Regression tests for V12 claims found still true at f96891d (run 6). Each uses entry
// points that exist on both sides, so the file can run against f96891d to show it fails.

const R = "utest1" + "r".repeat(100);
const T0 = Date.parse("2026-10-26T12:00:00Z");
const tx = (n: number) => n.toString(16).padStart(64, "0");

beforeEach(() => resetPaymentStores());

describe("memo: exact, validated, one form everywhere", () => {
  it("a memo with edge whitespace is refused, not trimmed", async () => {
    for (const memo of [" hi", "hi ", "hi\u00a0", "\u3000hi", "hi\u2003"]) {
      const config = tempConfig();
      const r = await executePay({ amount_zec: 0.001, recipient: ALLOWED, memo }, { config, chain: new MockChainAdapter() });
      assert.equal(r.code, "INVALID_MEMO", JSON.stringify(memo));
    }
    assert.equal(memoProblem("hi there"), undefined);
  });

  it("an unpaired surrogate is refused", async () => {
    const config = tempConfig();
    const r = await executePay({ amount_zec: 0.001, recipient: ALLOWED, memo: "a\ud800b" }, { config, chain: new MockChainAdapter() });
    assert.equal(r.code, "INVALID_MEMO");
  });

  it("the send line carries the memo exactly, and the adapter refuses one that is not matchable", async () => {
    const line = buildSendInput({ amountZats: 10000n, recipient: R, memo: "pay it" });
    assert.match(line, /"memo":"pay it"/);
    assert.doesNotMatch(buildSendInput({ amountZats: 10000n, recipient: R, memo: "" }), /memo/);
    let ran = 0;
    const a = new LiveChainAdapter({ network: "testnet", dataDir: "/w", runner: async () => { ran++; return ""; } });
    await assert.rejects(a.pay({ amountZats: 10000n, recipient: R, memo: "pay it " }), /Memo refused/);
    assert.equal(ran, 0);
  });

  it("an empty memo is no memo: same key hash, same audit row", async () => {
    assert.equal(paymentParamsHash({ amount_zec: "0.001", recipient: R, memo: "" }), paymentParamsHash({ amount_zec: "0.001", recipient: R }));
    const config = tempConfig();
    const r = await executePay({ amount_zec: 0.001, recipient: ALLOWED, memo: "" }, { config, chain: new MockChainAdapter() });
    assert.equal(r.ok, true);
    assert.equal(r.audit.memo, undefined);
  });

  it("matching compares memos exactly, with no trimming", () => {
    const t = (memo: string): TxSummary =>
      ({ txid: tx(1), time: new Date(T0 + 5000).toISOString(), status: "confirmed", blockHeight: 950, kind: "sent", valueZats: 10000n, outgoing: [{ recipient: R, valueZats: 10000n, memo }] }) as TxSummary;
    const target = { amountZats: 10000n, recipient: R, memo: "a b" };
    assert.ok(matchSend(t("a b"), target, T0));
    assert.equal(matchSend(t("a b "), target, T0), undefined);
    assert.equal(matchSend(t(" a b"), target, T0), undefined);
    assert.equal(matchSend(t("a  b"), target, T0), undefined);
  });

  it("the listing parser keeps inner spacing and reads a memo back as it was sent", () => {
    const [t] = parseTransactions(`{
    txid: ${tx(3)}
    datetime: 2026-10-26 12:00:05 UTC
    status: confirmed
    blockheight: 950
    kind: sent
    value: 10000
    outgoing orchard notes: 
\t{
            value: 10000
            memo: a  b
            recipient: ${R}
            output index: 0
        }
}`);
    assert.equal(t.outgoing?.[0].memo, "a  b");
  });
});
