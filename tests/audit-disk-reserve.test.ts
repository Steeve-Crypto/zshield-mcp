import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, mock } from "node:test";
import { fingerprintViewKey, writeAuditRow } from "../src/audit/log.ts";
import { acquireWalletLock } from "../src/payments/lock.ts";
import { resumeOriginal } from "../src/payments/resume.ts";
import { storeFor, paymentParamsHash, mayHaveBroadcast } from "../src/payments/store.ts";
import { executePay } from "../src/tools/pay.ts";
import type { ChainAdapter } from "../src/chain/types.ts";
import type { Config, TxSummary } from "../src/types.ts";
import { tempConfig } from "./helpers.ts";

const now = () => new Date().toISOString();
describe("payment audit disk protection", () => {
  it("F-82 refusal rows cannot use disk still promised to payment rows", () => {
    const config: Config = tempConfig();
    const row = (status: string) => ({ ts: now(), tool: "zcash_pay", call_id: `c-${status}`, status,
      amount_zec: "0.0001", recipient: "x", allowlist_hit: false, cap_zec: "0.1" }) as never;
    // The filesystem has only a little more room than the payment pools still promise.
    const statfs = mock.method(fs, "statfsSync", () => ({ bavail: 1024 * 1024, bsize: 1 }));
    try {
      const refused = writeAuditRow(config, row("rejected"), () => {});
      assert.equal(refused.durable, false, "a refusal must not take payment-promised space");
      const paid = writeAuditRow(config, row("ok"));
      assert.equal(paid.durable, true, "payment evidence still has its space");
    } finally {
      statfs.mock.restore();
    }
    // With real free space, refusals are recorded normally and fail closed only when full.
    assert.equal(writeAuditRow(config, row("rejected")).durable, true);
  });
});
