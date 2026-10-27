import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LiveChainAdapter, parseUfvk, type CliRunner, type RunOptions } from "../src/chain/live.ts";
import { MockChainAdapter, MOCK_UFVK } from "../src/chain/mock.ts";
import type { ChainAdapter } from "../src/chain/types.ts";
import { fingerprintViewKey } from "../src/audit/log.ts";
import { executePay } from "../src/tools/pay.ts";
import type { Config } from "../src/types.ts";
import { ALLOWED, readAuditRows, tempConfig, TEST_UFVK, withUfvk } from "./helpers.ts";

const UTEST = "utest1" + "q".repeat(100);
const TXID = "cd".repeat(32);
// Shape of real `zingo-cli export_ufvk` output, with a fake key.
const EXPORT_OUT = `Launching save task...\n{\n  "ufvk": "${TEST_UFVK}",\n  "birthday": 4492314\n}\nSave task shutdown successfully.\n`;

function rawAuditText(config: Config): string {
  return readdirSync(config.auditDir)
    .map((f) => readFileSync(join(config.auditDir, f), "utf8"))
    .join("");
}

describe("parseUfvk", () => {
  it("reads the key from export_ufvk output", () => {
    assert.equal(parseUfvk(EXPORT_OUT), TEST_UFVK);
  });
  it("refuses a mainnet key", () => {
    assert.throws(() => parseUfvk('{"ufvk": "uview1qqqqqqqq"}'), /not for testnet/);
  });
  it("never echoes the output in its error", () => {
    const out = '{"ufvk": "UVIEWTEST1SHOUTING"}';
    assert.throws(
      () => parseUfvk(out),
      (e: unknown) => e instanceof Error && /no unified full viewing key/.test(e.message) && !e.message.includes("SHOUTING")
    );
  });
});

describe("LiveChainAdapter.getViewingKey", () => {
  it("runs export_ufvk offline, with no server and a read timeout, once per process", async () => {
    const calls: { args: string[]; opts?: RunOptions }[] = [];
    const runner: CliRunner = async (_b, args, opts) => {
      calls.push({ args, opts });
      return EXPORT_OUT;
    };
    const a = new LiveChainAdapter({ network: "testnet", runner, dataDir: "/w" });
    assert.equal(await a.getViewingKey(), TEST_UFVK);
    assert.equal(await a.getViewingKey(), TEST_UFVK);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, ["--chain", "testnet", "--data-dir", "/w", "--offline", "export_ufvk"]);
    assert.ok(!calls[0].args.includes("--server"));
    assert.ok((calls[0].opts?.timeoutMs ?? 0) > 0);
  });
  it("does not cache a failure, and retries after the backoff", async () => {
    let t = 0;
    let n = 0;
    const runner: CliRunner = async () => {
      n++;
      if (n === 1) throw new Error("zingo-cli failed: wallet locked");
      return EXPORT_OUT;
    };
    const a = new LiveChainAdapter({ network: "testnet", runner, now: () => t });
    await assert.rejects(a.getViewingKey(), /wallet locked/);
    await assert.rejects(a.getViewingKey(), /next try in 1s/);
    t += 1_000;
    assert.equal(await a.getViewingKey(), TEST_UFVK);
    assert.equal(n, 2);
  });
});

