import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import fs from "node:fs";
import { join, dirname } from "node:path";
import { appendAuditEntry } from "../src/audit/log.ts";
import { MockChainAdapter } from "../src/chain/mock.ts";
import { executePay } from "../src/tools/pay.ts";
import { ALLOWED, readAuditRows, tempConfig } from "./helpers.ts";

/** Records which paths were fsynced, in order, by tracking the fd each open returned. */
let events: string[] = [];
beforeEach(() => {
  events = [];
  const paths = new Map<number, string>();
  const realOpen = fs.openSync;
  const realFsync = fs.fsyncSync;
  mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
    const fd = realOpen(...args);
    paths.set(fd, String(args[0]));
    return fd;
  });
  mock.method(fs, "fsyncSync", (fd: number) => {
    events.push(`fsync ${paths.get(fd) ?? fd}`);
    return realFsync(fd);
  });
});
afterEach(() => mock.restoreAll());

describe("durable audit writes (V12 F-7)", () => {
  it("fsyncs the audit file on every append", () => {
    const config = tempConfig();
    const file = appendAuditEntry(config.auditDir, { ts: new Date().toISOString(), tool: "zcash_balance", call_id: "a", status: "ok" } as never);
    appendAuditEntry(config.auditDir, { ts: new Date().toISOString(), tool: "zcash_balance", call_id: "b", status: "ok" } as never);
    assert.equal(events.filter((e) => e === `fsync ${file}`).length, 2);
  });

  it("fsyncs the directory when it creates the audit folder and file", () => {
    const config = tempConfig();
    appendAuditEntry(config.auditDir, { ts: new Date().toISOString(), tool: "zcash_balance", call_id: "a", status: "ok" } as never);
    assert.ok(events.includes(`fsync ${dirname(config.auditDir)}`), events.join(", "));
    assert.ok(events.includes(`fsync ${config.auditDir}`), events.join(", "));
  });

  it("flushes the pending intent row before the chain send", async () => {
    const config = tempConfig();
    const chain = new MockChainAdapter();
    const realPay = chain.pay.bind(chain);
    chain.pay = async (req) => {
      events.push("pay");
      const rows = readAuditRows(config);
      assert.equal(rows.at(-1)?.status, "pending");
      return realPay(req);
    };
    const res = await executePay({ amount_zec: "0.001", recipient: ALLOWED }, { config, chain });
    assert.equal(res.ok, true);
    const day = new Date().toISOString().slice(0, 10);
    const payAt = events.indexOf("pay");
    const fsyncAt = events.indexOf(`fsync ${join(config.auditDir, `${day}.jsonl`)}`);
    assert.ok(fsyncAt >= 0 && fsyncAt < payAt, events.join(", "));
  });
});
