import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSendInput, defaultRunner, LiveChainAdapter, type CliRunner, type RunOptions } from "../src/chain/live.ts";
import { withUfvk } from "./helpers.ts";

const UTEST = "utest1" + "q".repeat(100);
const TXID = "ef".repeat(32);
const NASTY = [
  "plain memo",
  "it's got 'single' quotes",
  'and "double" quotes',
  "line one\nline two\r\nthree",
  "back\\slash and \\u0027 literal",
  "tabs\tand $(dollar) `ticks` ; | & > <",
  "unicode: zcash ⓩ 🛡️ café",
];

/** Undo zingo-cli's line handling: one POSIX single-quoted argument after the command name. */
function decodeSendLine(input: string): { command: string; json: unknown } {
  const [line, quit, rest] = input.split("\n");
  assert.equal(quit, "quit");
  assert.equal(rest, "");
  const m = line.match(/^(\w+) '([^']*)'$/);
  assert.ok(m, `not a single quoted line: ${line}`);
  return { command: m[1], json: JSON.parse(m[2]) };
}

describe("buildSendInput", () => {
  for (const memo of NASTY) {
    it(`round-trips ${JSON.stringify(memo)}`, () => {
      const input = buildSendInput({ amountZats: 123_456n, recipient: UTEST, memo });
      const { command, json } = decodeSendLine(input);
      assert.equal(command, "quicksend");
      assert.deepEqual(json, [{ address: UTEST, amount: 123456, memo }]);
    });
  }
  it("leaves memo out when there is none", () => {
    const { json } = decodeSendLine(buildSendInput({ amountZats: 1n, recipient: UTEST }));
    assert.deepEqual(json, [{ address: UTEST, amount: 1 }]);
  });
  it("keeps the 21M ZEC maximum exact", () => {
    const { json } = decodeSendLine(buildSendInput({ amountZats: 2_100_000_000_000_000n, recipient: UTEST }));
    assert.equal((json as { amount: number }[])[0].amount, 2_100_000_000_000_000);
  });
  it("refuses an amount it cannot encode exactly", () => {
    assert.throws(() => buildSendInput({ amountZats: 2n ** 60n, recipient: UTEST }), /too large/);
  });
});

describe("LiveChainAdapter.pay keeps payment details out of argv", () => {
  it("sends over stdin with only base options in argv", async () => {
    const calls: { args: string[]; opts?: RunOptions }[] = [];
    const runner: CliRunner = withUfvk(async (_b, args, opts) => {
      calls.push({ args, opts });
      return JSON.stringify({ txids: [TXID] });
    });
    const a = new LiveChainAdapter({ network: "testnet", runner, dataDir: "/w" });
    const r = await a.pay({ amountZats: 100_000n, recipient: UTEST, memo: "secret memo" });
    assert.equal(r.txid, TXID);
    assert.equal(calls.length, 1);
    const { args, opts } = calls[0];
    assert.deepEqual(args, ["--chain", "testnet", "--server", "https://testnet.zec.rocks:443", "--data-dir", "/w"]);
    const argv = args.join(" ");
    for (const s of ["secret", UTEST, "100000", "quicksend"]) assert.ok(!argv.includes(s), `${s} in argv`);
    assert.ok(opts?.input?.includes("secret memo"));
    assert.ok((opts?.timeoutMs ?? 0) >= 60_000);
  });

  it("reports an error the prompt prints to stderr", async () => {
    const runner: CliRunner = async () => "(test) >> \nError: Insufficient balance (have 0, need 110000 including fee)\n";
    const a = new LiveChainAdapter({ network: "testnet", runner });
    await assert.rejects(a.pay({ amountZats: 100_000n, recipient: UTEST }), /Insufficient balance/);
  });
});

describe("defaultRunner with input", () => {
  // A stand-in for zingo-cli: records argv and stdin, prints a txid on stdout and a note on stderr.
  function fakeCli(): { bin: string; record: string } {
    const dir = mkdtempSync(join(tmpdir(), "zshield-fakecli-"));
    const record = join(dir, "record.json");
    const bin = join(dir, "zingo-cli");
    writeFileSync(
      bin,
      `#!${process.execPath}
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  require("node:fs").writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), input }));
  console.log(JSON.stringify({ txids: ["${TXID}"] }));
  console.error("Save task shutdown successfully.");
});
`
    );
    chmodSync(bin, 0o700);
    return { bin, record };
  }

  it("writes the input to stdin, keeps argv clean, and appends stderr", async () => {
    const { bin, record } = fakeCli();
    const a = new LiveChainAdapter({ network: "testnet", zingoBin: bin, dataDir: "/tmp/none", runner: withUfvk(defaultRunner) });
    const memo = "it's private\nreally";
    const r = await a.pay({ amountZats: 5_000n, recipient: UTEST, memo });
    assert.equal(r.txid, TXID);
    const seen = JSON.parse(readFileSync(record, "utf8"));
    assert.ok(!seen.argv.join(" ").includes("private"));
    assert.ok(!seen.argv.includes(UTEST));
    const { json } = decodeSendLine(seen.input);
    assert.deepEqual(json, [{ address: UTEST, amount: 5000, memo }]);
    const out = await defaultRunner(bin, [], { input: "x\n", timeoutMs: 10_000 });
    assert.match(out, /Save task shutdown/);
  });
});
