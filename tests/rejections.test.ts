import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MockChainAdapter } from "../src/chain/mock.ts";
import { LiveChainAdapter, type CliRunner } from "../src/chain/live.ts";
import type { ChainAdapter } from "../src/chain/types.ts";
import { PAY_ERROR_CODES, PAY_REJECTION_CODES } from "../src/errors.ts";
import { executePay } from "../src/tools/pay.ts";
import { executeHistory } from "../src/tools/history.ts";
import { executeReceiveAddress } from "../src/tools/address.ts";
import { executeBalance } from "../src/tools/balance.ts";
import type { Config } from "../src/types.ts";
import { ALLOWED, connect, readAuditRows, tempConfig, TEST_UFVK, textOf, withUfvk } from "./helpers.ts";

const UTEST = "utest1" + "q".repeat(100);
const TXID = "ab".repeat(32);

function liveConfig(recipients: string[]): Config {
  const config = tempConfig({ chainMode: "live", chainNetwork: "testnet", spendingCapZec: "0.01" });
  writeFileSync(config.allowlistPath, JSON.stringify({ recipients: recipients.map((address) => ({ address })) }));
  return config;
}

function liveChain(calls: string[][], runner?: CliRunner) {
  return new LiveChainAdapter({
    network: "testnet",
    runner: withUfvk(
      runner ??
        (async (_b, args) => {
          calls.push(args);
          return JSON.stringify({ txids: [TXID] });
        })
    ),
  });
}

const failingChain = (calls: { n: number }): ChainAdapter =>
  ({
    mode: "mock",
    async pay() {
      calls.n++;
      throw new Error("node unreachable");
    },
    async getViewingKey() {
      return TEST_UFVK;
    },
  }) as unknown as ChainAdapter;

/** Checks the response, the audit row, and that the code and message are both present. */
function expectCode(
  r: { ok: boolean; code?: string; text: string; audit: { status: string; code?: string } },
  config: Config,
  status: "rejected" | "error",
  code: string
) {
  assert.equal(r.ok, false);
  assert.equal(r.code, code);
  const body = JSON.parse(r.text);
  assert.equal(body.ok, false);
  assert.equal(body.status, status);
  assert.equal(body.code, code);
  assert.equal(typeof body.message, "string");
  assert.ok(body.message.length > 0);
  assert.equal(r.audit.code, code);
  const last = readAuditRows(config).at(-1)!;
  assert.equal(last.status, status);
  assert.equal(last.code, code);
}

describe("zcash_pay rejection codes", () => {
  it("INVALID_AMOUNT for malformed, zero, negative, and sub-zatoshi amounts", async () => {
    for (const amount_zec of ["abc", 0, "-1", "0.000000001", "1e-3"]) {
      const config = tempConfig();
      const r = await executePay({ amount_zec, recipient: ALLOWED }, { config, chain: new MockChainAdapter() });
      expectCode(r, config, "rejected", "INVALID_AMOUNT");
    }
  });

  it("CAP_EXCEEDED above the per-call cap", async () => {
    const config = tempConfig();
    const r = await executePay({ amount_zec: "0.10000001", recipient: ALLOWED }, { config, chain: new MockChainAdapter() });
    expectCode(r, config, "rejected", "CAP_EXCEEDED");
  });

  it("INVALID_CAP when the configured cap is bad", async () => {
    const config = tempConfig({ spendingCapZec: "0" });
    const r = await executePay({ amount_zec: "0.01", recipient: ALLOWED }, { config, chain: new MockChainAdapter() });
    expectCode(r, config, "rejected", "INVALID_CAP");
  });

  it("NOT_ALLOWLISTED for an unknown recipient", async () => {
    const config = tempConfig();
    const r = await executePay({ amount_zec: "0.01", recipient: "u1stranger" }, { config, chain: new MockChainAdapter() });
    expectCode(r, config, "rejected", "NOT_ALLOWLISTED");
  });

  it("ALLOWLIST_UNAVAILABLE for a missing or malformed allow-list", async () => {
    const missing = tempConfig({ allowlistPath: "/nonexistent/allow.json" });
    const r1 = await executePay({ amount_zec: "0.01", recipient: ALLOWED }, { config: missing, chain: new MockChainAdapter() });
    expectCode(r1, missing, "rejected", "ALLOWLIST_UNAVAILABLE");

    const bad = tempConfig();
    writeFileSync(bad.allowlistPath, JSON.stringify({ people: [] }));
    const r2 = await executePay({ amount_zec: "0.01", recipient: ALLOWED }, { config: bad, chain: new MockChainAdapter() });
    expectCode(r2, bad, "rejected", "ALLOWLIST_UNAVAILABLE");
  });

  it("MAINNET_REFUSED in testnet mode even when the address is allow-listed, with no CLI call and no pending row", async () => {
    for (const addr of ["u1mainnetlisted", "zs1mainnetlisted", "t1mainnetlisted"]) {
      const calls: string[][] = [];
      const config = liveConfig([addr]);
      const r = await executePay({ idempotency_key: "t-rej-1", amount_zec: "0.001", recipient: addr }, { config, chain: liveChain(calls) });
      expectCode(r, config, "rejected", "MAINNET_REFUSED");
      assert.equal(calls.length, 0);
      assert.deepEqual(readAuditRows(config).map((x) => x.status), ["rejected"]);
    }
  });

  it("INVALID_ADDRESS for an address from no known Zcash network in testnet mode", async () => {
    const calls: string[][] = [];
    const config = liveConfig(["bc1notzcash"]);
    const r = await executePay({ idempotency_key: "t-rej-2", amount_zec: "0.001", recipient: "bc1notzcash" }, { config, chain: liveChain(calls) });
    expectCode(r, config, "rejected", "INVALID_ADDRESS");
    assert.equal(calls.length, 0);
  });

  it("mock mode still accepts mock u1 addresses", async () => {
    const config = tempConfig();
    const r = await executePay({ amount_zec: "0.01", recipient: ALLOWED }, { config, chain: new MockChainAdapter() });
    assert.equal(r.ok, true);
    assert.equal(r.code, undefined);
    assert.equal(r.audit.code, undefined);
  });
});

