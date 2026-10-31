// The state machine and the files under it: F-37 (key fsync), F-39 (status key cap), F-40 (audit appends),
// F-41 (staged then busy), and the keys-dir EACCES case. Part of `npm test`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs, { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import crypto from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, mock } from "node:test";
import { appendPrivate } from "../../src/fsafe.ts";
import { LiveChainAdapter, type CliRunner } from "../../src/chain/live.ts";
import { WalletBusyError } from "../../src/chain/walletlock.ts";
import { createChain } from "../../src/server.ts";
import { executePay } from "../../src/tools/pay.ts";
import { paymentStatus } from "../../src/tools/status.ts";
import { resetPaymentStores, storeFor } from "../../src/payments/store.ts";
import type { Config } from "../../src/types.ts";
import { connect, tempConfig, textOf, withUfvk, ALLOWED } from "../helpers.ts";
import { injectFault } from "./faults.ts";
import { here, killGroup, pauseFile, proc, RECIPIENT, sleep, until, world } from "./helpers.ts";
import { walletStateDir } from "../../src/payments/store.ts";

const UTEST = "utest1" + "q".repeat(100);
const STAGED = "12".repeat(32);

function liveConfig(): Config {
  const config = tempConfig({ chainMode: "live", chainNetwork: "testnet", spendingCapZec: "0.01" });
  writeFileSync(config.allowlistPath, JSON.stringify({ recipients: [{ address: UTEST }] }));
  return config;
}

/** A live adapter whose stage (`send` + `calculate`) succeeds and whose transmit throws `transmitError`. */
function stageOkTransmitFails(transmitError: Error) {
  const runner: CliRunner = async (_bin, args, opts) => {
    if (args.at(-1) === "transactions") return "";
    if (opts?.input?.startsWith("send '")) return `{\n  "fee": 10000\n}\n{\n  "txids": [\n    "${STAGED}"\n  ]\n}\n`;
    throw transmitError;
  };
  return new LiveChainAdapter({ network: "testnet", runner: withUfvk(runner, {}, false) });
}

afterEach(() => mock.restoreAll());

