import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockChainAdapter } from "../src/chain/mock.ts";
import { executePay } from "../src/tools/pay.ts";
import type { ChainAdapter } from "../src/chain/types.ts";
import type { AuditEntry, Config, PaymentRequest } from "../src/types.ts";

function tempConfig(overrides: Partial<Config> = {}): Config {
  const root = mkdtempSync(join(tmpdir(), "zshield-pay-"));
  const allowPath = join(root, "allow.json");
  writeFileSync(
    allowPath,
    JSON.stringify({
      recipients: [
        {
          address: "u1mockrecipientaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          label: "Demo",
        },
      ],
    })
  );
  return {
    spendingCapZec: 0.1,
    allowlistPath: allowPath,
    chainMode: "mock",
    auditDir: join(root, "audits"),
    viewKeyFingerprintSalt: "test-salt",
    ...overrides,
  };
}

describe("executePay (mock)", () => {
  it("happy path: under cap + allow-listed", async () => {
    const config = tempConfig();
    const result = await executePay(
      {
        amount_zec: 0.05,
        recipient:
          "u1mockrecipientaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        memo: "test",
      },
      { config, chain: new MockChainAdapter() }
    );
    assert.equal(result.ok, true);
    assert.equal(result.audit.status, "ok");
    assert.ok(result.audit.mock_txid?.startsWith("mock_"));
    assert.equal(result.audit.allowlist_hit, true);
    assert.match(result.audit.view_key_fingerprint, /^[a-f0-9]{16}$/);

    const day = result.audit.ts.slice(0, 10);
    const log = readFileSync(join(config.auditDir, `${day}.jsonl`), "utf8");
    assert.ok(log.includes(result.audit.mock_txid!));
    assert.ok(!log.includes("vk_mock_")); // raw view-key material must not appear
  });

  it("rejects over-cap", async () => {
    const config = tempConfig();
    const result = await executePay(
      {
        amount_zec: 1,
        recipient:
          "u1mockrecipientaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      { config, chain: new MockChainAdapter() }
    );
    assert.equal(result.ok, false);
    assert.equal(result.audit.status, "rejected");
    assert.match(result.audit.error ?? "", /spending cap/i);
  });

  it("rejects unknown recipient", async () => {
    const config = tempConfig();
    const result = await executePay(
      { amount_zec: 0.01, recipient: "u1notallowed" },
      { config, chain: new MockChainAdapter() }
    );
    assert.equal(result.ok, false);
    assert.equal(result.audit.status, "rejected");
    assert.equal(result.audit.allowlist_hit, false);
    assert.match(result.audit.error ?? "", /allow-list/i);
  });
});

describe("executePay with a broken allow-list", () => {
  it("rejects and still writes an audit entry", async () => {
    const config = tempConfig({ allowlistPath: "/nonexistent/allow.json" });
    const result = await executePay(
      { amount_zec: 0.01, recipient: "u1x" },
      { config, chain: new MockChainAdapter() }
    );
    assert.equal(result.ok, false);
    assert.equal(result.audit.status, "rejected");
    assert.equal(result.audit.allowlist_hit, false);
    const day = result.audit.ts.slice(0, 10);
    const lines = readFileSync(join(config.auditDir, `${day}.jsonl`), "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
  });
});

const ALLOWED = "u1mockrecipientaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function readAudit(config: Config): AuditEntry[] {
  const day = new Date().toISOString().slice(0, 10);
  const file = join(config.auditDir, `${day}.jsonl`);
  return readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
}

describe("audit row is written before the chain send", () => {
  it("writes a pending row before broadcast and an error row when the send throws", async () => {
    const config = tempConfig();
    let seenAtSend: AuditEntry[] = [];
    const chain: ChainAdapter = {
      mode: "mock",
      async pay(_req: PaymentRequest) {
        seenAtSend = readAudit(config);
        throw new Error("broadcast failed");
      },
    };
    const result = await executePay({ amount_zec: 0.05, recipient: ALLOWED }, { config, chain });

    assert.equal(seenAtSend.length, 1);
    assert.equal(seenAtSend[0].status, "pending");
    assert.equal(seenAtSend[0].amount_zec, 0.05);
    assert.equal(seenAtSend[0].recipient, ALLOWED);

    assert.equal(result.ok, false);
    assert.equal(result.audit.status, "error");
    assert.match(result.audit.error ?? "", /broadcast failed/);

    const rows = readAudit(config);
    assert.deepEqual(rows.map((r) => r.status), ["pending", "error"]);
    assert.equal(rows[0].call_id, rows[1].call_id);
    assert.equal(rows[1].call_id, result.audit.call_id);
  });

  it("writes pending then ok rows on success", async () => {
    const config = tempConfig();
    const result = await executePay(
      { amount_zec: 0.05, recipient: ALLOWED },
      { config, chain: new MockChainAdapter() }
    );
    assert.equal(result.ok, true);
    const rows = readAudit(config);
    assert.deepEqual(rows.map((r) => r.status), ["pending", "ok"]);
    assert.equal(rows[0].mock_txid, undefined);
    assert.equal(rows[1].mock_txid, result.audit.mock_txid);
    assert.equal(rows[0].call_id, rows[1].call_id);
  });

  it("writes one rejected row and never calls the chain on a policy rejection", async () => {
    const config = tempConfig();
    let calls = 0;
    const chain: ChainAdapter = {
      mode: "mock",
      async pay() {
        calls++;
        throw new Error("should not be called");
      },
    };
    const result = await executePay({ amount_zec: 1, recipient: ALLOWED }, { config, chain });
    assert.equal(result.audit.status, "rejected");
    assert.equal(calls, 0);
    const rows = readAudit(config);
    assert.deepEqual(rows.map((r) => r.status), ["rejected"]);
  });

  it("does not send when the pending row cannot be written", async () => {
    const root = mkdtempSync(join(tmpdir(), "zshield-noaudit-"));
    const blocker = join(root, "not-a-dir");
    writeFileSync(blocker, "x");
    const config = tempConfig({ auditDir: join(blocker, "audits") });
    let calls = 0;
    const chain: ChainAdapter = {
      mode: "mock",
      async pay() {
        calls++;
        throw new Error("should not be called");
      },
    };
    const result = await executePay({ amount_zec: 0.05, recipient: ALLOWED }, { config, chain });
    assert.equal(calls, 0);
    assert.equal(result.ok, false);
    assert.equal(result.audit.status, "error");
    assert.match(result.audit.error ?? "", /payment not sent/);
  });
});
