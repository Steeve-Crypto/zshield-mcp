import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { appendAuditEntry } from "../src/audit/log.ts";
import type { ChainAdapter } from "../src/chain/types.ts";
import { recoverPendingPayments, RECOVERY_EXPIRY_MS } from "../src/payments/recovery.ts";
import { resetPaymentStores, storeFor, type CallIntent } from "../src/payments/store.ts";
import type { AuditEntry, ChainHealth, Config, TxSummary } from "../src/types.ts";
import { tempConfig } from "./helpers.ts";

// One history entry is not proof of which payment it was. A call whose transaction id was
// bound before it was transmitted needs no matching at all; a call without one is matched on
// the recipient, amount and memo, and only a memo makes that more than a coincidence.

const R = "utest1" + "r".repeat(100);
const T0 = Date.parse("2026-10-26T12:00:00Z");
const TXID = "5c".repeat(32);
const synced: ChainHealth = { walletHeight: 1000, chainTip: 1001, spendableZats: 0n };

const mined = (memo: string, extra: Partial<TxSummary> = {}): TxSummary => ({
  txid: TXID,
  time: new Date(T0 + 5000).toISOString(),
  status: "confirmed",
  blockHeight: 950,
  kind: "sent",
  valueZats: -10000n,
  verified: true,
  outgoing: [{ recipient: R, valueZats: 10000n, memo }],
  ...extra,
});

function chain(history: TxSummary[]): ChainAdapter {
  return {
    async pay() {
      throw new Error("recovery must never send");
    },
    getHistory: async () => history,
    checkHealth: async () => synced,
    getViewingKey: async () => "uview",
  } as unknown as ChainAdapter;
}

/** A call recorded by an older server (from the audit log): no transmit step was ever recorded. */
function legacyCall(config: Config, memo: string | undefined) {
  const row: AuditEntry = {
    ts: new Date(T0).toISOString(), tool: "zcash_pay", call_id: "legacy", amount_zec: "0.0001", amount_zats: "10000",
    recipient: R, allowlist_hit: true, cap_zec: "0.01", status: "pending", view_key_fingerprint: "abc",
    memo, chain_tip: 900, wallet_height: 900, idempotency_key: "k-legacy",
  };
  appendAuditEntry(config.auditDir, row);
}

/** A call recorded by the two-step send, which stopped before it recorded any transaction id. */
function unstagedTwoStepCall(config: Config, c: ChainAdapter, memo: string | undefined) {
  const intent: CallIntent = {
    call_id: "two", ts: new Date(T0).toISOString(), amount_zec: "0.0001", amount_zats: "10000", recipient: R, memo,
    allowlist_hit: true, cap_zec: "0.01", view_key_fingerprint: "abc", idempotency_key: "k-two", params_sha256: "p",
    chain_tip: 900, wallet_height: 900, two_step: true,
  };
  const store = storeFor(config, c);
  store.writeIntent(intent);
  store.bindKey("k-two", "two", "p");
}

beforeEach(() => resetPaymentStores());

describe("recovery identity", () => {
  it("a lone mined entry with no memo is not proof for an old call: amount and recipient could be anyone's", async () => {
    const config = tempConfig();
    legacyCall(config, undefined);
    const [row] = await recoverPendingPayments(config, chain([mined("")]), { now: T0 + 60_000 });
    assert.equal(row.status, "unknown", JSON.stringify(row));
    assert.deepEqual(row.possible_sends?.map((p) => p.txid), [TXID]);
  });

  it("a lone mined entry with the exact memo, in time and verified, still confirms an old call", async () => {
    const config = tempConfig();
    legacyCall(config, "rent");
    const [row] = await recoverPendingPayments(config, chain([mined("rent")]), { now: T0 + 60_000 });
    assert.equal(row.status, "confirmed", JSON.stringify(row));
    assert.equal(row.txid, TXID);
  });

  it("a two-step call with no recorded transaction id never takes a lookalike, whatever its memo", async () => {
    for (const memo of ["rent", undefined]) {
      resetPaymentStores();
      const config = tempConfig();
      const c = chain([mined(memo ?? "")]);
      unstagedTwoStepCall(config, c, memo);
      const [row] = await recoverPendingPayments(config, c, { now: T0 + 60_000 });
      assert.equal(row.status, "unknown", JSON.stringify(row));
      assert.notEqual(row.txid, TXID);
    }
  });

  it("a two-step call with no transaction id and no lookalike is proven not sent as before", async () => {
    const config = tempConfig();
    const c = chain([]);
    unstagedTwoStepCall(config, c, "rent");
    const [row] = await recoverPendingPayments(config, c, { now: T0 + RECOVERY_EXPIRY_MS + 1 });
    assert.equal(row.status, "not_found", JSON.stringify(row));
  });
});