describe("state invariants", { timeout: 180_000 }, () => {
  it("F-41 staged_busy_is_unresolved: a staged payment whose transmit never started is not recorded as not_sent", async () => {
    const config = liveConfig();
    const chain = stageOkTransmitFails(new WalletBusyError("Another zingo-cli process is using this wallet. Nothing was started.", "busy"));
    const input = { idempotency_key: "inv-5a", amount_zec: "0.001", recipient: UTEST };
    const r = await executePay(input, { config, chain });
    const body = JSON.parse(r.text);
    const store = storeFor(config, chain);
    const callId = body.call_id as string;
    const rec = store.readCall(callId);
    assert.ok(rec?.staged_txid === STAGED || JSON.stringify(rec).includes(STAGED), `the staged txid should be on record: ${JSON.stringify(rec)}`);
    assert.notEqual(
      rec?.state,
      "not_sent",
      `a signed transaction exists (staged txid ${STAGED}) and may still be transmitted, but the call is recorded as ${rec?.state} (response code ${r.code}, status ${body.status})`
    );
    assert.ok(store.pendingCalls().includes(callId), "the call must stay in pendingCalls() so recovery re-examines the txid");
    const replay = JSON.parse((await executePay(input, { config, chain })).text);
    assert.notEqual(replay.code, "BUSY", `replaying the key must not say the payment was not sent: ${JSON.stringify(replay).slice(0, 300)}`);
  });

  for (const [dirName, label] of [
    ["keys", "key directory"],
    ["calls", "intent directory"],
  ] as const) {
    it(`F-37 fsync_dir_failure_after_link (${label}): a failed commit leaves the key retryable or unresolved, never a permanent not_sent`, async () => {
      const config = tempConfig({ spendingCapZec: 1 });
      resetPaymentStores();
      const chain = createChain(config);
      storeFor(config, chain); // open the store before arming the fault
      const input = { idempotency_key: `inv-6-${dirName}`, amount_zec: "0.001", recipient: ALLOWED };
      const fault = injectFault({ op: "fsyncSync", match: (p) => p.endsWith(`/${dirName}`) || p.includes(`/${dirName}/`) && !p.includes(".tmp-"), code: "EIO" });
      const first = await executePay(input, { config, chain });
      fault.armed = false;
      mock.restoreAll();
      const body1 = JSON.parse(first.text);
      assert.ok(fault.hits.length > 0, "the fault was never reached; the test is not exercising anything");
      const second = await executePay(input, { config, chain });
      const body2 = JSON.parse(second.text);
      const record = storeFor(config, chain).readCall(body1.call_id);
      const ok = second.ok || body2.status === "unknown" || body2.status === "pending";
      assert.ok(
        ok,
        `after the commit failed (first: ${first.code}) and the fault cleared, retrying the same key gave ${second.code} / ${body2.status}: ${String(body2.message).slice(0, 200)}. First call is now ${record?.state}`
      );
    });
  }

  it("F-40 short_write_leaves_valid_file: a short write then another append still parses line by line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zshield-inv-audit-"));
    const file = join(dir, "audit.jsonl");
    const row = (n: number) => JSON.stringify({ n, pad: "y".repeat(200) }) + "\n";
    appendPrivate(file, row(1));
    const f = injectFault({ op: "writeSync", match: (p) => p === file, code: "EIO", once: true, partial: 0.5 });
    assert.throws(() => appendPrivate(file, row(2)), /EIO/);
    f.restore();
    appendPrivate(file, row(3));
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    const bad: string[] = [];
    for (const l of lines) {
      try {
        JSON.parse(l);
      } catch {
        bad.push(l.slice(0, 60) + "...");
      }
    }
    assert.deepEqual(bad, [], `${bad.length} of ${lines.length} lines do not parse (a partial row was glued to the next one): ${bad.join(" | ")}`);
  });

  it("F-40 concurrent_append_rows_all_parse: 8 processes x 500 rows near MAX_AUDIT_ROW_BYTES", { timeout: 150_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "zshield-inv-audit-"));
    const file = join(dir, "audit.jsonl");
    const driver = here("./fixtures/append-driver.mts");
    const tsx = import.meta.resolve("tsx");
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        new Promise<void>((resolve, reject) => {
          const c = spawn(process.execPath, ["--import", tsx, driver, file, `p${i}`, "500"], { stdio: "ignore" });
          c.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`appender ${i} exited ${code}`))));
        })
      )
    );
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    assert.equal(lines.length, 4000, `expected 4000 rows, got ${lines.length}`);
    let bad = 0;
    const seen = new Set<string>();
    for (const l of lines) {
      try {
        const j = JSON.parse(l);
        seen.add(`${j.tag}:${j.i}`);
      } catch {
        bad++;
      }
    }
    assert.equal(bad, 0, `${bad} lines did not parse`);
    assert.equal(seen.size, 4000, "every row is present exactly once");
  });

  describe("F-39 status_rejects_oversized_key", () => {
    /** Records the largest buffer any hash is fed while `fn` runs. */
    async function maxHashInput<T>(fn: () => Promise<T>): Promise<{ result: T | undefined; error: unknown; max: number }> {
      const proto = Object.getPrototypeOf(crypto.createHash("sha256")) as { update: (...a: any[]) => any };
      let max = 0;
      const orig = proto.update;
      proto.update = function (this: unknown, data: unknown, ...rest: unknown[]) {
        const n = typeof data === "string" ? Buffer.byteLength(data) : (data as { length: number }).length;
        if (n > max) max = n;
        return orig.call(this, data, ...rest);
      };
      try {
        return { result: await fn(), error: undefined, max };
      } catch (error) {
        return { result: undefined, error, max };
      } finally {
        proto.update = orig;
      }
    }
    const BIG = "k".repeat(10 * 1024 * 1024);

    it("I8 paymentStatus with a 10 MB idempotency_key is rejected without hashing it", async () => {
      const config = tempConfig();
      const chain = createChain(config);
      const out = await maxHashInput(() => paymentStatus(config, chain, { idempotency_key: BIG }));
      assert.ok(out.error !== undefined, "an oversized key should be rejected");
      assert.ok(out.max <= 256, `a hash was fed ${out.max} bytes of caller input (limit 256); rejection was: ${String((out.error as Error)?.message).slice(0, 120)}`);
    });

    it("I8 the MCP tool zcash_payment_status with a 10 MB key is rejected without hashing it", async () => {
      const { client } = await connect();
      const out = await maxHashInput(() => client.callTool({ name: "zcash_payment_status", arguments: { idempotency_key: BIG } }));
      const res = out.result as { isError?: boolean } | undefined;
      assert.ok(out.max <= 256, `a hash was fed ${out.max} bytes of caller input (limit 256); tool answered: ${res ? textOf(res).slice(0, 160) : String(out.error)}`);
    });

    it("I8 paymentStatus with a 10 MB call_id never reaches the store with it", async () => {
      const config = tempConfig();
      const chain = createChain(config);
      const out = await maxHashInput(() => paymentStatus(config, chain, { call_id: BIG }));
      assert.ok(out.error !== undefined, "an oversized call_id should be rejected");
      assert.ok(out.max <= 256, `a hash was fed ${out.max} bytes of caller input`);
    });

    it("I8 wrong argument types are rejected as invalid input", async () => {
      const { client } = await connect();
      for (const args of [{ idempotency_key: 12345 }, { call_id: { a: 1 } }, { idempotency_key: ["a"] }]) {
        let rejected = false;
        try {
          const r = await client.callTool({ name: "zcash_payment_status", arguments: args as never });
          rejected = r.isError === true;
        } catch {
          rejected = true;
        }
        assert.ok(rejected, `arguments ${JSON.stringify(args)} should be rejected`);
      }
    });
  });

  describe("I12 fs_faults", () => {
    const cases: { name: string; rule: Parameters<typeof injectFault>[0] }[] = [
      { name: "ENOSPC writing the key temp file", rule: { op: "writeSync", match: (p) => p.includes("/keys/"), code: "ENOSPC" } },
      { name: "EACCES creating a file in the keys dir", rule: { op: "openSync", match: (p) => p.includes("/keys/"), code: "EACCES", creatingOnly: true } },
      { name: "EIO linking the key into place", rule: { op: "linkSync", match: (p) => p.includes("/keys/"), code: "EIO" } },
      { name: "EIO fsyncing the keys dir after link", rule: { op: "fsyncSync", match: (p) => p.endsWith("/keys"), code: "EIO" } },
      { name: "ENOSPC writing the intent", rule: { op: "writeSync", match: (p) => p.includes("/calls/"), code: "ENOSPC", once: true } },
    ];
    it("EACCES reading the keys dir: executePay still returns a result instead of throwing", async () => {
      const config = tempConfig({ spendingCapZec: 1 });
      resetPaymentStores();
      const chain = createChain(config);
      storeFor(config, chain);
      injectFault({ op: "openSync", match: (p) => p.includes("/keys/"), code: "EACCES" });
      let thrown: unknown;
      try {
        await executePay({ idempotency_key: "inv-12r", amount_zec: "0.001", recipient: ALLOWED }, { config, chain });
      } catch (e) {
        thrown = e;
      } finally {
        mock.restoreAll();
      }
      assert.equal(thrown, undefined, `executePay threw instead of returning a result: ${String(thrown).slice(0, 160)}`);
    });

    for (const c of cases) {
      it(`I12 ${c.name}: nothing bound, or intent plus an unresolved state`, async () => {
        const config = tempConfig({ spendingCapZec: 1 });
        resetPaymentStores();
        const chain = createChain(config);
        const store = storeFor(config, chain);
        const input = { idempotency_key: "inv-12", amount_zec: "0.001", recipient: ALLOWED };
        const fault = injectFault(c.rule);
        const first = await executePay(input, { config, chain });
        mock.restoreAll();
        assert.ok(fault.hits.length > 0, "the fault was never reached; the test is not exercising anything");
        const bound = store.readKey(input.idempotency_key);
        if (bound) {
          const rec = store.readCall(bound.call_id);
          assert.ok(rec?.intent, `key is bound to call ${bound.call_id} but the call has no intent (first: ${first.code})`);
          assert.notEqual(rec?.state, "not_sent", `key is bound but its call was settled as not_sent after ${first.code}; the key can never be used again`);
        }
        const retry = JSON.parse((await executePay(input, { config, chain })).text);
        assert.ok(retry.ok || retry.status === "unknown" || retry.status === "pending", `after the fault cleared, retrying gave ${retry.code}/${retry.status}: ${String(retry.message).slice(0, 160)}`);
      });
    }
  });
});
