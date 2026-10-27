import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultRunner, LiveChainAdapter, parseTxid, type CliRunner } from "../src/chain/live.ts";
import { CliTimeoutError, SendOutcomeUnknownError } from "../src/chain/outcome.ts";
import type { ChainAdapter } from "../src/chain/types.ts";
import { PAY_UNKNOWN_CODES } from "../src/errors.ts";
import { executePay, findPossibleSends } from "../src/tools/pay.ts";
import type { Config, TxSummary } from "../src/types.ts";
import { readAuditRows, tempConfig, TEST_UFVK, withUfvk } from "./helpers.ts";

const UTEST = "utest1" + "q".repeat(100);
const TXID = "cd".repeat(32);
const OTHER = "ef".repeat(32);

function liveConfig(): Config {
  const config = tempConfig({ chainMode: "live", chainNetwork: "testnet", spendingCapZec: "0.01" });
  writeFileSync(config.allowlistPath, JSON.stringify({ recipients: [{ address: UTEST }] }));
  return config;
}

/** A fake zingo-cli `transactions` block, with one outgoing note for a sent one. */
function txBlock(txid: string, kind: string, value: number, datetime?: string, recipient = UTEST, memo = "m"): string {
  const note =
    kind === "sent"
      ? ["    outgoing ironwood notes: ", "\t{", `            value: ${value}`, `            memo: ${memo}`, `            recipient: ${recipient}`, "            output index: 0", "        }"]
      : [];
  return [
    "{",
    `    txid: ${txid}`,
    datetime ? `    datetime: ${datetime}` : "",
    "    status: transmitted",
    `    kind: ${kind}`,
    `    value: ${value}`,
    ...note,
    "}",
  ]
    .filter(Boolean)
    .join("\n");
}

function utcNow(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

/** Live adapter whose send fails with `sendError` and whose history prints `history`. */
function chainWith(sendError: Error, history: string | Error, calls: string[][] = []) {
  const runner: CliRunner = async (_bin, args) => {
    calls.push(args);
    if (args.at(-1) === "transactions") {
      if (history instanceof Error) throw history;
      return history;
    }
    throw sendError;
  };
  return new LiveChainAdapter({ network: "testnet", runner: withUfvk(runner) });
}

describe("send timeout", () => {
  it("defaultRunner reports a killed CLI as a timeout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zshield-slow-"));
    const bin = join(dir, "slow-cli");
    writeFileSync(bin, "#!/bin/sh\nsleep 5\n");
    chmodSync(bin, 0o700);
    await assert.rejects(defaultRunner(bin, [], { timeoutMs: 100 }), CliTimeoutError);
  });

  it("defaultRunner keeps a plain failure as an ordinary error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zshield-fail-"));
    const bin = join(dir, "fail-cli");
    writeFileSync(bin, "#!/bin/sh\necho boom >&2\nexit 3\n");
    chmodSync(bin, 0o700);
    await assert.rejects(defaultRunner(bin, []), (e: unknown) => !(e instanceof CliTimeoutError) && /boom/.test(String(e)));
  });

  it("the live adapter turns a timed out send into SendOutcomeUnknownError", async () => {
    const chain = chainWith(new CliTimeoutError("stopped"), "");
    await assert.rejects(chain.pay({ amountZats: 100_000n, recipient: UTEST }), SendOutcomeUnknownError);
  });

  it("output with neither a txid nor an error is unknown, not a failure", () => {
    assert.throws(() => parseTxid("Syncing...\n"), SendOutcomeUnknownError);
    assert.throws(() => parseTxid("Error: insufficient balance"), (e: unknown) => !(e instanceof SendOutcomeUnknownError));
  });
});

