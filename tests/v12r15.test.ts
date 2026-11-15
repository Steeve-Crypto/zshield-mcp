import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, it, mock } from "node:test";
import { AUDIT_SLOT_BYTES } from "../src/audit/budget.ts";
import { fallbackAuditPath, fingerprintViewKey } from "../src/audit/log.ts";
import { ensurePaymentReservation, JOURNAL_HEADER_BYTES, JOURNAL_SLOT_BYTES, paymentReservationUsage } from "../src/audit/reservation.ts";
import { paymentParamsHash, storeFor } from "../src/payments/store.ts";
import { executePay } from "../src/tools/pay.ts";
import type { ChainAdapter } from "../src/chain/types.ts";
import type { Config, PaymentRequest, TxSummary } from "../src/types.ts";
import { tempConfig } from "./helpers.ts";

const R = "utest1" + "r".repeat(100), TX = "be".repeat(32), VF = "uviewtest1" + "q".repeat(80);
const now = () => new Date().toISOString();

let txCounter = 0;
/** A live testnet chain whose two-step send reports `fee` and counts real transmissions. */
function liveChain(opts: { fee?: bigint; spendable?: bigint } = {}) {
  const sent = { count: 0 };
  const chain = {
    mode: "live", stagesBeforeBroadcast: true, tracksTransmitAuthorization: true,
    getViewingKey: async () => VF,
    getHistory: async () => [], getTransaction: async () => [],
    checkHealth: async () => ({ walletHeight: 1000, chainTip: 1000, spendableZats: opts.spendable ?? 10_000_000n }),
    syncWallet: async () => ({ complete: true, elapsedMs: 0 }), walletHeight: async () => 1000,
    pay: async (req: PaymentRequest) => {
      const txid = (++txCounter).toString(16).padStart(64, "0");
      req.fence?.();
      req.stage?.(txid);
      req.authorizeFee?.(opts.fee ?? 10_000n);
      req.fence?.();
      req.beforeTransmit?.();
      req.afterLock?.();
      sent.count++;
      return { txid, amountZats: req.amountZats, recipient: req.recipient, memo: req.memo, mode: "live" as const };
    },
  } as unknown as ChainAdapter;
  return { chain, sent };
}

function liveConfig(overrides: Partial<Config> = {}): Config {
  const config = tempConfig({ chainMode: "live", chainNetwork: "testnet", ...overrides });
  fs.writeFileSync(config.allowlistPath, JSON.stringify({ recipients: [{ address: R }] }));
  return config;
}

const protectedSlots = (config: Config) =>
  paymentReservationUsage(join(config.auditDir, "2000-01-01.jsonl"), true)
  + paymentReservationUsage(fallbackAuditPath(config.auditDir, config.auditFallbackPath), false);

function ledgerTotal(config: Config, chain: ChainAdapter): bigint {
  const file = join(storeFor(config, chain).dir, "spending-budget", "ledger.json");
  return fs.existsSync(file) ? BigInt(JSON.parse(fs.readFileSync(file, "utf8")).total) : 0n;
}

describe("V12 run 15 regressions", () => {
  it("F-59 a spending refusal before the intent never charges protected audit capacity", async () => {
    const config = liveConfig({ totalSpendingCapZec: "0.00005", auditMaxBytes: 8 * AUDIT_SLOT_BYTES, auditRefusalMaxBytes: 200 * AUDIT_SLOT_BYTES });
    const { chain, sent } = liveChain();
    const before = protectedSlots(config);
    for (let i = 0; i < 6; i++) {
      // Same key and fresh keys: neither may grow the protected pool.
      const out = await executePay({ amount_zec: "0.0001", recipient: R, idempotency_key: i % 2 ? "same" : `fresh-${i}` }, { config, chain });
      assert.equal(out.code, "SPENDING_BUDGET_REFUSED", out.text);
    }
    assert.equal(sent.count, 0);
    assert.equal(protectedSlots(config), before);
  });

  it("F-72 a fee refusal after signing never keeps the principal charge", async () => {
    // 30000 zats allowed. Principal 10000 plus the 10000 estimate fits, the real fee 25000 does not.
    const config = liveConfig({ totalSpendingCapZec: "0.0003" });
    const expensive = liveChain({ fee: 25_000n });
    for (const key of ["k1", "k2", "k3", "k4"]) {
      const out = await executePay({ amount_zec: "0.0001", recipient: R, idempotency_key: key }, { config, chain: expensive.chain });
      assert.equal(out.ok, false, out.text);
      assert.equal(out.code, "SPENDING_BUDGET_REFUSED", out.text);
    }
    assert.equal(expensive.sent.count, 0);
    assert.equal(ledgerTotal(config, expensive.chain), 0n);
    // The allowance is intact: an ordinary payment still goes through and is charged once.
    const cheap = liveChain({ fee: 10_000n });
    const ok = await executePay({ amount_zec: "0.0001", recipient: R, idempotency_key: "k5" }, { config, chain: cheap.chain });
    assert.equal(ok.ok, true, ok.text);
    assert.equal(ledgerTotal(config, cheap.chain), 20_000n);
  });

  it("F-72 repeated INSUFFICIENT_FUNDS retries never charge the allowance", async () => {
    const config = liveConfig({ totalSpendingCapZec: "0.0003" });
    const { chain, sent } = liveChain({ spendable: 5_000n });
    for (let i = 0; i < 5; i++) {
      const out = await executePay({ amount_zec: "0.0001", recipient: R, idempotency_key: i % 2 ? "same" : `fresh-${i}` }, { config, chain });
      assert.equal(out.code, "INSUFFICIENT_FUNDS", out.text);
    }
    assert.equal(sent.count, 0);
    assert.equal(ledgerTotal(config, chain), 0n);
  });
});
