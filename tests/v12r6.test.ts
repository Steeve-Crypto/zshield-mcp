import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { buildStageInput, LiveChainAdapter, parseTransactions, type CliRunner } from "../src/chain/live.ts";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultRunner } from "../src/chain/live.ts";
import { WalletBusyError } from "../src/chain/walletlock.ts";
import { defaultSyncer } from "../src/chain/sync.ts";

import { MockChainAdapter } from "../src/chain/mock.ts";
import { memoProblem } from "../src/policy/limits.ts";
import { paymentParamsHash, resetPaymentStores, storeFor } from "../src/payments/store.ts";
import { executePay, matchSend } from "../src/tools/pay.ts";
import { ALLOWED, tempConfig } from "./helpers.ts";
import type { TxSummary } from "../src/types.ts";

// Regression tests for V12 claims found still true at f96891d (run 6). Each uses entry
// points that exist on both sides, so the file can run against f96891d to show it fails.

const R = "utest1" + "r".repeat(100);
const T0 = Date.parse("2026-10-26T12:00:00Z");
const tx = (n: number) => n.toString(16).padStart(64, "0");

beforeEach(() => resetPaymentStores());

describe("memo: exact, validated, one form everywhere", () => {
  it("a memo with edge whitespace is refused, not trimmed", async () => {
    for (const memo of [" hi", "hi ", "hi\u00a0", "\u3000hi", "hi\u2003"]) {
      const config = tempConfig();
      const r = await executePay({ amount_zec: 0.001, recipient: ALLOWED, memo }, { config, chain: new MockChainAdapter() });
      assert.equal(r.code, "INVALID_MEMO", JSON.stringify(memo));
    }
    assert.equal(memoProblem("hi there"), undefined);
  });

  it("an unpaired surrogate is refused", async () => {
    const config = tempConfig();
    const r = await executePay({ amount_zec: 0.001, recipient: ALLOWED, memo: "a\ud800b" }, { config, chain: new MockChainAdapter() });
    assert.equal(r.code, "INVALID_MEMO");
  });

  it("the send line carries the memo exactly, and the adapter refuses one that is not matchable", async () => {
    const line = buildStageInput({ amountZats: 10000n, recipient: R, memo: "pay it" });
    assert.match(line, /"memo":"pay it"/);
    assert.doesNotMatch(buildStageInput({ amountZats: 10000n, recipient: R, memo: "" }), /memo/);
    let ran = 0;
    const a = new LiveChainAdapter({ network: "testnet", dataDir: "/w", runner: async () => { ran++; return ""; } });
    await assert.rejects(a.pay({ amountZats: 10000n, recipient: R, memo: "pay it " }), /Memo refused/);
    assert.equal(ran, 0);
  });

  it("an empty memo is no memo: same key hash, same audit row", async () => {
    assert.equal(paymentParamsHash({ amount_zec: "0.001", recipient: R, memo: "" }), paymentParamsHash({ amount_zec: "0.001", recipient: R }));
    const config = tempConfig();
    const r = await executePay({ amount_zec: 0.001, recipient: ALLOWED, memo: "" }, { config, chain: new MockChainAdapter() });
    assert.equal(r.ok, true);
    assert.equal(r.audit.memo, undefined);
  });

  it("matching compares memos exactly, with no trimming", () => {
    const t = (memo: string): TxSummary =>
      ({ txid: tx(1), time: new Date(T0 + 5000).toISOString(), status: "confirmed", blockHeight: 950, kind: "sent", valueZats: 10000n, outgoing: [{ recipient: R, valueZats: 10000n, memo }] }) as TxSummary;
    const target = { amountZats: 10000n, recipient: R, memo: "a b" };
    assert.ok(matchSend(t("a b"), target, T0));
    assert.equal(matchSend(t("a b "), target, T0), undefined);
    assert.equal(matchSend(t(" a b"), target, T0), undefined);
    assert.equal(matchSend(t("a  b"), target, T0), undefined);
  });

  it("the listing parser keeps inner spacing and reads a memo back as it was sent", () => {
    const [t] = parseTransactions(`{
    txid: ${tx(3)}
    datetime: 2026-10-26 12:00:05 UTC
    status: confirmed
    blockheight: 950
    kind: sent
    value: 10000
    outgoing orchard notes: 
\t{
            value: 10000
            memo: a  b
            recipient: ${R}
            output index: 0
        }
}`);
    assert.equal(t.outgoing?.[0].memo, "a  b");
  });
});

