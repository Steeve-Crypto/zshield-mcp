import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import fs, { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockChainAdapter } from "../src/chain/mock.ts";
import { executePay } from "../src/tools/pay.ts";
import { ALLOWED, connect, tempConfig, textOf } from "./helpers.ts";

/** A regular file where a directory should be, so every write under it fails. */
function blocked(): string {
  const f = join(mkdtempSync(join(tmpdir(), "zshield-block-")), "not-a-dir");
  writeFileSync(f, "");
  return f;
}

function rows(file: string): Record<string, unknown>[] {
  return readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
}

afterEach(() => mock.restoreAll());

describe("audit fallback (V12 F-6)", () => {
  it("writes to the fallback file when the main log fails, sends, and warns", async () => {
    const fallback = join(mkdtempSync(join(tmpdir(), "zshield-fb-")), "audit-fallback.jsonl");
    const config = tempConfig({ auditDir: join(blocked(), "audits"), auditFallbackPath: fallback });
    const chain = new MockChainAdapter();
    const res = await executePay({ amount_zec: "0.001", recipient: ALLOWED }, { config, chain });
    assert.equal(res.ok, true);
    const body = JSON.parse(res.text);
    assert.match(body.audit_warning, /audit-fallback\.jsonl/);
    assert.deepEqual(rows(fallback).map((r) => r.status), ["pending", "ok"]);
    assert.equal(statSync(fallback).mode & 0o777, 0o600);
  });

  it("defaults the fallback file to audit-fallback.jsonl beside the audit dir", async () => {
    const root = mkdtempSync(join(tmpdir(), "zshield-fb-"));
    writeFileSync(join(root, "audits"), "");
    const config = tempConfig({ auditDir: join(root, "audits") });
    const res = await executePay({ amount_zec: "0.001", recipient: ALLOWED }, { config, chain: new MockChainAdapter() });
    assert.equal(res.ok, true);
    assert.equal(rows(join(root, "audit-fallback.jsonl")).length, 2);
  });

  it("refuses to send when the intent cannot be written anywhere, warns, and prints the row to stderr", async () => {
    const config = tempConfig({ auditDir: join(blocked(), "audits"), auditFallbackPath: join(blocked(), "fb.jsonl") });
    const printed: string[] = [];
    mock.method(process.stderr, "write", (s: string) => {
      printed.push(String(s));
      return true;
    });
    const chain = new MockChainAdapter();
    let sent = false;
    chain.pay = async () => {
      sent = true;
      throw new Error("must not send");
    };
    const res = await executePay({ amount_zec: "0.001", recipient: ALLOWED }, { config, chain });
    mock.restoreAll();
    assert.equal(sent, false);
    assert.equal(res.code, "AUDIT_WRITE_FAILED");
    assert.match(JSON.parse(res.text).audit_warning, /stderr/);
    assert.ok(printed.some((l) => l.includes('"status":"pending"')), printed.join(""));
  });

  it("retries the main log once before falling back", async () => {
    const config = tempConfig();
    const realOpen = fs.openSync;
    let failed = 0;
    mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
      if (String(args[0]).endsWith(".jsonl") && failed === 0) {
        failed++;
        throw new Error("EIO: transient");
      }
      return realOpen(...args);
    });
    const res = await executePay({ amount_zec: "0.001", recipient: ALLOWED }, { config, chain: new MockChainAdapter() });
    assert.equal(res.ok, true);
    assert.equal(failed, 1);
    assert.equal(JSON.parse(res.text).audit_warning, undefined);
  });

  it("read tools warn when their row went to the fallback file", async () => {
    const fallback = join(mkdtempSync(join(tmpdir(), "zshield-fb-")), "fb.jsonl");
    const { client } = await connect(tempConfig({ auditDir: join(blocked(), "audits"), auditFallbackPath: fallback }));
    const body = JSON.parse(textOf(await client.callTool({ name: "zcash_balance", arguments: {} })));
    assert.match(body.audit_warning, /fb\.jsonl/);
    assert.equal(rows(fallback)[0].tool, "zcash_balance");
  });
});