describe("audit fingerprint comes from the wallet UFVK", () => {
  it("mock: every row carries the salted hash of the deterministic mock UFVK", async () => {
    const config = tempConfig();
    const chain = new MockChainAdapter();
    const ok = await executePay({ amount_zec: "0.01", recipient: ALLOWED }, { config, chain });
    const rejected = await executePay({ amount_zec: "5", recipient: ALLOWED }, { config, chain });
    const want = fingerprintViewKey(MOCK_UFVK, config.viewKeyFingerprintSalt);
    assert.match(want, /^[0-9a-f]{16}$/);
    const rows = readAuditRows(config);
    assert.deepEqual(rows.map((r) => r.status), ["pending", "ok", "rejected"]);
    for (const r of rows) assert.equal(r.view_key_fingerprint, want);
    assert.equal(JSON.parse(ok.text).view_key_fingerprint, want);
    assert.equal(rejected.audit.view_key_fingerprint, want);
    assert.equal(await new MockChainAdapter().getViewingKey(), MOCK_UFVK);
  });

  it("a different salt gives a different fingerprint for the same wallet", async () => {
    const a = tempConfig({ viewKeyFingerprintSalt: "salt-a" });
    const b = tempConfig({ viewKeyFingerprintSalt: "salt-b" });
    const ra = await executePay({ amount_zec: "0.01", recipient: ALLOWED }, { config: a, chain: new MockChainAdapter() });
    const rb = await executePay({ amount_zec: "0.01", recipient: ALLOWED }, { config: b, chain: new MockChainAdapter() });
    assert.notEqual(ra.audit.view_key_fingerprint, rb.audit.view_key_fingerprint);
  });

  it("live: rows use the testnet wallet UFVK and the key is never written or returned", async () => {
    const config = tempConfig({ chainMode: "live", chainNetwork: "testnet", spendingCapZec: "0.01" });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(config.allowlistPath, JSON.stringify({ recipients: [{ address: UTEST }] }));
    const chain = new LiveChainAdapter({
      network: "testnet",
      runner: withUfvk(async () => JSON.stringify({ txids: [TXID] })),
    });
    const r = await executePay({ amount_zec: "0.001", recipient: UTEST }, { config, chain });
    assert.equal(r.ok, true);
    const want = fingerprintViewKey(TEST_UFVK, config.viewKeyFingerprintSalt);
    for (const row of readAuditRows(config)) assert.equal(row.view_key_fingerprint, want);
    assert.ok(!rawAuditText(config).includes(TEST_UFVK));
    assert.ok(!r.text.includes(TEST_UFVK));
  });

  it("receipts correlate with audit rows through call_id and txid", async () => {
    const config = tempConfig();
    const r = await executePay({ amount_zec: "0.01", recipient: ALLOWED }, { config, chain: new MockChainAdapter() });
    const body = JSON.parse(r.text);
    const rows = readAuditRows(config);
    assert.ok(body.call_id);
    assert.ok(rows.every((row) => row.call_id === body.call_id));
    assert.equal(rows[1].mock_txid, body.txid);
    const bad = await executePay({ amount_zec: "9", recipient: ALLOWED }, { config, chain: new MockChainAdapter() });
    assert.equal(JSON.parse(bad.text).call_id, bad.audit.call_id);
  });
});

describe("VIEWKEY_UNAVAILABLE", () => {
  const brokenKey = (sent: { n: number }): ChainAdapter =>
    ({
      mode: "mock",
      async pay() {
        sent.n++;
        throw new Error("should not be called");
      },
      async getViewingKey() {
        throw new Error("zingo-cli failed: no wallet");
      },
    }) as unknown as ChainAdapter;

  it("refuses to send when the viewing key cannot be read", async () => {
    const config = tempConfig();
    const sent = { n: 0 };
    const r = await executePay({ amount_zec: "0.01", recipient: ALLOWED }, { config, chain: brokenKey(sent) });
    assert.equal(sent.n, 0);
    assert.equal(r.ok, false);
    assert.equal(r.code, "VIEWKEY_UNAVAILABLE");
    assert.match(JSON.parse(r.text).message, /viewing key could not be read.*not sent/);
    const rows = readAuditRows(config);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "error");
    assert.equal(rows[0].code, "VIEWKEY_UNAVAILABLE");
    assert.equal(rows[0].view_key_fingerprint, null);
  });

  it("a policy rejection still wins and is audited with a null fingerprint", async () => {
    const config = tempConfig();
    const r = await executePay({ amount_zec: "1", recipient: ALLOWED }, { config, chain: brokenKey({ n: 0 }) });
    assert.equal(r.code, "CAP_EXCEEDED");
    assert.equal(readAuditRows(config)[0].view_key_fingerprint, null);
  });
});
