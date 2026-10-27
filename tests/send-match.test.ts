import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { writeFileSync } from "node:fs";
import { LiveChainAdapter, parseTransactions, type CliRunner } from "../src/chain/live.ts";
import { CliTimeoutError } from "../src/chain/outcome.ts";
import type { ChainAdapter } from "../src/chain/types.ts";
import * as pay from "../src/tools/pay.ts";
import { tempConfig, TEST_UFVK, withUfvk } from "./helpers.ts";

const RECIPIENT = "utest1tkzp6v69yg97zyv8c908xvkmell8p97vmgs7dq30v3cxghsjxkaslg2ff90slfscscf9gs8mftg2ucf5raa36w4zehug0feluukfahv0";
const OTHER = "utest1" + "z".repeat(100);
const TX = "59d9cb1b5a473a84602c4812a7809217f6e9d359174deb178e7fd52c151ae8fc";
const UNRELATED = "ab".repeat(32);

/** Real zingo-cli `transactions` layout: notes nested one level deeper, the outer brace with a tab. */
function sentBlock(txid: string, recipient: string, memo: string, datetime: string, value = 100000): string {
  return `{
    txid: ${txid}
    datetime: ${datetime}
    status: transmitted
    blockheight: 4493939
    kind: sent
    value: ${value}
    fee: 10000
    zec price: not available
    pools sent from: Ironwood
    outgoing ironwood notes: 
\t{
            value: ${value}
            memo: ${memo}
            recipient: ${recipient}
            output index: 0
        }
}`;
}

function utc(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

const chainOf = (out: string) =>
  ({
    async getHistory() {
      return parseTransactions(out);
    },
    async getViewingKey() {
      return TEST_UFVK;
    },
  }) as unknown as ChainAdapter;

type Finder = (chain: ChainAdapter, target: unknown, startedAt: number) => Promise<unknown[]>;
const find = pay.findPossibleSends as unknown as Finder;
const txids = (found: unknown[]) => found.map((f) => (typeof f === "string" ? f : (f as { txid: string }).txid));

describe("send matching (V12 F-8)", () => {
  it("reads recipient and memo from the nested outgoing notes", () => {
    const [tx] = parseTransactions(sentBlock(TX, RECIPIENT, "zshield-mcp testnet demo", "2026-10-13 00:51:59 UTC"));
    const outgoing = (tx as unknown as { outgoing?: { recipient: string; memo: string; valueZats: bigint }[] }).outgoing;
    assert.deepEqual(outgoing, [{ recipient: RECIPIENT, memo: "zshield-mcp testnet demo", valueZats: 100000n }]);
  });

  it("never attaches a send of the same amount to another recipient", async () => {
    const now = Date.now();
    const out = sentBlock(UNRELATED, OTHER, "rent", utc(now));
    const found = await find(chainOf(out), { amountZats: 100000n, recipient: RECIPIENT, memo: "zshield-mcp testnet demo" }, now);
    assert.deepEqual(txids(found), []);
  });

  it("never attaches a send with a different memo when a memo was given", async () => {
    const now = Date.now();
    const out = sentBlock(UNRELATED, RECIPIENT, "something else", utc(now));
    const found = await find(chainOf(out), { amountZats: 100000n, recipient: RECIPIENT, memo: "zshield-mcp testnet demo" }, now);
    assert.deepEqual(txids(found), []);
  });

  it("matches recipient, amount and memo with high confidence", async () => {
    const now = Date.now();
    const out = [sentBlock(TX, RECIPIENT, "zshield-mcp testnet demo", utc(now)), sentBlock(UNRELATED, OTHER, "x", utc(now))].join("\n");
    const found = (await find(chainOf(out), { amountZats: 100000n, recipient: RECIPIENT, memo: "zshield-mcp testnet demo" }, now)) as {
      txid: string;
      confidence: string;
      matched: string[];
    }[];
    assert.equal(found.length, 1);
    assert.equal(found[0].txid, TX);
    assert.equal(found[0].confidence, "high");
    assert.deepEqual(found[0].matched, ["recipient", "amount", "memo", "time"]);
  });

  it("does not match a send older than the window", async () => {
    const now = Date.now();
    const out = sentBlock(TX, RECIPIENT, "m", utc(now - 2 * 60 * 60_000));
    assert.deepEqual(txids(await find(chainOf(out), { amountZats: 100000n, recipient: RECIPIENT, memo: "m" }, now)), []);
  });

  it("an unknown send does not list an unrelated payment of the same amount", async () => {
    const config = tempConfig({ chainMode: "live", chainNetwork: "testnet", spendingCapZec: "0.01" });
    writeFileSync(config.allowlistPath, JSON.stringify({ recipients: [{ address: RECIPIENT }] }));
    const history = [sentBlock(UNRELATED, OTHER, "rent", utc(Date.now())), sentBlock("cd".repeat(32), RECIPIENT, "other memo", utc(Date.now()))].join("\n");
    const runner: CliRunner = async (_bin, args) => {
      if (args.at(-1) === "transactions") return history;
      throw new CliTimeoutError("stopped after 900000 ms");
    };
    const chain = new LiveChainAdapter({ network: "testnet", runner: withUfvk(runner) });
    const r = await pay.executePay({ idempotency_key: "t-send-match-1", amount_zec: "0.001", recipient: RECIPIENT, memo: "zshield-mcp testnet demo" }, { config, chain });
    const body = JSON.parse(r.text);
    assert.equal(body.code, "SEND_UNCONFIRMED");
    assert.deepEqual(body.possible_txids, []);
  });
});
