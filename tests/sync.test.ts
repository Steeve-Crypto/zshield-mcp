import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { LiveChainAdapter, type CliRunner } from "../src/chain/live.ts";
import { defaultSyncer, parseSyncStatuses, syncComplete, type WalletSyncer } from "../src/chain/sync.ts";
import { preSendProblem } from "../src/tools/pay.ts";
import { withEnv } from "./helpers.ts";

const FIX = new URL("./fixtures/zingo/", import.meta.url);
const fixture = (n: string) => readFileSync(new URL(n, FIX), "utf8");
const FAKE = new URL("./fixtures/fake-zingo-repl.mjs", import.meta.url).pathname;
const ARGS = ["--chain", "testnet", "--server", "https://example.invalid:443", "--data-dir", "/w"];

describe("sync status parsing on real zingo-cli output", () => {
  it("is not done right after launch, and done once the session has scanned to the tip", () => {
    const s = parseSyncStatuses(fixture("repl-sync-complete.txt"));
    assert.equal(s.length, 4);
    // Launch: ranges look Scanned, but 0% and no session start height yet.
    assert.equal(syncComplete(s[0]), false);
    assert.equal(syncComplete(s[1]), false);
    assert.equal(syncComplete(s[2]), true);
    assert.equal(s[2].scannedHeight, 4547638);
  });

  it("a sync cut short never reads as done", () => {
    const s = parseSyncStatuses(fixture("repl-sync-cut-short.txt"));
    assert.equal(s.length, 2);
    assert.ok(s.every((x) => !syncComplete(x)));
  });
});

describe("bounded sync through the prompt", () => {
  const run = (mode: string, timeoutMs: number, quitGraceMs = 2000) => {
    const log = join(mkdtempSync(join(tmpdir(), "zshield-sync-")), "log");
    return withEnv("FAKE_SYNC_MODE", mode, () =>
      withEnv("FAKE_SYNC_LOG", log, async () => {
        const r = await defaultSyncer(FAKE, ARGS, { timeoutMs, pollMs: 50, quitGraceMs });
        return { r, lines: readFileSync(log, "utf8").trim().split("\n") };
      })
    );
  };

  it("quits as soon as the sync reports done", async () => {
    const { r, lines } = await run("complete", 10_000);
    assert.equal(r.complete, true);
    assert.equal(r.scannedHeight, 4547638);
    assert.ok(r.elapsedMs < 5000);
    assert.equal(lines.at(-1), "line quit");
    assert.deepEqual(JSON.parse(lines[0].slice(5)), ARGS);
  });

  it("stops at the timeout with quit, so the wallet is saved, and says so", async () => {
    const { r, lines } = await run("never", 300);
    assert.equal(r.complete, false);
    assert.match(r.detail!, /did not finish within 300 ms/);
    assert.ok(lines.includes("line quit"));
  });

  it("kills a prompt that ignores quit after the grace period", async () => {
    const t = Date.now();
    const { r } = await run("hang", 200, 300);
    assert.equal(r.complete, false);
    assert.ok(Date.now() - t < 5000);
  });

  it("reports a binary that cannot start without throwing", async () => {
    const r = await defaultSyncer("/nonexistent/zingo-cli", ARGS, { timeoutMs: 1000 });
    assert.equal(r.complete, false);
    assert.match(r.detail!, /could not start/);
  });
});

describe("funds check after a bounded sync, on real zingo-cli output", () => {
  // Real outputs: after a sync cut short the wallet read 0 spendable; after a full sync 12370000.
  const runner = (spendable: string): CliRunner => async (_b, args) => {
    const last = args.at(-1);
    if (last === "info") return fixture("info-nosync.txt");
    if (last === "height") return fixture("height-synced.txt");
    if (last === "spendable_balance") return fixture(spendable);
    throw new Error(`unexpected ${args.join(" ")}`);
  };
  const syncer = (complete: boolean, seen: number[] = []): WalletSyncer => async (_b, _a, o) => {
    seen.push(o.timeoutMs);
    return complete ? { complete, elapsedMs: 1 } : { complete, elapsedMs: o.timeoutMs, detail: `sync did not finish within ${o.timeoutMs} ms` };
  };
  const health = (spendable: string, complete: boolean, seen?: number[]) =>
    new LiveChainAdapter({ network: "testnet", dataDir: "/w", runner: runner(spendable), syncer: syncer(complete, seen) });

  it("an unfinished sync with spendable reading 0 is WALLET_NOT_SYNCED, not INSUFFICIENT_FUNDS", async () => {
    const c = health("spendable-after-cut-sync.txt", false);
    const p = await preSendProblem(() => c.checkHealth(), 10_000n, 10_000);
    assert.equal(p?.code, "WALLET_NOT_SYNCED");
    assert.match(p!.message, /sync did not finish/);
    assert.match(p!.message, /Nothing was sent/);
  });

  it("a finished sync with real funds passes", async () => {
    const c = health("spendable-synced.txt", true);
    assert.equal(await preSendProblem(() => c.checkHealth(), 10_000n, 10_000), undefined);
  });

  it("a finished sync that still reads too little is INSUFFICIENT_FUNDS", async () => {
    const c = health("spendable-after-cut-sync.txt", true);
    assert.equal((await preSendProblem(() => c.checkHealth(), 10_000n, 10_000))?.code, "INSUFFICIENT_FUNDS");
  });

  it("an unfinished sync that still shows enough funds does not block the send", async () => {
    const c = health("spendable-synced.txt", false);
    assert.equal(await preSendProblem(() => c.checkHealth(), 10_000n, 10_000), undefined);
  });

  it("uses HEALTH_SYNC_TIMEOUT_MS, and 0 skips the sync", async () => {
    const seen: number[] = [];
    await withEnv("HEALTH_SYNC_TIMEOUT_MS", "1234", () => health("spendable-synced.txt", true, seen).checkHealth());
    assert.deepEqual(seen, [1234]);
    const h = await withEnv("HEALTH_SYNC_TIMEOUT_MS", "0", () => health("spendable-synced.txt", true, seen).checkHealth());
    assert.deepEqual(seen, [1234]);
    assert.equal(h.synced, undefined);
  });
});
