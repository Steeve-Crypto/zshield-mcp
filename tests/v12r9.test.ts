import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import { appendAuditEntry } from "../src/audit/log.ts";
import { MockChainAdapter } from "../src/chain/mock.ts";
import { fallbackAuditPath } from "../src/audit/log.ts";
import { paymentParamsHash, resetPaymentStores, storeFor, walletStateDir } from "../src/payments/store.ts";
import { executePay } from "../src/tools/pay.ts";
import type { PaymentReceipt, PaymentRequest } from "../src/types.ts";
import { startupChecks } from "../src/startup.ts";
import { LiveChainAdapter, type CliRunner } from "../src/chain/live.ts";
import { executeHistory } from "../src/tools/history.ts";
import { assertSafeAncestors } from "../src/fsafe.ts";
import { hooks, loadAllowlist } from "../src/policy/allowlist.ts";
import { resetPins } from "../src/chain/pin.ts";
import { ALLOWED, tempConfig, walletJson, withUfvk } from "./helpers.ts";

// V12 run 6 decision tests (F-24 to F-25, F-29 to F-33, F-35, F-36).

beforeEach(() => {
  resetPaymentStores();
  resetPins();
});

/** A mock chain bound to a wallet dir, counting sends. */
function walletChain(walletDir: string) {
  const chain = new MockChainAdapter({ stateDir: walletStateDir(walletDir) });
  const real = chain.pay.bind(chain);
  const sent: PaymentRequest[] = [];
  chain.pay = async (req: PaymentRequest): Promise<PaymentReceipt> => {
    sent.push(req);
    return real(req);
  };
  return { chain, sent };
}
const wallet = () => mkdtempSync(join(tmpdir(), "zshield-wallet-"));

describe("F-25, F-29, F-36: audit rows never seed the payment store", () => {
  const KEY = "forged-key-1";
  const input = { amount_zec: "0.001", recipient: ALLOWED, idempotency_key: KEY };
  const rows = (callId: string) => {
    const base = { tool: "zcash_pay" as const, call_id: callId, amount_zec: "0.001", amount_zats: "100000", recipient: ALLOWED, allowlist_hit: true, cap_zec: 0.1, view_key_fingerprint: "f", idempotency_key: KEY, params_sha256: paymentParamsHash(input) };
    return [
      { ...base, ts: new Date().toISOString(), status: "pending" as const },
      { ...base, ts: new Date().toISOString(), status: "ok" as const, mock_txid: "cd".repeat(32) },
    ];
  };

  it("a forged audit row does not bind a key or replay a payment", async () => {
    const config = tempConfig();
    for (const r of rows("forged-1")) appendAuditEntry(config.auditDir, r);
    const { chain, sent } = walletChain(wallet());
    const r = JSON.parse((await executePay(input, { config, chain })).text);
    assert.equal(sent.length, 1);
    assert.notEqual(r.idempotent_replay, true);
    assert.notEqual(r.call_id, "forged-1");
  });

  it("a forged fallback row creates no intent and no key binding", () => {
    const config = tempConfig();
    const fb = fallbackAuditPath(config.auditDir, config.auditFallbackPath);
    mkdirSync(join(fb, ".."), { recursive: true });
    writeFileSync(fb, rows("forged-2").map((r) => JSON.stringify(r)).join("\n") + "\n");
    const store = storeFor(config, { stateDir: walletStateDir(wallet()) });
    assert.equal(store.readKey(KEY), undefined);
    assert.equal(store.readCall("forged-2"), undefined);
    assert.deepEqual(readdirSync(join(store.dir, "calls")), []);
    assert.deepEqual(readdirSync(join(store.dir, "keys")), []);
  });

  it("a big audit corpus does no work at startup", () => {
    const config = tempConfig();
    mkdirSync(config.auditDir, { recursive: true });
    for (let d = 0; d < 40; d++) {
      const lines: string[] = [];
      for (let i = 0; i < 50; i++) lines.push(...rows(`bulk-${d}-${i}`).map((r) => JSON.stringify({ ...r, idempotency_key: `k-${d}-${i}` })));
      writeFileSync(join(config.auditDir, `2026-01-${String(d + 1).padStart(2, "0")}.jsonl`), lines.join("\n") + "\n");
    }
    const store = storeFor(config, { stateDir: walletStateDir(wallet()) });
    assert.deepEqual(readdirSync(join(store.dir, "calls")), []);
    assert.deepEqual(readdirSync(join(store.dir, "keys")), []);
    assert.equal(existsSync(join(store.dir, "imports")), false);
  });

  it("calls an older version imported stay in the store and still replay", async () => {
    const w = wallet();
    const config = tempConfig();
    const { chain, sent } = walletChain(w);
    const store = storeFor(config, chain);
    store.writeIntent({
      call_id: "old-import-1", ts: new Date().toISOString(), amount_zec: "0.001", amount_zats: "100000", recipient: ALLOWED,
      allowlist_hit: true, cap_zec: 0.1, view_key_fingerprint: "f", idempotency_key: KEY, params_sha256: paymentParamsHash(input), imported: true,
    });
    store.bindKey(KEY, "old-import-1", paymentParamsHash(input));
    store.appendEvent({ ts: new Date().toISOString(), call_id: "old-import-1", state: "sent", txid: "cd".repeat(32), by: "import" });
    resetPaymentStores();
    const r = JSON.parse((await executePay(input, { config, chain })).text);
    assert.equal(sent.length, 0);
    assert.equal(r.idempotent_replay, true);
    assert.equal(r.call_id, "old-import-1");
  });
});

