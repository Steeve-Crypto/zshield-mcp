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
