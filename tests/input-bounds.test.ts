import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockChainAdapter, MOCK_UFVK } from "../src/chain/mock.ts";
import { SendOutcomeUnknownError } from "../src/chain/outcome.ts";
import type { ChainAdapter } from "../src/chain/types.ts";
import { appendAuditEntry, boundAuditEntry } from "../src/audit/log.ts";
import { MAX_AUDIT_ROW_BYTES, MAX_MEMO_BYTES, MAX_RECIPIENT_LENGTH } from "../src/policy/limits.ts";
import { executePay, payInputSchema, redactInput } from "../src/tools/pay.ts";
import type { AuditEntry, Config } from "../src/types.ts";
import { connect, textOf } from "./helpers.ts";

const ALLOWED = "u1mockrecipientaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function tempConfig(): Config {
  const root = mkdtempSync(join(tmpdir(), "zshield-bounds-"));
  const allowlistPath = join(root, "allow.json");
  writeFileSync(allowlistPath, JSON.stringify({ recipients: [{ address: ALLOWED }] }));
  return {
    spendingCapZec: 0.1,
    allowlistPath,
    chainMode: "mock",
    auditDir: join(root, "audits"),
    viewKeyFingerprintSalt: "test-salt",
  };
}

function auditLines(config: Config): string[] {
  return readdirSync(config.auditDir)
    .sort()
    .flatMap((f) => readFileSync(join(config.auditDir, f), "utf8").trim().split("\n"))
    .filter(Boolean);
}

/** A chain that counts sends. */
function countingChain(calls: { n: number }): ChainAdapter {
  const mock = new MockChainAdapter();
  return {
    mode: "mock",
    getViewingKey: async () => MOCK_UFVK,
    async pay(req) {
      calls.n++;
      return mock.pay(req);
    },
  };
}

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

describe("oversized recipient", () => {
  for (const [label, recipient] of [
    ["just over the limit", "u1" + "x".repeat(MAX_RECIPIENT_LENGTH - 1)],
    ["one megabyte", "u1" + "x".repeat(1024 * 1024)],
  ] as const) {
    it(`is rejected without being echoed or stored whole (${label})`, async () => {
      const config = tempConfig();
      const calls = { n: 0 };
      const r = await executePay({ amount_zec: 0.01, recipient }, { config, chain: countingChain(calls) });
      assert.equal(r.ok, false);
      assert.equal(r.audit.status, "rejected");
      assert.equal(calls.n, 0);
      assert.match(r.audit.error ?? "", new RegExp(`longer than ${MAX_RECIPIENT_LENGTH} characters`));
      assert.ok(!(r.audit.error ?? "").includes("xxxxxxxx"), "error must not echo the recipient");

      // One rejected row, shortened, with a hash of the full value.
      const lines = auditLines(config);
      assert.equal(lines.length, 1);
      assert.ok(bytes(lines[0]) < 1024, `row is ${bytes(lines[0])} bytes`);
      const row = JSON.parse(lines[0]);
      assert.equal(row.recipient_sha256, createHash("sha256").update(recipient).digest("hex"));
      assert.ok(row.recipient.length < 100);
      assert.equal(row.truncated, true);

      // The response is small too.
      assert.ok(bytes(r.text) < 2048, `response is ${bytes(r.text)} bytes`);
    });
  }

  it("rejects whitespace and control characters", async () => {
    for (const recipient of ["u1abc def", "u1abc\n{\"forged\":true}", "u1\u0000abc"]) {
      const r = await executePay({ amount_zec: 0.01, recipient }, { config: tempConfig(), chain: new MockChainAdapter() });
      assert.equal(r.audit.status, "rejected", JSON.stringify(recipient));
      assert.match(r.audit.error ?? "", /cannot appear in an address/);
    }
  });

  it("is refused by the input schema with INVALID_RECIPIENT", () => {
    const res = payInputSchema.safeParse({ amount_zec: 0.01, recipient: "u1" + "x".repeat(MAX_RECIPIENT_LENGTH) });
    assert.equal(res.success, false);
    const msg = res.success ? "" : res.error.issues.map((i) => i.message).join(" ");
    assert.match(msg, /^INVALID_RECIPIENT/);
    assert.ok(!msg.includes("xxxx"));
    assert.equal(payInputSchema.safeParse({ amount_zec: 0.01, recipient: "u1" + "x".repeat(MAX_RECIPIENT_LENGTH - 2) }).success, true);
  });

  it("a non-allow-listed recipient is not repeated in the error", async () => {
    const recipient = "u1someoneelse" + "y".repeat(40);
    const r = await executePay({ amount_zec: 0.01, recipient }, { config: tempConfig(), chain: new MockChainAdapter() });
    assert.match(r.audit.error ?? "", /not on the allow-list/);
    assert.ok(!(r.audit.error ?? "").includes(recipient));
    assert.equal(r.audit.recipient, recipient);
  });
});