describe("F-32, F-33: no live mode on Windows, and no ACL code", () => {
  const live = () => tempConfig({ chainMode: "live", chainNetwork: "testnet", zingoDataDir: mkdtempSync(join(tmpdir(), "zshield-winwallet-")) });

  it("live mode refuses to start on win32 with a clear error", () => {
    assert.throws(() => startupChecks(live(), "win32"), /testnet mode is not supported on Windows/);
  });

  it("mock mode still starts on win32, with no ACL check", () => {
    assert.deepEqual(startupChecks(tempConfig(), "win32"), []);
  });

  it("the ACL parser is gone", () => {
    assert.equal(existsSync(new URL("../src/chain/winacl.ts", import.meta.url)), false);
  });

  it("wrapForWallet still refuses on win32 and nothing is built", async () => {
    const { wrapForWallet, WalletBusyError } = await import("../src/chain/walletlock.ts");
    const real = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      assert.throws(
        () => wrapForWallet("zingo-cli", ["info"], { lockFile: join(tmpdir(), "x", "zingo.flock"), waitMs: 1000 }),
        (e: unknown) => e instanceof WalletBusyError && e.kind === "unavailable"
      );
    } finally {
      Object.defineProperty(process, "platform", real);
    }
  });
});

describe("F-35: zcash_history does not return recipients or memos", () => {
  const MEMO = "invoice-secret-77";

  it("mock mode: no recipient or memo in the text, the data stays inside", async () => {
    const config = tempConfig();
    const chain = new MockChainAdapter();
    await executePay({ amount_zec: "0.01", recipient: ALLOWED, memo: MEMO }, { config, chain });
    const text = (await executeHistory({}, { config, chain })).text;
    assert.equal(text.includes(ALLOWED), false);
    assert.equal(text.includes(MEMO), false);
    assert.equal("outgoing" in JSON.parse(text).transactions[0], false);
    const [tx] = await chain.getHistory(10);
    assert.equal(tx.outgoing?.[0].recipient, ALLOWED);
    assert.equal(tx.outgoing?.[0].memo, MEMO);
  });

  it("live mode: no recipient or memo in the text, the data stays inside", async () => {
    const config = tempConfig({ chainMode: "live", chainNetwork: "testnet" });
    const TX = "ab".repeat(32);
    const RCPT = "utest1tkzp6v69";
    const listing = `{\n    txid: ${TX}\n    datetime: 2026-10-26 12:00:02 UTC\n    status: confirmed\n    blockheight: 500\n    kind: sent\n    value: 10000\n    fee: 10000\n    outgoing orchard notes: \n\t{\n            value: 10000\n            memo: ${MEMO}\n            recipient: ${RCPT}\n            output index: 0\n        }\n}\n`;
    const runner: CliRunner = async (_b, args) =>
      walletJson(args, [{ txid: TX, height: 500, memos: [{ recipient: RCPT, memo: MEMO, value: 10000 }] }]) ?? listing;
    const chain = new LiveChainAdapter({ network: "testnet", runner });
    const text = (await executeHistory({}, { config, chain })).text;
    assert.equal(JSON.parse(text).count, 1);
    assert.equal(text.includes(RCPT), false);
    assert.equal(text.includes(MEMO), false);
    const [tx] = await chain.getHistory(10, { offline: true });
    assert.equal(tx.outgoing?.[0].recipient, RCPT);
    assert.equal(tx.outgoing?.[0].memo, MEMO);
  });
});

