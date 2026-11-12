import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, it, mock } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.ts";
import { MockChainAdapter } from "../src/chain/mock.ts";
import { checkServerUrl, assertFingerprintSalt } from "../src/config.ts";
import { AUDIT_SLOT_BYTES, reserveAudit } from "../src/audit/budget.ts";
import { boundAuditEntry, writeAuditRow, fingerprintViewKey } from "../src/audit/log.ts";
import { createRedactor, redact, registerRedaction } from "../src/redact.ts";
import { executePay } from "../src/tools/pay.ts";
import { acquireWalletLock } from "../src/payments/lock.ts";
import { storeFor } from "../src/payments/store.ts";
import { executeHistory } from "../src/tools/history.ts";
import { ALLOWED, tempConfig, textOf } from "./helpers.ts";

afterEach(() => mock.restoreAll());

async function clientFor(config = tempConfig(), chain = new MockChainAdapter()) {
  const server = createServer(config, chain);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name: "oct31", version: "1" });
  await client.connect(a);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe("October 31 root causes", () => {
  it("F-3 row bounds include the truncation marker's bytes", () => {
    for (let n = 7800; n < 8200; n++) {
      const row = boundAuditEntry({ recipient: "r".repeat(513), values: ["x".repeat(n)] });
      assert.ok(Buffer.byteLength(JSON.stringify(row)) < AUDIT_SLOT_BYTES);
    }
  });
  it("F-3 diagnostics exhaust bounded capacity without consuming payment capacity", async () => {
    const config = tempConfig({ auditDiagnosticMaxBytes: AUDIT_SLOT_BYTES, auditMaxBytes: 4 * AUDIT_SLOT_BYTES });
    const chain = new MockChainAdapter();
    const row = {
      ts: new Date().toISOString(),
      tool: "zcash_balance" as const,
      call_id: "read",
      mode: "mock" as const,
      status: "ok" as const,
    };
    assert.equal(writeAuditRow(config, row, () => {}).durable, true);
    assert.equal(writeAuditRow(config, row, () => {}).durable, true); // bounded fallback
    for (let n = 0; n < 20; n++) assert.equal(writeAuditRow(config, row, () => {}).durable, false);
    assert.equal((await executePay({ amount_zec: "0.001", recipient: ALLOWED }, { config, chain })).ok, true);
  });

  it("F-3 exhausted payment logs refuse before creating more durable payment records", async () => {
    const config = tempConfig({ auditMaxBytes: AUDIT_SLOT_BYTES });
    const chain = new MockChainAdapter();
    const store = storeFor(config, chain);
    await executePay({ amount_zec: "0.001", recipient: ALLOWED }, { config, chain });
    const before = fs.readdirSync(join(store.dir, "calls")).length;
    let sent = 0;
    chain.pay = async () => {
      sent++;
      throw new Error("must not send");
    };
    for (let n = 0; n < 10; n++) {
      const result = await executePay({ amount_zec: "0.001", recipient: ALLOWED }, { config, chain });
      assert.equal(result.code, "AUDIT_WRITE_FAILED");
    }
    assert.equal(sent, 0);
    assert.equal(fs.readdirSync(join(store.dir, "calls")).length, before);
  });

  it("F-3 concurrent processes cannot over-reserve the same byte capacity", async () => {
    const root = fs.mkdtempSync(join(tmpdir(), "zshield-quota-"));
    const file = join(root, "2026-11-01.jsonl");
    const source = `import {reserveAudit,AUDIT_SLOT_BYTES} from ${JSON.stringify(new URL("../src/audit/budget.ts", import.meta.url).href)};try{reserveAudit(${JSON.stringify(file)},false,{auditDiagnosticMaxBytes:2*AUDIT_SLOT_BYTES},true);process.exitCode=0}catch{process.exitCode=2}`;
    const exits = await Promise.all(
      Array.from(
        { length: 6 },
        () =>
          new Promise<number | null>((resolve, reject) => {
            const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
              stdio: "ignore",
            });
            child.on("error", reject);
            child.on("exit", resolve);
          }),
      ),
    );
    assert.equal(exits.filter((n) => n === 0).length, 2);
    assert.equal(exits.filter((n) => n === 2).length, 4);
  });

  it("F-37 published bindings survive a directory fsync failure without rollback races", async () => {
    const config = tempConfig();
    const chain = new MockChainAdapter();
    const store = storeFor(config, chain);
    const realSync = fs.fsyncSync;
    let armed = true;
    mock.method(fs, "fsyncSync", (fd: number) => {
      if (armed && fs.fstatSync(fd).isDirectory() && fs.realpathSync(`/proc/self/fd/${fd}`).endsWith("/keys")) {
        throw Object.assign(new Error("fsync injected"), { code: "EIO" });
      }
      return realSync(fd);
    });
    const input = { amount_zec: "0.001", recipient: ALLOWED, idempotency_key: "failed-bind" };
    // Keep publication, but fail closed until a durable no-send proof allows retry.
    const first = await executePay(input, { config, chain });
    assert.ok(store.readKey(input.idempotency_key), "published key must remain after dir fsync failure");
    assert.equal(first.code, "STATE_WRITE_FAILED");
    assert.equal(store.bindingRetryable(store.readKey(input.idempotency_key)!), true);
    armed = false;
    assert.equal((await executePay({ ...input, amount_zec: "0.002" }, { config, chain })).code, "IDEMPOTENCY_CONFLICT");
    const replay = JSON.parse((await executePay(input, { config, chain })).text);
    assert.notEqual(replay.call_id, JSON.parse(first.text).call_id);
    assert.equal(replay.ok, true);
  });

  it("F-42 policy floods leave payment and status allowances available", async () => {
    const c = await clientFor(tempConfig({ rateLimitPerMin: 1 }));
    try {
      for (let n = 0; n < 8; n++) await c.client.readResource({ uri: "zshield://policy" });
      const pay = await c.client.callTool({
        name: "zcash_pay",
        arguments: { amount_zec: "0.001", recipient: ALLOWED },
      });
      assert.equal(pay.isError, false);
      const status = await c.client.callTool({
        name: "zcash_payment_status",
        arguments: { call_id: JSON.parse(textOf(pay)).call_id },
      });
      assert.notEqual(JSON.parse(textOf(status)).code, "RATE_LIMITED");
    } finally {
      await c.close();
    }
  });

  it("F-43 opt-in never authorizes credentialed HTTP", () => {
    for (const suffix of ["?token=longsecret", "#longsecret"])
      assert.throws(
        () => checkServerUrl(`http://localhost:9067/${suffix}`, { ZSHIELD_ALLOW_URL_CREDENTIALS: "1" }),
        /requires https/,
      );
    assert.throws(
      () => checkServerUrl("http://username:password@host/", { ZSHIELD_ALLOW_URL_CREDENTIALS: "1" }),
      /requires https/,
    );
    assert.equal(checkServerUrl("http://localhost:9067"), "http://localhost:9067");
    assert.throws(() => checkServerUrl("https://host/?token=longsecret", {}), /carries credentials/);
    assert.ok(checkServerUrl("https://host/?token=longsecret", { ZSHIELD_ALLOW_URL_CREDENTIALS: "1" }));
  });

  it("F-44/F-45 custom errors and identifying fallback filenames never reach warnings", () => {
    const config = tempConfig({ auditFallbackPath: join(tmpdir(), "private tenant", "client-123.jsonl") });
    mock.method(fs, "openSync", () => {
      throw new Error("error at /private tenant/customer files");
    });
    const result = writeAuditRow(
      config,
      { ts: new Date().toISOString(), tool: "zcash_balance", call_id: "x", mode: "mock", status: "ok" },
      () => {},
    );
    for (const secret of ["tenant", "customer", "client-123"]) assert.ok(!result.warning?.includes(secret));
  });

  it("F-46 live defaults are refused; independent salts separate fingerprints", () => {
    for (const salt of ["", "  ", "dev-only-change-me"])
      assert.throws(
        () => assertFingerprintSalt({ chainMode: "live", viewKeyFingerprintSalt: salt }),
        /deployment-specific/,
      );
    assert.notEqual(
      fingerprintViewKey("same-wallet", "deployment-a"),
      fingerprintViewKey("same-wallet", "deployment-b"),
    );
  });

  it("F-47 async redaction contexts do not share configuration values", async () => {
    const a = createRedactor(),
      b = createRedactor();
    a.run(() => registerRedaction("/tenant-A/wallet", "[wallet dir]"));
    b.run(() => registerRedaction("/tenant-B/wallet", "[wallet dir]"));
    const results = await Promise.all(
      [a, b].map((r) =>
        r.run(async () => {
          await Promise.resolve();
          return redact("/tenant-A/wallet /tenant-B/wallet");
        }),
      ),
    );
    assert.deepEqual(results, ["[wallet dir] /tenant-B/wallet", "/tenant-A/wallet [wallet dir]"]);
  });

  it("F-48 a configured wallet symlink's canonical target is redacted in tool errors", async () => {
    const root = fs.mkdtempSync(join(tmpdir(), "zshield-link-")),
      target = join(root, "canonical tenant");
    fs.mkdirSync(target);
    const link = join(root, "wallet");
    fs.symlinkSync(target, link);
    const chain = new MockChainAdapter();
    chain.getBalance = async () => {
      throw new Error(`failure at ${target}`);
    };
    const c = await clientFor(tempConfig({ zingoDataDir: link }), chain);
    try {
      const body = textOf(await c.client.callTool({ name: "zcash_balance", arguments: {} }));
      assert.ok(!body.includes(target));
      assert.ok(body.includes("[wallet dir]"));
    } finally {
      await c.close();
    }
  });

  it("F-47 creating a second server does not change the first server's redaction", async () => {
    const configA = tempConfig(),
      configB = tempConfig();
    const chainA = new MockChainAdapter(),
      chainB = new MockChainAdapter();
    chainA.getBalance = chainB.getBalance = async () => {
      throw new Error(`synthetic ${configA.auditDir}`);
    };
    const a = await clientFor(configA, chainA),
      b = await clientFor(configB, chainB);
    try {
      const resultA = textOf(await a.client.callTool({ name: "zcash_balance", arguments: {} }));
      const resultB = textOf(await b.client.callTool({ name: "zcash_balance", arguments: {} }));
      assert.ok(!resultA.includes(configA.auditDir));
      assert.ok(resultB.includes(configA.auditDir), "instance A's registry must not transform instance B's data");
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("F-28 a waiting writer closes the OS admission gate to new readers", async () => {
    const dir = fs.mkdtempSync(join(tmpdir(), "zshield-priority-"));
    const store = { dir, requireOsLock: true };
    const first = await acquireWalletLock(store, 0, "zcash_history");
    const go = join(dir, "release-writer");
    const source = `import {acquireWalletLock} from ${JSON.stringify(new URL("../src/payments/lock.ts", import.meta.url).href)};import fs from 'node:fs';const l=await acquireWalletLock(${JSON.stringify(store)},5000,"zcash_pay");console.log("HELD");while(!fs.existsSync(${JSON.stringify(go)}))await new Promise(r=>setTimeout(r,10));await l.release();`;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const done = new Promise<number | null>((resolve) => child.on("exit", resolve));
    const held = new Promise<void>((resolve) => child.stdout.on("data", () => resolve()));
    try {
      // The first reader still holds send.flock. Only the new turnstile can refuse
      // this shared probe, proving writer priority before the wallet becomes free.
      let gateClosed = false;
      const deadline = Date.now() + 3000;
      while (!gateClosed && Date.now() < deadline) {
        const code = await new Promise((resolve) =>
          spawn(
            "perl",
            [
              "-e",
              'use Fcntl qw(:flock); open(my $f,"+<",$ARGV[0]) or exit 2; exit(flock($f,LOCK_SH|LOCK_NB)?0:1)',
              join(dir, "send-priority.flock"),
            ],
            { stdio: "ignore" },
          ).on("exit", resolve),
        );
        gateClosed = code === 1;
        if (!gateClosed) await new Promise((r) => setTimeout(r, 10));
      }
      assert.equal(gateClosed, true);
      await first.release();
      await held;
      await assert.rejects(acquireWalletLock(store, 0, "zcash_history"), /holds|in progress/);
      fs.writeFileSync(go, "go");
      assert.equal(await done, 0);
      const after = await acquireWalletLock(store, 0, "zcash_history");
      await after.release();
    } finally {
      await first.release();
      child.kill();
    }
  });
});
