import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, mock } from "node:test";
import { AUDIT_SLOT_BYTES, reserveAudit } from "../src/audit/budget.ts";
import { operationalHealth } from "../src/operations/health.ts";
import { MockChainAdapter } from "../src/chain/mock.ts";
import { fingerprintViewKey, writeAuditRow } from "../src/audit/log.ts";
import { acquireWalletLock } from "../src/payments/lock.ts";
import { resumeOriginal } from "../src/payments/resume.ts";
import { storeFor, paymentParamsHash, mayHaveBroadcast } from "../src/payments/store.ts";
import { executePay } from "../src/tools/pay.ts";
import type { ChainAdapter } from "../src/chain/types.ts";
import type { Config, TxSummary } from "../src/types.ts";
import { tempConfig } from "./helpers.ts";

const R = "utest1" + "r".repeat(100);

describe("usable audit capacity", () => {
  it("F-83 health reports usable slots rather than stranded remainder", () => {
    const config = tempConfig();
    config.auditMaxBytes = 2 * AUDIT_SLOT_BYTES;
    fs.mkdirSync(config.auditDir, { recursive: true, mode: 0o700 });
    const file = join(config.auditDir, "2026-11-06.jsonl");
    fs.writeFileSync(file, "x".repeat(Math.floor(AUDIT_SLOT_BYTES / 2)), { mode: 0o600 });
    reserveAudit(file, "payment", config, true);
    const store = storeFor(config, new MockChainAdapter());
    const health = operationalHealth(config, store);
    assert.equal(health.audit.primary?.payment.remaining_bytes, 0);
    assert.ok(health.alerts.includes("AUDIT_PRIMARY_PAYMENT_LOW"));
  });
});