const UTEST = "utest1" + "q".repeat(100);
const TXID = "ab".repeat(32);
const posix = process.platform === "win32" ? { skip: "POSIX only" } : {};
const tmp = () => mkdtempSync(join(tmpdir(), "zshield-posix-"));
const list = (dir: string, mode = 0o600) => {
  const f = join(dir, "allow.json");
  writeFileSync(f, JSON.stringify({ recipients: [{ address: ALLOWED }] }));
  chmodSync(f, mode);
  return f;
};

describe("F-24, F-31: the allow-list file", posix, () => {
  it("loads a private regular file", () => {
    assert.equal(loadAllowlist(list(tmp())).length, 1);
  });
  it("refuses a symlink, even to a good file", () => {
    const dir = tmp();
    const real = list(dir);
    const link = join(dir, "link.json");
    symlinkSync(real, link);
    assert.throws(() => loadAllowlist(link), /symlink/);
  });
  it("refuses a group- or world-writable file", () => {
    for (const mode of [0o620, 0o602, 0o666]) {
      assert.throws(() => loadAllowlist(list(tmp(), mode)), /writable by group or other/);
    }
  });
  it("refuses a file owned by another user", { skip: process.getuid?.() === 0 }, () => {
    const f = list(tmp());
    // Pretend the process is a different user by checking the same rule through the owner field.
    const uid = process.getuid!();
    const real = process.getuid;
    (process as { getuid: () => number }).getuid = () => uid + 1;
    try {
      assert.throws(() => loadAllowlist(f), /owned by another user/);
    } finally {
      (process as { getuid: typeof real }).getuid = real;
    }
  });
  it("refuses a file swapped for another between the check and the open", () => {
    const dir = tmp();
    const f = list(dir);
    const other = join(dir, "other.json");
    writeFileSync(other, JSON.stringify({ recipients: [{ address: "u1evil" }] }));
    chmodSync(other, 0o600);
    hooks.beforeOpen = () => renameSync(other, f);
    try {
      assert.throws(() => loadAllowlist(f), /changed while it was being opened/);
    } finally {
      hooks.beforeOpen = undefined;
    }
  });
  it("is checked at startup, in mock and live mode", () => {
    const bad = tempConfig();
    chmodSync(bad.allowlistPath, 0o666);
    assert.throws(() => startupChecks(bad), /writable by group or other/);
    const dir = tmp();
    const link = join(dir, "link.json");
    symlinkSync(list(dir), link);
    assert.throws(() => startupChecks(tempConfig({ allowlistPath: link })), /symlink/);
    const walletDir = wallet();
    chmodSync(walletDir, 0o700);
    const live = tempConfig({ chainMode: "live", chainNetwork: "testnet", zingoDataDir: walletDir });
    chmodSync(live.allowlistPath, 0o666);
    assert.throws(() => startupChecks(live), /writable by group or other/);
  });
  it("a missing allow-list still starts and fails at call time", () => {
    const config = tempConfig();
    rmSync(config.allowlistPath);
    assert.doesNotThrow(() => startupChecks(config));
  });
});

describe("F-24, F-31: directories above the paths", posix, () => {
  it("refuses an ancestor writable by group or other without the sticky bit", () => {
    const root = tmp();
    mkdirSync(join(root, "sub"));
    for (const mode of [0o770, 0o707, 0o777]) {
      chmodSync(root, mode);
      assert.throws(() => assertSafeAncestors(join(root, "sub", "x")), /writable by other users and not sticky/);
    }
    chmodSync(root, 0o700);
  });
  it("allows a sticky shared directory and a path that does not exist yet", () => {
    const root = tmp();
    chmodSync(root, 0o1777);
    assert.doesNotThrow(() => assertSafeAncestors(join(root, "new", "deeper", "x")));
    chmodSync(root, 0o700);
  });
  it("follows symlinks to judge the real parents", () => {
    const open = tmp();
    chmodSync(open, 0o777);
    const real = join(open, "real");
    mkdirSync(real, { mode: 0o700 });
    const via = tmp();
    symlinkSync(real, join(via, "link"));
    assert.throws(() => assertSafeAncestors(join(via, "link", "x")), /not sticky/);
    chmodSync(open, 0o700);
  });
  it("refuses an ancestor owned by another non-root user", { skip: process.getuid?.() === 0 }, () => {
    const root = tmp();
    assert.throws(() => assertSafeAncestors(join(root, "x"), process.getuid!() + 1), /owned by uid/);
    assert.doesNotThrow(() => assertSafeAncestors(join(root, "x")));
  });
  it("startup checks the state, audit, allow-list, and wallet paths", () => {
    const open = tmp();
    chmodSync(open, 0o777);
    const audit = tempConfig({ auditDir: join(open, "audits") });
    assert.throws(() => startupChecks(audit), /not sticky/);
    const allow = tempConfig();
    const moved = join(open, "allow.json");
    writeFileSync(moved, readFileSync(allow.allowlistPath));
    chmodSync(moved, 0o600);
    assert.throws(() => startupChecks({ ...allow, allowlistPath: moved }), /not sticky/);
    const w = join(open, "wallet");
    mkdirSync(w, { mode: 0o700 });
    assert.throws(() => startupChecks(tempConfig({ chainMode: "live", chainNetwork: "testnet", zingoDataDir: w })), /not sticky/);
    chmodSync(open, 0o700);
  });
});

