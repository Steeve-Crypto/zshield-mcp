import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockChainAdapter } from "../src/chain/mock.ts";
import { executePay } from "../src/tools/pay.ts";
import type { Config } from "../src/types.ts";

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

describe("executePay amounts in zatoshis", () => {
  const recipient = "u1mockrecipientaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  it("accepts a decimal string and records exact zatoshis", async () => {
    const config = tempConfig();
    const result = await executePay(
      { amount_zec: "0.05", recipient },
      { config, chain: new MockChainAdapter() }
    );
    assert.equal(result.ok, true);
    assert.equal(result.audit.amount_zats, "5000000");
  });

  it("rejects and audits an amount with more than 8 decimals", async () => {
    const config = tempConfig();
    const result = await executePay(
      { amount_zec: "0.050000001", recipient },
      { config, chain: new MockChainAdapter() }
    );
    assert.equal(result.ok, false);
    assert.equal(result.audit.status, "rejected");
    assert.equal(result.audit.amount_zats, undefined);
    assert.match(result.audit.error ?? "", /more than 8 decimal places/);
    const day = result.audit.ts.slice(0, 10);
    const lines = readFileSync(join(config.auditDir, `${day}.jsonl`), "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
  });

  it("rejects zero and negative amounts", async () => {
    const config = tempConfig();
    for (const amount_zec of [0, "0", -0.01, "-1"]) {
      const result = await executePay({ amount_zec, recipient }, { config, chain: new MockChainAdapter() });
      assert.equal(result.audit.status, "rejected", String(amount_zec));
    }
  });

  it("rejects when the configured cap has more than 8 decimals", async () => {
    const config = tempConfig({ spendingCapZec: "0.100000001" });
    const result = await executePay(
      { amount_zec: "0.01", recipient },
      { config, chain: new MockChainAdapter() }
    );
    assert.equal(result.audit.status, "rejected");
    assert.match(result.audit.error ?? "", /Invalid spending cap/);
  });
});
