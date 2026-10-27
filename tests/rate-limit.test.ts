import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseRateLimit, RateLimiter, RATE_LIMIT_DEFAULT_PER_MIN } from "../src/policy/rate.ts";
import { loadConfig } from "../src/config.ts";
import { describePolicy } from "../src/policy/describe.ts";
import { RATE_LIMIT_CODES } from "../src/errors.ts";
import { ALLOWED, connect, readAuditRows, tempConfig, textOf, withEnv } from "./helpers.ts";

function clock(start = Date.parse("2026-10-27T00:00:00Z")) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("RateLimiter", () => {
  it("allows the limit, refuses the rest, and writes no row per refused call", () => {
    const config = tempConfig();
    const c = clock();
    const rl = new RateLimiter(3, config.auditDir, c.now);
    assert.deepEqual([1, 2, 3, 4, 5].map(() => rl.take("zcash_pay")), [true, true, true, false, false]);
    assert.equal(rl.pendingRefused(), 2);
    assert.equal(existsSync(config.auditDir), false);
    rl.flush();
  });

  it("writes one summary row when the window rolls over, then allows calls again", () => {
    const config = tempConfig();
    const c = clock();
    const rl = new RateLimiter(2, config.auditDir, c.now);
    for (let i = 0; i < 1000; i++) rl.take(i % 2 ? "zcash_pay" : "zcash_balance");
    c.advance(60_000);
    assert.equal(rl.take("zcash_pay"), true);
    const rows = readAuditRows(config);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].tool, "rate_limit");
    assert.equal(rows[0].code, "RATE_LIMITED");
    assert.equal(rows[0].refused_calls, 998);
    assert.deepEqual(rows[0].refused_by_tool, { zcash_balance: 499, zcash_pay: 499 });
    assert.equal(rows[0].window_start, "2026-10-27T00:00:00.000Z");
    assert.equal(rows[0].limit_per_min, 2);
  });

  it("writes nothing when no call was refused", () => {
    const config = tempConfig();
    const c = clock();
    const rl = new RateLimiter(5, config.auditDir, c.now);
    rl.take("zcash_pay");
    c.advance(120_000);
    rl.take("zcash_pay");
    rl.flush();
    assert.equal(existsSync(config.auditDir), false);
  });

  it("flushes on its own when the window ends", async () => {
    const config = tempConfig();
    const rl = new RateLimiter(1, config.auditDir, Date.now, 50);
    rl.take("zcash_pay");
    rl.take("zcash_pay");
    await new Promise((r) => setTimeout(r, 120));
    const rows = readAuditRows(config);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].refused_calls, 1);
    assert.equal(rl.pendingRefused(), 0);
  });

  it("does not throw when the summary row cannot be written", () => {
    const c = clock();
    // A regular file where the audit directory should be makes every write fail.
    const blocker = join(mkdtempSync(join(tmpdir(), "zshield-rl-")), "not-a-dir");
    writeFileSync(blocker, "");
    const rl = new RateLimiter(1, join(blocker, "audits"), c.now);
    rl.take("zcash_pay");
    rl.take("zcash_pay");
    c.advance(60_000);
    assert.equal(rl.take("zcash_pay"), true);
  });
});

describe("RATE_LIMIT_PER_MIN", () => {
  it("defaults to 60 and accepts whole numbers in range", async () => {
    assert.equal(RATE_LIMIT_DEFAULT_PER_MIN, 60);
    assert.equal(await withEnv("RATE_LIMIT_PER_MIN", undefined, async () => loadConfig().rateLimitPerMin), 60);
    assert.equal(await withEnv("RATE_LIMIT_PER_MIN", "5", async () => loadConfig().rateLimitPerMin), 5);
    assert.equal(parseRateLimit(10_000), 10_000);
  });

  it("refuses zero, negatives, fractions, too large, and text", () => {
    for (const v of ["0", "-1", "2.5", "10001", "lots", 0, 1.5]) {
      assert.throws(() => parseRateLimit(v), /RATE_LIMIT_PER_MIN must be a whole number/, String(v));
    }
  });

  it("is shown in the policy resource", () => {
    assert.equal(describePolicy(tempConfig({ rateLimitPerMin: 7 })).limits.tool_calls_per_min, 7);
    assert.equal(describePolicy(tempConfig()).limits.tool_calls_per_min, 60);
  });
});

describe("rate limit docs", () => {
  it("RATE_LIMITED and RATE_LIMIT_PER_MIN are in the README", () => {
    const readme = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "README.md"), "utf8");
    for (const code of RATE_LIMIT_CODES) assert.ok(readme.includes(`\`${code}\``));
    assert.ok(readme.includes("`RATE_LIMIT_PER_MIN`"));
  });
});

describe("rate limit over MCP", () => {
  it("refuses calls over the limit with RATE_LIMITED across all tools", async () => {
    assert.deepEqual([...RATE_LIMIT_CODES], ["RATE_LIMITED"]);
    const { client, config } = await connect(tempConfig({ rateLimitPerMin: 2 }));
    const ok1 = await client.callTool({ name: "zcash_balance", arguments: {} });
    const ok2 = await client.callTool({ name: "zcash_pay", arguments: { amount_zec: "0.01", recipient: ALLOWED } });
    assert.equal(ok1.isError, false);
    assert.equal(ok2.isError, false);
    const rowsBefore = readAuditRows(config).length;

    for (let i = 0; i < 20; i++) {
      const res = await client.callTool({
        name: "zcash_pay",
        arguments: { amount_zec: "0.01", recipient: ALLOWED, memo: "spam " + i },
      });
      assert.equal(res.isError, true);
      const body = JSON.parse(textOf(res));
      assert.equal(body.code, "RATE_LIMITED");
      assert.equal(body.status, "rejected");
      assert.ok(!textOf(res).includes("spam"));
    }
    const hist = await client.callTool({ name: "zcash_history", arguments: {} });
    assert.equal(JSON.parse(textOf(hist)).code, "RATE_LIMITED");

    // No row per refused call, and nothing was paid.
    const rows = readAuditRows(config);
    assert.equal(rows.length, rowsBefore);
    assert.equal(rows.filter((r) => r.tool === "zcash_pay" && r.status === "ok").length, 1);
  });
});