describe("SEND_UNCONFIRMED", () => {
  it("is its own code with status unknown", () => {
    assert.deepEqual([...PAY_UNKNOWN_CODES], ["SEND_UNCONFIRMED", "PAYMENT_PENDING"]);
  });

  it("returns guidance, writes an unknown row, and lists a matching recent send", async () => {
    const config = liveConfig();
    const history = [
      txBlock(TXID, "sent", 100_000),
      txBlock(OTHER, "sent", 200_000),
      txBlock("aa".repeat(32), "received", 100_000, utcNow()),
      txBlock("bb".repeat(32), "sent", 100_000, utcNow(-2 * 60 * 60_000)),
    ].join("\n");
    const r = await executePay(
      { amount_zec: "0.001", recipient: UTEST, memo: "m" },
      { config, chain: chainWith(new CliTimeoutError("stopped after 900000 ms"), history) }
    );
    assert.equal(r.ok, false);
    assert.equal(r.code, "SEND_UNCONFIRMED");
    const body = JSON.parse(r.text);
    assert.equal(body.status, "unknown");
    assert.equal(body.code, "SEND_UNCONFIRMED");
    assert.match(body.message, /may have been broadcast/);
    assert.match(body.message, /zcash_history/);
    assert.deepEqual(body.possible_txids, [TXID]);
    assert.equal(body.possible_sends[0].confidence, "medium");
    const rows = readAuditRows(config);
    assert.deepEqual(rows.map((x) => x.status), ["pending", "unknown"]);
    assert.equal(rows[1].code, "SEND_UNCONFIRMED");
    assert.deepEqual(rows[1].possible_txids, [TXID]);
    assert.equal(rows[0].call_id, rows[1].call_id);
  });

  it("still reports SEND_UNCONFIRMED when the history lookup fails", async () => {
    const config = liveConfig();
    const r = await executePay(
      { amount_zec: "0.001", recipient: UTEST },
      { config, chain: chainWith(new CliTimeoutError("stopped"), new Error("offline")) }
    );
    const body = JSON.parse(r.text);
    assert.equal(body.code, "SEND_UNCONFIRMED");
    assert.deepEqual(body.possible_txids, []);
  });

  it("a plain CLI error stays CHAIN_ERROR and skips the history lookup", async () => {
    const config = liveConfig();
    const calls: string[][] = [];
    const r = await executePay(
      { amount_zec: "0.001", recipient: UTEST },
      { config, chain: chainWith(new Error("zingo-cli failed: insufficient funds"), "", calls) }
    );
    assert.equal(r.code, "CHAIN_ERROR");
    assert.equal(JSON.parse(r.text).status, "error");
    assert.equal(calls.some((a) => a.at(-1) === "transactions"), false);
    assert.equal(readAuditRows(config)[1].possible_txids, undefined);
  });
});

describe("findPossibleSends", () => {
  const note = { recipient: UTEST, valueZats: 5n, memo: "" };
  const tx = (over: Partial<TxSummary>): TxSummary => ({
    txid: TXID,
    status: "transmitted",
    kind: "sent",
    valueZats: 5n,
    outgoing: [note],
    ...over,
  });
  const chainOf = (txs: TxSummary[]) => ({ async getHistory() { return txs; }, async getViewingKey() { return TEST_UFVK; } }) as unknown as ChainAdapter;

  it("matches recent sends to the same recipient and amount, and skips failed ones", async () => {
    const now = Date.now();
    const found = await findPossibleSends(
      chainOf([
        tx({ txid: "1".repeat(64) }),
        tx({ txid: "2".repeat(64), time: new Date(now).toISOString() }),
        tx({ txid: "3".repeat(64), time: new Date(now - 3 * 60 * 60_000).toISOString() }),
        tx({ txid: "4".repeat(64), valueZats: 6n, outgoing: [{ ...note, valueZats: 6n }] }),
        tx({ txid: "5".repeat(64), kind: "received", outgoing: undefined }),
        tx({ txid: "6".repeat(64), status: "failed" }),
      ]),
      { amountZats: 5n, recipient: UTEST },
      now
    );
    assert.deepEqual(
      found.map((f) => [f.txid, f.confidence]),
      [
        ["1".repeat(64), "low"],
        ["2".repeat(64), "medium"],
      ]
    );
  });
});
