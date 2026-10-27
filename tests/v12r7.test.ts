import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { resetPaymentStores } from "../src/payments/store.ts";
import { executePay } from "../src/tools/pay.ts";
import type { ChainAdapter } from "../src/chain/types.ts";
import { readAuditRows, tempConfig, TEST_UFVK } from "./helpers.ts";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Regression tests for run 7. Each uses entry points that exist at f96891d, so the file
// can be run against it to show the new behavior fails there.

const R = "utest1" + "r".repeat(100);

beforeEach(() => resetPaymentStores());

function liveConfig() {
  const dir = mkdtempSync(join(tmpdir(), "zshield-r7-"));
  const allow = join(dir, "allow.json");
  writeFileSync(allow, JSON.stringify({ recipients: [{ address: R }] }));
  return tempConfig({ chainMode: "live", chainNetwork: "testnet", allowlistPath: allow });
}

describe("live sends need an idempotency key", () => {
  it("a live payment without a key is refused before anything is sent", async () => {
    const config = liveConfig();
    let sends = 0;
    const chain = {
      mode: "live",
      async pay() { sends++; return { txid: "a".repeat(64) }; },
      getViewingKey: async () => TEST_UFVK,
    } as unknown as ChainAdapter;
    const r = await executePay({ amount_zec: "0.0001", recipient: R }, { config, chain });
    assert.equal(r.ok, false);
    assert.equal(r.code, "IDEMPOTENCY_KEY_REQUIRED");
    assert.equal(sends, 0);
    assert.deepEqual(readAuditRows(config).map((x) => x.status), ["rejected"]);
  });

  it("a mock payment still works without a key", async () => {
    const { MockChainAdapter } = await import("../src/chain/mock.ts");
    const { ALLOWED } = await import("./helpers.ts");
    const r = await executePay({ amount_zec: "0.001", recipient: ALLOWED }, { config: tempConfig(), chain: new MockChainAdapter() });
    assert.equal(r.ok, true);
  });
});