describe("F-24, F-31: the wallet path is pinned", posix, () => {
  const runner = (calls: string[][], onCall?: () => void): CliRunner =>
    withUfvk(async (_bin, args, opts) => {
      calls.push(opts?.input === undefined ? args : [...args, opts.input]);
      onCall?.();
      return JSON.stringify({ txids: [TXID] });
    });
  const pair = () => {
    const root = tmp();
    const a = join(root, "a");
    const b = join(root, "b");
    mkdirSync(a, { mode: 0o700 });
    mkdirSync(b, { mode: 0o700 });
    const link = join(root, "wallet");
    symlinkSync(a, link);
    return { root, a, b, link };
  };

  it("passes zingo-cli the real path, not the symlink", async () => {
    const { a, link } = pair();
    const calls: string[][] = [];
    const chain = new LiveChainAdapter({ network: "testnet", dataDir: link, runner: runner(calls), stateDir: tmp() });
    await chain.pay({ amountZats: 100_000n, recipient: UTEST });
    assert.ok(calls.length > 0);
    for (const args of calls) assert.equal(args[args.indexOf("--data-dir") + 1], realpathSync(a));
  });
  it("refuses a send when the path now leads to another directory, and starts nothing", async () => {
    const { b, link } = pair();
    const calls: string[][] = [];
    const chain = new LiveChainAdapter({ network: "testnet", dataDir: link, runner: runner(calls), stateDir: tmp() });
    rmSync(link);
    symlinkSync(b, link);
    await assert.rejects(chain.pay({ amountZats: 100_000n, recipient: UTEST }), /no longer resolves to the directory pinned/);
    assert.equal(calls.length, 0);
  });
  it("refuses a send when the directory was replaced by a new one at the same path", async () => {
    const root = tmp();
    const dir = join(root, "w");
    mkdirSync(dir, { mode: 0o700 });
    const calls: string[][] = [];
    const chain = new LiveChainAdapter({ network: "testnet", dataDir: dir, runner: runner(calls), stateDir: tmp() });
    renameSync(dir, join(root, "old"));
    mkdirSync(dir, { mode: 0o700 });
    await assert.rejects(chain.pay({ amountZats: 100_000n, recipient: UTEST }), /no longer resolves to the directory pinned/);
    assert.equal(calls.length, 0);
  });
  it("re-checks before the transmit step as well", async () => {
    const { b, link } = pair();
    const calls: string[][] = [];
    const chain = new LiveChainAdapter({
      network: "testnet",
      dataDir: link,
      runner: runner(calls, () => {
        if (calls.length === 1) {
          rmSync(link);
          symlinkSync(b, link);
        }
      }),
      stateDir: tmp(),
    });
    await assert.rejects(chain.pay({ amountZats: 100_000n, recipient: UTEST }), /no longer resolves to the directory pinned/);
    assert.equal(calls.length, 1, "only the build step ran; nothing was transmitted");
    assert.ok(!calls.some((c) => /transmit/.test(c.at(-1) ?? "")));
  });
  it("refuses a missing wallet directory in live mode", () => {
    const config = tempConfig({ chainMode: "live", chainNetwork: "testnet", zingoDataDir: join(tmp(), "nope") });
    assert.throws(() => startupChecks(config), /wallet directory does not exist/);
    assert.throws(() => new LiveChainAdapter({ network: "testnet", dataDir: join(tmp(), "nope") }), /does not exist/);
  });
  it("startup pins the wallet and returns no warnings for a clean setup", () => {
    const { link } = pair();
    const config = tempConfig({ chainMode: "live", chainNetwork: "testnet", zingoDataDir: link });
    assert.deepEqual(startupChecks(config), []);
  });
});
