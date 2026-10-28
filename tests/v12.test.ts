import assert from "node:assert/strict";
import { appendFileSync, chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import { appendAuditEntry } from "../src/audit/log.ts";
import { LiveChainAdapter, type CliRunner } from "../src/chain/live.ts";
import type { ChainAdapter } from "../src/chain/types.ts";
import { loadConfig } from "../src/config.ts";
import { describePolicy } from "../src/policy/describe.ts";
import { startupChecks } from "../src/startup.ts";
import { executeHistory } from "../src/tools/history.ts";
import { executePay, findPossibleSends } from "../src/tools/pay.ts";
import { paymentStatus } from "../src/tools/status.ts";
import type { AuditEntry, Config, TxSummary } from "../src/types.ts";
import { connect, tempConfig, walletJson, withEnv, withUfvk } from "./helpers.ts";

// One regression test (or more) per V12 finding on ff2254b. They only use entry points
// that exist on both sides, so each one can be run against ff2254b to show it fails there.

const R = "utest1" + "s".repeat(100);
const OTHER = "utest1" + "o".repeat(100);
const T0 = Date.parse("2026-10-26T12:00:00Z");
const TX = "ab".repeat(32);

// The per-process payment cache: payments/store.ts now, payments/index.ts on ff2254b.
const resets: (() => void)[] = [];
for (const file of ["store.ts", "index.ts"]) {
  const mod = (await import(`../src/payments/${file}`).catch(() => ({}))) as Record<string, unknown>;
  for (const name of ["resetPaymentStores", "resetPaymentIndexes"]) if (typeof mod[name] === "function") resets.push(mod[name] as () => void);
}
const reset = () => resets.forEach((r) => r());
beforeEach(reset);

function liveConfig(): Config {
  const config = tempConfig({ chainMode: "live", chainNetwork: "testnet" });
  writeFileSync(config.allowlistPath, JSON.stringify({ recipients: [{ address: R }] }));
  return config;
}

function pendingRow(config: Config, callId: string, extra: Partial<AuditEntry> = {}) {
  appendAuditEntry(config.auditDir, {
    ts: new Date(T0).toISOString(), tool: "zcash_pay", call_id: callId, amount_zec: "0.0001", amount_zats: "10000",
    recipient: R, allowlist_hit: true, cap_zec: "0.01", status: "pending", view_key_fingerprint: "f", memo: "inv-7", ...extra,
  } as AuditEntry);
}

function sentTx(over: Partial<TxSummary> = {}): TxSummary {
  return {
    txid: TX, time: new Date(T0 + 2000).toISOString(), status: "confirmed", blockHeight: 500, kind: "sent",
    valueZats: 10000n, outgoing: [{ recipient: R, valueZats: 10000n, memo: "inv-7" }], ...over,
  } as TxSummary;
}

const received = (i: number): TxSummary =>
  ({ txid: i.toString(16).padStart(64, "0"), time: new Date(T0 + 60_000 + i * 1000).toISOString(), status: "confirmed", blockHeight: 600 + i, kind: "received", valueZats: 5n }) as TxSummary;

/** A synced live wallet whose history call honors its limit, like zingo-cli's adapter. */
function wallet(history: TxSummary[], height = 10_000) {
  return {
    mode: "live",
    async pay() {
      throw new Error("must not send");
    },
    getHistory: async (limit: number) => history.slice(0, limit),
    walletHeight: async () => height,
    checkHealth: async () => ({ walletHeight: height, chainTip: height, spendableZats: 0n, synced: true }),
    syncWallet: async () => ({ complete: true, detail: "done" }),
  } as unknown as ChainAdapter;
}

describe("V12 F-18: truncated history never proves a payment was not sent", () => {
  it("a send pushed past the newest 50 entries is still found, not expired", async () => {
    const config = liveConfig();
    pendingRow(config, "c1", { idempotency_key: "k1" });
    const history = [...Array.from({ length: 60 }, (_, i) => received(i)), sentTx()];
    const s = await paymentStatus(config, wallet(history), { call_id: "c1" }, T0 + 3 * 3600_000);
    assert.equal(s.state, "mined", JSON.stringify(s));
    assert.equal(s.txid, TX);
  });

  it("no match and no recorded height: unknown, and the guidance never says pay again", async () => {
    const config = liveConfig();
    pendingRow(config, "c2");
    const s = await paymentStatus(config, wallet([]), { call_id: "c2" }, T0 + 10 * 3600_000);
    assert.notEqual(s.state, "expired");
    assert.notEqual(s.state, "not_found");
    assert.doesNotMatch(s.message, /new (idempotency )?key|pay again with/i);
  });
});

describe("V12 F-20: settled state never moves backwards", () => {
  it("mined stays mined when a later read no longer shows the transaction", async () => {
    const config = liveConfig();
    pendingRow(config, "c1");
    assert.equal((await paymentStatus(config, wallet([sentTx()]), { call_id: "c1" }, T0 + 60_000)).state, "mined");
    reset();
    const later = await paymentStatus(config, wallet([]), { call_id: "c1" }, T0 + 10 * 3600_000);
    assert.equal(later.state, "mined", JSON.stringify(later));
  });
});

describe("V12 F-8: possible sends are matched on the whole history and the recipient", () => {
  const utc = (ms: number) => new Date(ms).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
  const block = (txid: string, recipient: string | undefined, kind = "sent", value = 100000) =>
    `{\n    txid: ${txid}\n    datetime: ${utc(Date.now())}\n    status: confirmed\n    blockheight: 999\n    kind: ${kind}\n    value: ${value}\n    fee: 10000\n` +
    (recipient ? `    outgoing orchard notes: \n\t{\n            value: ${value}\n            memo: \n            recipient: ${recipient}\n            output index: 0\n        }\n` : "") +
    "}\n";
  // The heuristic search for an unbound send: the wallet lists the whole history, the
  // JSON commands vouch for its entries, and only this recipient and amount match.
  const unknownSend = async (transactions: string, txids: string[]) => {
    const runner: CliRunner = async (_b, args) => {
      const j = walletJson(args, txids.map((txid) => ({ txid, height: 999 })));
      if (j) return j;
      if (args.at(-1) === "transactions") return transactions;
      throw new Error(`unexpected ${args.at(-1)}`);
    };
    const chain = new LiveChainAdapter({ network: "testnet", runner: withUfvk(runner) });
    const found = await findPossibleSends(chain, { amountZats: 100000n, recipient: R }, Date.now() - 1000);
    return found as { txid: string }[];
  };

  it("the send is found behind 30 newer wallet entries", async () => {
    const newer = Array.from({ length: 30 }, (_, i) => block((i + 1).toString(16).padStart(64, "0"), undefined, "received", 7));
    const found = await unknownSend(newer.join("") + block(TX, R), [TX]);
    assert.deepEqual(found.map((p) => p.txid), [TX]);
  });

  it("a same-amount send to another recipient is not attributed to the call", async () => {
    assert.deepEqual(await unknownSend(block(TX, OTHER), [TX]), []);
  });

  it("zcash_history shows the recipient and memo of a send", async () => {
    const config = liveConfig();
    const chain = { mode: "live", getHistory: async () => [sentTx({ outgoing: [{ recipient: R, valueZats: 10000n, memo: "rent" }] } as Partial<TxSummary>)] } as unknown as ChainAdapter;
    const text = (await executeHistory({ limit: 5 }, { config, chain })).text;
    assert.match(text, new RegExp(R));
    assert.match(text, /rent/);
  });
});

describe("V12 F-14: every timeout has a ceiling", () => {
  for (const name of ["ZINGO_HEALTH_TIMEOUT_MS", "ZINGO_READ_TIMEOUT_MS", "STATUS_SYNC_TIMEOUT_MS", "HEALTH_SYNC_TIMEOUT_MS"]) {
    it(`${name} above its maximum stops loading`, async () => {
      await withEnv(name, String(365 * 24 * 3600_000), async () => {
        assert.throws(() => loadConfig(mkdtempSync(join(tmpdir(), "zshield-cfg-"))), new RegExp(name));
      });
    });
  }
});

describe("V12 F-16: endpoint credentials never reach the caller", () => {
  it("LIGHTWALLETD_URL with a password is refused at load", async () => {
    await withEnv("LIGHTWALLETD_URL", "https://alice:hunter2secret@lwd.example:443", async () => {
      assert.throws(() => loadConfig(mkdtempSync(join(tmpdir(), "zshield-cfg-"))), /credential|password|user/i);
    });
  });

  it("a failing health check does not echo the server URL secret", async () => {
    const config = liveConfig();
    const server = "https://alice:hunter2secret@lwd.example:443/?key=tok3nsecretvalue";
    const runner: CliRunner = async (_b, args) => {
      throw new Error(`zingo-cli: cannot connect to ${args[args.indexOf("--server") + 1]}`);
    };
    const ufvk = withUfvk(async () => "");
    const wrapped = new LiveChainAdapter({
      network: "testnet",
      server,
      runner: async (b, a, o) => (a.at(-1) === "info" ? runner(b, a, o) : ufvk(b, a, o)),
    });
    const r = await executePay({ idempotency_key: "t-v12-2", amount_zec: "0.001", recipient: R }, { config, chain: wrapped });
    assert.equal(r.code, "CHAIN_UNREACHABLE");
    for (const secret of ["hunter2secret", "tok3nsecretvalue"]) {
      assert.ok(!r.text.includes(secret), r.text);
      assert.ok(!JSON.stringify(readAll(config)).includes(secret));
    }
  });
});

function readAll(config: Config): string[] {
  return readdirSync(config.auditDir)
    .map((n) => join(config.auditDir, n))
    .filter((p) => statSync(p).isFile())
    .map((p) => readFileSync(p, "utf8"));
}

describe("V12 F-13: policy reads count against the rate limit", () => {
  it("the policy resource is refused once the minute's budget is spent", async () => {
    const { client } = await connect(tempConfig({ rateLimitPerMin: 2 }));
    const read = () =>
      client.readResource({ uri: "zshield://policy" }).then(
        (r) => r.contents.map((c) => ("text" in c ? c.text : "")).join(""),
        (e: unknown) => String(e)
      );
    await read();
    await read();
    assert.match(await read(), /RATE_LIMITED/);
  });
});

describe("V12 F-15: the policy shows no host paths", () => {
  it("neither the allow-list path nor the audit dir is in the policy", () => {
    const config = tempConfig();
    const text = JSON.stringify(describePolicy(config));
    assert.ok(!text.includes(config.allowlistPath), text);
    assert.ok(!text.includes(config.auditDir), text);
    assert.ok(!text.includes(tmpdir()), text);
  });
});

describe("V12 F-17: existing payment records are checked at startup", { skip: process.platform === "win32" }, () => {
  it("a world-writable legacy audit dir and file are made private", () => {
    const config = tempConfig();
    mkdirSync(config.auditDir, { recursive: true });
    const file = join(config.auditDir, "audit-2026-10-26.jsonl");
    writeFileSync(file, "");
    chmodSync(config.auditDir, 0o777);
    chmodSync(file, 0o666);
    startupChecks(config, process.platform);
    assert.equal(statSync(config.auditDir).mode & 0o077, 0);
    assert.equal(statSync(file).mode & 0o077, 0);
  });

  it("a symlinked audit file stops the server", () => {
    const config = tempConfig();
    mkdirSync(config.auditDir, { recursive: true });
    const target = join(mkdtempSync(join(tmpdir(), "zshield-elsewhere-")), "x.jsonl");
    writeFileSync(target, "");
    symlinkSync(target, join(config.auditDir, "audit-2026-10-26.jsonl"));
    assert.ok(lstatSync(join(config.auditDir, "audit-2026-10-26.jsonl")).isSymbolicLink());
    assert.throws(() => startupChecks(config, process.platform), /symlink|symbolic/i);
  });

  it("a payment row forged into the audit log does not change payment state", async () => {
    const config = tempConfig();
    const first = await paymentStatus(config, wallet([]), { idempotency_key: "forged" }).catch((e: Error) => e);
    assert.ok(first instanceof Error);
    pendingRow(config, "forged-call", { idempotency_key: "forged" });
    const again = await paymentStatus(config, wallet([]), { idempotency_key: "forged" }).catch((e: Error) => e);
    assert.ok(again instanceof Error, JSON.stringify(again));
  });
});

describe("V12 F-11: Windows checks the ACL of the payment records too", () => {
  it("refuses when Everyone can read the audit dir", () => {
    const config = liveConfig();
    const dir = mkdtempSync(join(tmpdir(), "zshield-winwallet-"));
    config.zingoDataDir = dir;
    mkdirSync(config.auditDir, { recursive: true });
    const PRIVATE = ["DESKTOP-1\\alice:(OI)(CI)(F)", "NT AUTHORITY\\SYSTEM:(OI)(CI)(F)"];
    const icacls = (p: string) => {
      const aces = p.startsWith(config.auditDir) ? [...PRIVATE, "Everyone:(OI)(CI)(RX)"] : PRIVATE;
      const pad = " ".repeat(p.length + 1);
      return aces.map((a, i) => (i === 0 ? `${p} ${a}` : `${pad}${a}`)).join("\r\n") + "\r\n\r\nSuccessfully processed 1 files; Failed processing 0 files\r\n";
    };
    assert.throws(() => startupChecks(config, "win32", { icacls, env: {} } as Parameters<typeof startupChecks>[2]), /audit/i);
  });
});

describe("V12 F-19: lookups do not rebuild from the whole audit log", () => {
  it("100 status misses on a 5000-row audit log stay fast", async () => {
    const config = tempConfig();
    pendingRow(config, "bulk-first");
    const file = join(config.auditDir, readdirSync(config.auditDir).find((n) => n.endsWith(".jsonl"))!);
    const row = (i: number) =>
      JSON.stringify({ ts: new Date(T0).toISOString(), tool: "zcash_pay", call_id: `bulk-${i}`, amount_zec: "0.0001", amount_zats: "10000", recipient: R, allowlist_hit: true, cap_zec: "0.01", status: "pending", view_key_fingerprint: "f", idempotency_key: `bulk-${i}` });
    appendFileSync(file, Array.from({ length: 5000 }, (_, i) => row(i)).join("\n") + "\n");
    await paymentStatus(config, wallet([]), { idempotency_key: "warm" }).catch(() => undefined);
    const start = performance.now();
    for (let i = 0; i < 100; i++) await paymentStatus(config, wallet([]), { idempotency_key: `missing-${i}` }).catch(() => undefined);
    const ms = performance.now() - start;
    if (process.env.RACE_LOG) console.log(`F-19: 100 misses took ${Math.round(ms)} ms`);
    assert.ok(ms < 500, `100 misses took ${Math.round(ms)} ms`);
  });
});
