import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { writeFileSync } from "node:fs";
import { describePolicy, PAYMENT_TOOLS, READ_ONLY_TOOLS } from "../src/policy/describe.ts";
import { ALLOWED, connect, tempConfig } from "./helpers.ts";

describe("describePolicy", () => {
  it("shows mode, mainnet refused, cap, and allow-list size in mock mode", () => {
    const p = describePolicy(tempConfig());
    assert.equal(p.mode, "mock");
    assert.equal(p.chain_adapter, "mock");
    assert.equal(p.mainnet, "refused");
    assert.equal(p.limits.per_call_cap_zec, "0.1");
    assert.equal(p.limits.per_call_cap_zats, "10000000");
    assert.equal(p.limits.daily_or_rolling_cap, "none");
    assert.equal(p.allowlist.size, 1);
    assert.equal(p.allowlist.error, undefined);
    assert.equal(p.audit.every_call_audited, true);
  });

  it("shows testnet mode for the live adapter", () => {
    const p = describePolicy(tempConfig({ chainMode: "live", chainNetwork: "testnet", spendingCapZec: "0.01" }));
    assert.equal(p.mode, "testnet");
    assert.equal(p.chain_adapter, "zingo-cli");
    assert.equal(p.mainnet, "refused");
    assert.equal(p.limits.per_call_cap_zats, "1000000");
  });

  it("counts unique allow-list addresses and reads the file fresh", () => {
    const config = tempConfig();
    writeFileSync(
      config.allowlistPath,
      JSON.stringify({ recipients: [{ address: ALLOWED }, { address: ALLOWED }, { address: "u1two" }, { address: "" }] })
    );
    assert.equal(describePolicy(config).allowlist.size, 2);
  });

  it("reports a broken allow-list instead of throwing", () => {
    const p = describePolicy(tempConfig({ allowlistPath: "/nonexistent/allow.json" }));
    assert.equal(p.allowlist.size, null);
    assert.match(p.allowlist.error ?? "", /Cannot read allow-list/);
    assert.match(p.allowlist.on_failure ?? "", /rejected/);
  });

  it("reports an invalid cap instead of throwing", () => {
    const p = describePolicy(tempConfig({ spendingCapZec: "abc" }));
    assert.equal(p.limits.per_call_cap_zec, null);
    assert.match(p.limits.cap_error ?? "", /Spending cap/);
  });

  it("never exposes the fingerprint salt", () => {
    const text = JSON.stringify(describePolicy(tempConfig({ viewKeyFingerprintSalt: "secret-salt-xyz" })));
    assert.ok(!text.includes("secret-salt-xyz"));
  });
});

describe("zshield://policy resource", () => {
  it("is served as JSON and lists exactly the registered tools", async () => {
    const { client } = await connect();
    const res = await client.readResource({ uri: "zshield://policy" });
    const item = res.contents[0] as { mimeType?: string; text: string };
    assert.equal(item.mimeType, "application/json");
    const p = JSON.parse(item.text);
    assert.equal(p.mode, "mock");
    assert.equal(p.mainnet, "refused");
    assert.equal(p.allowlist.size, 1);
    const registered = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(registered, [...PAYMENT_TOOLS, ...READ_ONLY_TOOLS].sort());
    assert.deepEqual(p.tools.read_only, [...READ_ONLY_TOOLS]);
  });
});