describe("oversized memo", () => {
  it("rejects a memo over 512 UTF-8 bytes, counting bytes not characters", async () => {
    const euro = "\u20ac"; // 3 bytes in UTF-8
    const over = euro.repeat(171); // 171 characters, 513 bytes
    const fits = euro.repeat(170); // 510 bytes
    assert.equal(bytes(over), 513);

    const config = tempConfig();
    const calls = { n: 0 };
    const r = await executePay({ amount_zec: 0.01, recipient: ALLOWED, memo: over }, { config, chain: countingChain(calls) });
    assert.equal(r.audit.status, "rejected");
    assert.equal(calls.n, 0);
    assert.match(r.audit.error ?? "", new RegExp(`longer than ${MAX_MEMO_BYTES} bytes`));
    assert.ok(!(r.audit.error ?? "").includes(euro));

    const ok = await executePay({ amount_zec: 0.01, recipient: ALLOWED, memo: fits }, { config, chain: countingChain(calls) });
    assert.equal(ok.ok, true);
    assert.equal(calls.n, 1);
  });

  it("is refused by the input schema by bytes and by length", () => {
    assert.equal(payInputSchema.safeParse({ amount_zec: 0.01, recipient: ALLOWED, memo: "\u20ac".repeat(171) }).success, false);
    assert.equal(payInputSchema.safeParse({ amount_zec: 0.01, recipient: ALLOWED, memo: "a".repeat(513) }).success, false);
    assert.equal(payInputSchema.safeParse({ amount_zec: 0.01, recipient: ALLOWED, memo: "a".repeat(512) }).success, true);
  });
});

describe("audit row size", () => {
  const base: AuditEntry = {
    ts: "2026-10-26T00:00:00.000Z",
    tool: "zcash_pay",
    call_id: "c",
    amount_zec: 0.01,
    recipient: ALLOWED,
    allowlist_hit: true,
    cap_zec: 0.1,
    status: "error",
    view_key_fingerprint: "0123456789abcdef",
  };

  it("leaves a normal row untouched", () => {
    assert.deepEqual(boundAuditEntry({ ...base, memo: "hi" }), { ...base, memo: "hi" });
  });

  it("cuts long fields so the row fits the limit", () => {
    const row = boundAuditEntry({ ...base, error: "e".repeat(50_000), memo: "\n".repeat(5_000) });
    assert.ok(bytes(JSON.stringify(row)) <= MAX_AUDIT_ROW_BYTES);
    assert.equal(row.truncated, true);
    assert.equal(row.call_id, "c");
    assert.match(row.error ?? "", /\[truncated\]$/);
  });

  it("falls back to identifying fields when cutting is not enough", () => {
    const many = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`extra_${i}`, "z".repeat(1000)]));
    const row = boundAuditEntry({ ...base, ...many } as AuditEntry);
    assert.ok(bytes(JSON.stringify(row)) <= MAX_AUDIT_ROW_BYTES);
    assert.deepEqual(Object.keys(row).sort(), ["call_id", "status", "tool", "truncated", "ts", "view_key_fingerprint"]);
  });

  it("appendAuditEntry never writes a line over the limit", () => {
    const dir = mkdtempSync(join(tmpdir(), "zshield-rowcap-"));
    const file = appendAuditEntry(dir, { ...base, error: "e".repeat(100_000), recipient: "u1" + "r".repeat(100_000) });
    const line = readFileSync(file, "utf8").trim();
    assert.ok(bytes(line) <= MAX_AUDIT_ROW_BYTES);
    assert.ok(JSON.parse(line).recipient_sha256);
  });
});

describe("redactInput", () => {
  it("replaces the recipient and memo in chain error text", () => {
    const msg = redactInput("zingo-cli failed: bad address utest1abcdef with memo secret note", {
      recipient: "utest1abcdef",
      memo: "secret note",
    });
    assert.equal(msg, "zingo-cli failed: bad address [recipient] with memo [memo]");
  });
});

