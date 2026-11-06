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

describe("audit decision contract", () => {
  it("F-75 ordinary rejected payments fail closed when refusal audit is unavailable", async () => {
    const config = tempConfig();
    fs.mkdirSync(config.auditDir, { recursive: true });
    fs.writeFileSync(join(config.auditDir, new Date().toISOString().slice(0,10) + ".jsonl"), "x");
    config.auditMaxBytes = AUDIT_SLOT_BYTES;
    config.auditRefusalMaxBytes = AUDIT_SLOT_BYTES;
    config.auditFallbackPath = join(config.auditDir, "fallback.jsonl");
    fs.writeFileSync(config.auditFallbackPath, "x");
    // One existing byte leaves no full reservation in either sink.
    const result = await executePay({ amount_zec: "99", recipient: "not-allowed", idempotency_key: "denied" },
      { config, chain: new MockChainAdapter() });
    assert.equal(result.code, "AUDIT_WRITE_FAILED", result.text);
    assert.doesNotMatch(result.text, /CAP_EXCEEDED|NOT_ALLOWED/);
  });
  it("F-85 unaudited key decisions are absent from response and returned audit", async () => {
    const config = tempConfig();
    fs.writeFileSync(config.auditDir, "not a directory");
    config.auditFallbackPath = join(config.auditDir, "blocked");
    const result = await executePay({ amount_zec: "0.001", recipient: R, idempotency_key: "bad key" },
      { config, chain: new MockChainAdapter() });
    assert.equal(result.code, "AUDIT_WRITE_FAILED");
    assert.doesNotMatch(JSON.stringify(result), /INVALID_IDEMPOTENCY_KEY|refused_code/);
    assert.equal(result.audit.code, "AUDIT_WRITE_FAILED");
  });
});