// ---- the OS wallet lock ----


const TSX = import.meta.resolve("tsx");
const WRAP_DRIVER = fileURLToPath(new URL("./fixtures/wrap-driver.mts", import.meta.url));

/** A stand-in wallet process: records that it started, holds for HOLD ms, checks nobody overlaps, records the end. */
function holdBin(dir: string, holdMs: number): string {
  const bin = join(dir, "hold.mjs");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
import * as fs from "node:fs";
const d = ${JSON.stringify(dir)};
fs.appendFileSync(d + "/events.log", "start " + process.pid + "\\n");
try { fs.writeFileSync(d + "/running", String(process.pid), { flag: "wx" }); } catch { fs.appendFileSync(d + "/events.log", "OVERLAP " + process.pid + "\\n"); }
setTimeout(() => { try { fs.unlinkSync(d + "/running"); } catch {} fs.appendFileSync(d + "/events.log", "end " + process.pid + "\\n"); console.log("done"); }, ${holdMs});
`
  );
  chmodSync(bin, 0o700);
  return bin;
}

function wrapProc(bin: string, lockFile: string, waitMs: number, deadlineOffset?: number) {
  const child = spawn(process.execPath, ["--import", TSX, WRAP_DRIVER, bin, lockFile, String(waitMs), ...(deadlineOffset ? [String(deadlineOffset)] : [])], {
    env: { PATH: process.env.PATH ?? "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout!.on("data", (d) => (out += d));
  const result = new Promise<{ event: string; kind?: string; message?: string; out?: string }>((resolve) =>
    child.on("close", () => resolve(JSON.parse(out.trim().split("\n").filter(Boolean).at(-1) ?? "{}")))
  );
  return { child, result };
}

const eventsOf = (dir: string) => (existsSync(join(dir, "events.log")) ? readFileSync(join(dir, "events.log"), "utf8").trim().split("\n") : []);
const until = async (f: () => boolean, ms = 8000) => {
  const t = Date.now();
  while (!f()) {
    if (Date.now() - t > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe("OS wallet lock: the wallet process itself is excluded", () => {
  it("three processes each run a wallet process through the lock, and no two ever overlap", async () => {
    const d = mkdtempSync(join(tmpdir(), "zshield-wrap-"));
    const bin = holdBin(d, 400);
    const lockFile = join(d, "state", "zingo.flock");
    const procs = [0, 1, 2].map(() => wrapProc(bin, lockFile, 20_000));
    const results = await Promise.all(procs.map((p) => p.result));
    assert.deepEqual(results.map((r) => r.event), ["ran", "ran", "ran"]);
    const ev = eventsOf(d);
    assert.equal(ev.filter((l) => l.startsWith("start")).length, 3);
    assert.equal(ev.filter((l) => l.startsWith("OVERLAP")).length, 0, ev.join("\n"));
  });

  it("a wallet process left running by a killed parent still holds the lock, so a new one is not started beside it", async () => {
    const d = mkdtempSync(join(tmpdir(), "zshield-orphan-"));
    const bin = holdBin(d, 2500);
    const lockFile = join(d, "state", "zingo.flock");
    const old = wrapProc(bin, lockFile, 5000);
    await until(() => eventsOf(d).some((l) => l.startsWith("start")));
    // The old holder's server process dies (or freezes); its wallet process lives on.
    old.child.kill("SIGKILL");
    const second = await wrapProc(bin, lockFile, 300).result;
    assert.equal(second.event, "failed");
    assert.equal(second.kind, "busy");
    assert.equal(eventsOf(d).filter((l) => l.startsWith("start")).length, 1, "the second wallet process never started");
    // Once the old wallet process ends, the lock is free again.
    await until(() => eventsOf(d).some((l) => l.startsWith("end")));
    const third = await wrapProc(bin, lockFile, 3000).result;
    assert.equal(third.event, "ran");
    assert.equal(eventsOf(d).filter((l) => l.startsWith("OVERLAP")).length, 0);
  });

  it("a send that waited past its start deadline is not started, even though the lock came free", async () => {
    const d = mkdtempSync(join(tmpdir(), "zshield-late-"));
    const bin = holdBin(d, 900);
    const lockFile = join(d, "state", "zingo.flock");
    const holder = wrapProc(bin, lockFile, 5000);
    await until(() => eventsOf(d).some((l) => l.startsWith("start")));
    const late = await wrapProc(bin, lockFile, 10_000, 300).result;
    assert.equal(late.event, "failed");
    assert.equal(late.kind, "late");
    await holder.result;
    assert.equal(eventsOf(d).filter((l) => l.startsWith("start")).length, 1);
  });

  it("only the wrapper's own nonce line counts as a refusal: a wallet process cannot fake one", async () => {
    const d = mkdtempSync(join(tmpdir(), "zshield-fake-"));
    const bin = join(d, "liar.mjs");
    writeFileSync(bin, `#!/usr/bin/env node\nconsole.error("ZSHIELD-WRAP 000000000000000000000000 busy");\nprocess.exit(75);\n`);
    chmodSync(bin, 0o700);
    await assert.rejects(
      defaultRunner(bin, [], { lockFile: join(d, "s", "zingo.flock"), lockWaitMs: 1000, timeoutMs: 10_000 }),
      (e: Error) => !(e instanceof WalletBusyError) && /zingo-cli failed/.test(e.message)
    );
  });

  it("without perl the run is refused and nothing starts", async () => {
    const d = mkdtempSync(join(tmpdir(), "zshield-noperl-"));
    const bin = holdBin(d, 10);
    const saved = process.env.PATH;
    process.env.PATH = join(d, "empty");
    try {
      await assert.rejects(defaultRunner(bin, [], { lockFile: join(d, "s", "zingo.flock"), timeoutMs: 5000 }), (e: Error) => e instanceof WalletBusyError && (e as WalletBusyError).kind === "unavailable");
    } finally {
      process.env.PATH = saved;
    }
    assert.deepEqual(eventsOf(d), []);
  });

  it("an error from a wrapped run never carries the wrapper's command line", async () => {
    const d = mkdtempSync(join(tmpdir(), "zshield-leak-"));
    const bin = join(d, "fail.mjs");
    writeFileSync(bin, `#!/usr/bin/env node\nprocess.exit(3);\n`);
    chmodSync(bin, 0o700);
    await assert.rejects(defaultRunner(bin, [], { lockFile: join(d, "s", "zingo.flock"), timeoutMs: 10_000 }), (e: Error) => !/perl|ZSHIELD|use strict|zingo\.flock/.test(e.message));
    const hold = holdBin(d, 3000);
    const holder = wrapProc(hold, join(d, "s", "zingo.flock"), 5000);
    await until(() => eventsOf(d).some((l) => l.startsWith("start")));
    await assert.rejects(defaultRunner(bin, [], { lockFile: join(d, "s", "zingo.flock"), lockWaitMs: 5000, timeoutMs: 2000 }), (e: Error) => !/perl|use strict|zingo\.flock/.test(e.message) && e instanceof WalletBusyError);
    holder.child.kill("SIGKILL");
  });

  it("the sync runs under the same lock", async () => {
    const d = mkdtempSync(join(tmpdir(), "zshield-sync-"));
    const bin = holdBin(d, 1500);
    const lockFile = join(d, "state", "zingo.flock");
    const holder = wrapProc(bin, lockFile, 5000);
    await until(() => eventsOf(d).some((l) => l.startsWith("start")));
    const r = await defaultSyncer(bin, [], { timeoutMs: 400, lockFile });
    assert.equal(r.complete, false);
    assert.match(r.detail ?? "", /Another zingo-cli process is using this wallet|did not finish/);
    assert.equal(eventsOf(d).filter((l) => l.startsWith("start")).length, 1);
    await holder.result;
  });

  it("the live adapter starts every wallet process under the lock, and a send gets a wait and a start deadline", async () => {
    const seen: { args: string[]; opts?: import("../src/chain/live.ts").RunOptions }[] = [];
    const d = mkdtempSync(join(tmpdir(), "zshield-ad-"));
    const runner: CliRunner = async (_b, args, opts) => {
      seen.push({ args, opts });
      if (args.at(-1) === "info") return '{"latest_block_height": 1000}';
      if (args.at(-1) === "height") return '{"height": 1000}';
      if (args.at(-1) === "spendable_balance") return '{"spendable_balance": 5}';
      return `{ "fee": 10000 }\n{ "txids": ["${tx(5)}"] }`;
    };
    const a = new LiveChainAdapter({ network: "testnet", runner, dataDir: d, stateDir: join(d, ".zshield-state") });
    await a.checkHealth({ sync: false });
    await a.pay({ amountZats: 1000n, recipient: R });
    assert.ok(seen.length >= 4);
    for (const s of seen) assert.equal(s.opts?.lockFile, join(d, ".zshield-state", "zingo.flock"));
    // The build step and the transmit step both wait for the lock and have a start deadline.
    assert.ok(seen.at(-2)!.opts!.input?.startsWith("send '"));
    assert.ok(seen.at(-1)!.opts!.input?.startsWith("transmit "));
    for (const send of [seen.at(-2)!.opts!, seen.at(-1)!.opts!])
    assert.ok((send.lockWaitMs ?? 0) > 0 && (send.lockWaitMs ?? 0) <= 60_000);
    for (const send of [seen.at(-2)!.opts!, seen.at(-1)!.opts!])
      assert.ok((send.lockDeadlineMs ?? 0) > Date.now() - 1000 && (send.lockDeadlineMs ?? 0) <= Date.now() + 120_000);
  });

  it("a wallet held by another process is a BUSY refusal: not sent, nothing recorded as sent", async () => {
    const config = liveCfg();
    const { chain, counts } = liveChain({
      pay: () => {
        throw new WalletBusyError("Another zingo-cli process is using this wallet. Nothing was started. Try again shortly.", "busy");
      },
    });
    const r = await executePay({ amount_zec: "0.0001", recipient: R, idempotency_key: "k-busy" }, { config, chain });
    assert.equal(counts.sent, 0);
    assert.equal(r.code, "BUSY");
    assert.equal(storeFor(config, chain).readCall(JSON.parse(r.text).call_id)?.state, "not_sent");
  });
});

function liveCfg() {
  const config = tempConfig({ chainMode: "live", chainNetwork: "testnet" });
  writeFileSync(config.allowlistPath, JSON.stringify({ recipients: [{ address: R }] }));
  return config;
}

type Req = import("../src/types.ts").PaymentRequest;

function liveChain(hooks: { pay?: (req: Req) => void }) {
  const counts = { sent: 0 };
  const chain = {
    mode: "live",
    async getViewingKey() { return "uviewtest1" + "q".repeat(80); },
    async checkHealth() { return { walletHeight: 1000, chainTip: 1000, spendableZats: 10_000_000n }; },
    async pay(req: Req) {
      hooks.pay?.(req);
      counts.sent++;
      return { txid: tx(77), amountZats: req.amountZats, recipient: req.recipient, mode: "live" };
    },
    async getBalance() { throw new Error("unused"); },
    async getReceiveAddress() { throw new Error("unused"); },
    async getHistory() { return []; },
  } as unknown as import("../src/chain/types.ts").ChainAdapter;
  return { chain, counts };
}