describe("chain errors", () => {
  it("do not carry the recipient or memo back to the caller", async () => {
    const config = tempConfig();
    const chain: ChainAdapter = {
      mode: "mock",
      getViewingKey: async () => MOCK_UFVK,
      async pay(req) {
        throw new Error(`zingo-cli failed: could not send to ${req.recipient} (memo ${req.memo})`);
      },
    };
    const r = await executePay({ amount_zec: 0.01, recipient: ALLOWED, memo: "private memo text" }, { config, chain });
    assert.equal(r.audit.status, "error");
    assert.equal(r.audit.error, "zingo-cli failed: could not send to [recipient] (memo [memo])");
    // The memo is kept on purpose in the row's memo field, and nowhere else in the response.
    assert.equal(r.text.split("private memo text").length, 2);
  });

  it("an unknown send outcome does not repeat the recipient or memo either", async () => {
    const config = tempConfig();
    const chain = {
      mode: "mock",
      getViewingKey: async () => MOCK_UFVK,
      getHistory: async () => [],
      async pay(req: { recipient: string; memo?: string }) {
        throw new SendOutcomeUnknownError(`no txid after sending to ${req.recipient} with memo ${req.memo}`);
      },
    } as unknown as ChainAdapter;
    const r = await executePay({ amount_zec: 0.01, recipient: ALLOWED, memo: "private memo text" }, { config, chain });
    assert.equal(r.audit.status, "unknown");
    assert.match(r.audit.error ?? "", /Detail: no txid after sending to \[recipient\] with memo \[memo\]$/);
    assert.equal(r.text.split("private memo text").length, 2);
  });
});

describe("oversized amount string", () => {
  it("is rejected without being echoed, and the row keeps only a short prefix", async () => {
    const config = tempConfig();
    const amount = "0." + "1".repeat(100_000);
    const r = await executePay({ amount_zec: amount, recipient: ALLOWED }, { config, chain: new MockChainAdapter() });
    assert.equal(r.audit.status, "rejected");
    assert.match(r.audit.error ?? "", /longer than 32 characters/);
    assert.ok(!(r.audit.error ?? "").includes("1111"));
    const lines = auditLines(config);
    assert.equal(lines.length, 1);
    assert.ok(bytes(lines[0]) < 1024);
    assert.equal(JSON.parse(lines[0]).truncated, true);
    assert.ok(bytes(r.text) < 2048);
  });

  it("is refused by the input schema", () => {
    assert.equal(payInputSchema.safeParse({ amount_zec: "1".repeat(33), recipient: ALLOWED }).success, false);
    assert.equal(payInputSchema.safeParse({ amount_zec: "0.05", recipient: ALLOWED }).success, true);
  });

  it("amount errors never repeat the caller's text", async () => {
    for (const amount of ["abc<script>", "-5", "0.123456789", "nan", "99999999"]) {
      const r = await executePay({ amount_zec: amount, recipient: ALLOWED }, { config: tempConfig(), chain: new MockChainAdapter() });
      assert.equal(r.audit.status, "rejected", amount);
      assert.ok(!(r.audit.error ?? "").includes(amount), `${amount} echoed in: ${r.audit.error}`);
    }
  });
});

describe("stable codes for oversized input", () => {
  it("INVALID_RECIPIENT, INVALID_MEMO, and INVALID_AMOUNT", async () => {
    const config = tempConfig();
    const chain = new MockChainAdapter();
    const rec = await executePay({ amount_zec: 0.01, recipient: "u1" + "x".repeat(300) }, { config, chain });
    assert.equal(rec.code, "INVALID_RECIPIENT");
    assert.equal(rec.audit.code, "INVALID_RECIPIENT");
    const memo = await executePay({ amount_zec: 0.01, recipient: ALLOWED, memo: "m".repeat(513) }, { config, chain });
    assert.equal(memo.code, "INVALID_MEMO");
    const amt = await executePay({ amount_zec: "9".repeat(40), recipient: ALLOWED }, { config, chain });
    assert.equal(amt.code, "INVALID_AMOUNT");
  });

  it("an MCP call with an oversized recipient is refused before the tool runs", async () => {
    const { client, config } = await connect(tempConfig());
    const recipient = "u1" + "x".repeat(10_000);
    let text = "";
    try {
      const res = await client.callTool({ name: "zcash_pay", arguments: { amount_zec: "0.01", recipient } });
      text = textOf(res);
    } catch (e) {
      text = e instanceof Error ? e.message : String(e);
    }
    assert.match(text, /INVALID_RECIPIENT/);
    assert.ok(!text.includes("xxxxxxxxxx"), "the recipient must not be echoed");
    assert.ok(bytes(text) < 2048);
    // Refused at the schema, so nothing was audited and nothing was sent.
    assert.throws(() => readdirSync(config.auditDir));
  });
});