describe("zcash_pay error codes", () => {
  it("CHAIN_ERROR when the send fails, after a pending row", async () => {
    const config = tempConfig();
    const calls = { n: 0 };
    const r = await executePay({ amount_zec: "0.01", recipient: ALLOWED }, { config, chain: failingChain(calls) });
    expectCode(r, config, "error", "CHAIN_ERROR");
    assert.equal(calls.n, 1);
    assert.deepEqual(readAuditRows(config).map((x) => x.status), ["pending", "error"]);
    assert.equal(readAuditRows(config)[0].code, undefined);
  });

  it("CHAIN_ERROR when zingo-cli fails in testnet mode", async () => {
    const config = liveConfig([UTEST]);
    const chain = liveChain([], async () => {
      throw new Error("zingo-cli failed: insufficient funds");
    });
    const r = await executePay({ idempotency_key: "t-rej-3", amount_zec: "0.001", recipient: UTEST }, { config, chain });
    expectCode(r, config, "error", "CHAIN_ERROR");
  });

  it("AUDIT_WRITE_FAILED when the pending row cannot be written, and nothing is sent", async () => {
    const root = mkdtempSync(join(tmpdir(), "zshield-noaudit-"));
    writeFileSync(join(root, "file"), "x");
    const config = tempConfig({ auditDir: join(root, "file", "audits") });
    const calls = { n: 0 };
    const r = await executePay({ amount_zec: "0.01", recipient: ALLOWED }, { config, chain: failingChain(calls) });
    assert.equal(r.code, "AUDIT_WRITE_FAILED");
    assert.equal(JSON.parse(r.text).code, "AUDIT_WRITE_FAILED");
    assert.equal(calls.n, 0);
  });

  it("CONFIG_ERROR when testnet mode is paired with a mock adapter", async () => {
    const config = liveConfig([UTEST]);
    const r = await executePay({ amount_zec: "0.001", recipient: UTEST }, { config, chain: new MockChainAdapter() });
    expectCode(r, config, "error", "CONFIG_ERROR");
  });

  it("every code is documented in the README", () => {
    const readme = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "README.md"), "utf8");
    for (const code of [...PAY_REJECTION_CODES, ...PAY_ERROR_CODES, "INVALID_LIMIT"]) {
      assert.ok(readme.includes(`\`${code}\``), `${code} missing from README`);
    }
  });
});

describe("read-only tool codes", () => {
  it("INVALID_LIMIT for a bad history limit", async () => {
    const config = tempConfig();
    const r = await executeHistory({ limit: 0 }, { config, chain: new MockChainAdapter() });
    const body = JSON.parse(r.text);
    assert.equal(body.status, "rejected");
    assert.equal(body.code, "INVALID_LIMIT");
    assert.equal(readAuditRows(config)[0].code, "INVALID_LIMIT");
  });

  it("CHAIN_ERROR when the wallet cannot be read", async () => {
    const config = liveConfig([]);
    const chain = liveChain([], async () => {
      throw new Error("zingo-cli failed: timeout");
    });
    const body = JSON.parse((await executeBalance({ config, chain })).text);
    assert.equal(body.code, "CHAIN_ERROR");
  });

  it("MAINNET_REFUSED when the wallet reports a mainnet address", async () => {
    const config = liveConfig([]);
    const chain = liveChain([], async () => JSON.stringify([{ account: 0, address_index: 0, encoded_address: "u1main" }]));
    const body = JSON.parse((await executeReceiveAddress({ config, chain })).text);
    assert.equal(body.code, "MAINNET_REFUSED");
  });
});

describe("codes over MCP", () => {
  it("zcash_pay returns the code with isError", async () => {
    const { client } = await connect();
    const res = await client.callTool({ name: "zcash_pay", arguments: { amount_zec: "5", recipient: ALLOWED } });
    assert.equal(res.isError, true);
    const body = JSON.parse(textOf(res));
    assert.equal(body.code, "CAP_EXCEEDED");
    assert.match(body.message, /exceeds/);
  });
});
