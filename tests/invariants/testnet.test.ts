// Invariant I13 (real Zingo on Zcash TESTNET). Skipped unless ZSHIELD_TESTNET_INVARIANTS=1.
//
// Needs, all from the environment:
//   ZSHIELD_TESTNET_ZINGO_BIN  the zingo-cli built at the pinned commit
//   ZSHIELD_TESTNET_WALLET     absolute path of a SCRATCH COPY of a funded testnet wallet directory
//   ZSHIELD_TESTNET_SERVER     optional, default https://testnet.zec.rocks:443
// Every command is run with `--chain testnet`. The recipient is always the wallet's own first
// unified address, and the amount is 10000 zatoshis (0.0001 ZEC). It never uses mainnet.
// The tests observe zingo-cli and assert only what ZShield's design already assumes; every
// observation is printed as a `# I13 ...` line so a run documents the real behavior.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildStageInput, parseStaged, transmitted } from "../../src/chain/live.ts";

const ON = process.env.ZSHIELD_TESTNET_INVARIANTS === "1";
const BIN = process.env.ZSHIELD_TESTNET_ZINGO_BIN ?? "";
const WALLET = process.env.ZSHIELD_TESTNET_WALLET ?? "";
const SERVER = process.env.ZSHIELD_TESTNET_SERVER ?? "https://testnet.zec.rocks:443";
const AMOUNT = 10_000n;
const note = (s: string) => process.stdout.write(`# I13 ${s.replace(/\n/g, "\n# ")}\n`);

interface Run {
  out: string;
  err: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  ms: number;
}

/** One zingo-cli process on the scratch wallet. `input` is fed on stdin; `until` can stop it early. */
function zingo(args: string[], input: string | undefined, opts: { timeoutMs?: number; killWhen?: RegExp; killSignal?: NodeJS.Signals } = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const child = spawn(BIN, ["--chain", "testnet", "--server", SERVER, "--data-dir", WALLET, ...args], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`zingo-cli ${args.join(" ")} timed out after ${opts.timeoutMs ?? 600_000} ms. stdout so far: ${out.slice(-400)}`));
    }, opts.timeoutMs ?? 600_000);
    child.stdout.on("data", (d) => {
      out += d;
      if (opts.killWhen && opts.killWhen.test(out)) child.kill(opts.killSignal ?? "SIGKILL");
    });
    child.stderr.on("data", (d) => (err += d));
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ out, err, code, signal, ms: Date.now() - t0 });
    });
    if (input !== undefined) child.stdin.write(input);
    // Without `quit` in the input, leave stdin open so the session stays interactive.
    if (input === undefined || /\nquit\n?$/.test(input)) child.stdin.end();
  });
}

const walletMtime = () => statSync(join(WALLET, "zingo-wallet.dat")).mtimeMs;

async function ownAddress(): Promise<string> {
  const r = await zingo(["--nosync", "addresses"], undefined);
  const m = r.out.match(/utest1[0-9a-z]{50,}/);
  assert.ok(m, `no testnet unified address in the wallet's address list: ${r.out.slice(0, 200)}`);
  return m[0];
}

async function stage(recipient: string, memo?: string): Promise<{ txid: string; run: Run }> {
  const run = await zingo([], buildStageInput({ amountZats: AMOUNT, recipient, memo }));
  return { txid: parseStaged(run.out), run };
}

describe("I13 real zingo on testnet", { skip: ON ? false : "set ZSHIELD_TESTNET_INVARIANTS=1 (needs a funded testnet wallet copy, see the file header)", timeout: 1_800_000 }, () => {
  it("I13 preconditions: testnet only, funded wallet, own address", async () => {
    assert.ok(BIN && WALLET.startsWith("/"), "ZSHIELD_TESTNET_ZINGO_BIN and an absolute ZSHIELD_TESTNET_WALLET are required");
    const bal = await zingo(["--waitsync"], "balance\nspendable_balance\nquit\n");
    note(`balance output:\n${bal.out.trim()}`);
    const spendable = bal.out.match(/"spendable_balance"\s*:\s*(\d+)/);
    assert.ok(spendable && BigInt(spendable[1]) > 3n * AMOUNT + 100_000n, `wallet needs more testnet funds: ${bal.out.slice(-300)}`);
  });

  it("I13 persisted_stage: the stage process exits with a Calculated tx a fresh process can transmit by txid", async () => {
    const to = await ownAddress();
    const before = walletMtime();
    const { txid, run } = await stage(to);
    note(`stage exit ${run.code}, ${run.ms} ms, txid ${txid}, wallet file ${walletMtime() > before ? "was rewritten" : "was NOT rewritten"} by the stage process`);
    // Fresh process: does it know the txid, and can it transmit it?
    const tx = await zingo([], `transmit ${txid}\nquit\n`);
    note(`fresh-process transmit (${tx.ms} ms):\n${tx.out.trim()}\n${tx.err.trim()}`);
    assert.ok(transmitted(tx.out, txid), `a fresh process could not transmit the staged txid: ${tx.out.slice(0, 300)} ${tx.err.slice(0, 300)}`);
    // A second transmit of the same txid.
    const again = await zingo([], `transmit ${txid}\nquit\n`);
    note(`second transmit of the same txid (${again.ms} ms):\n${again.out.trim()}\n${again.err.trim()}`);
  });

  it("I13 stage_killed_before_save: a process killed right after calculate printed the txid", async () => {
    const to = await ownAddress();
    const line = buildStageInput({ amountZats: AMOUNT, recipient: to }).replace(/\nquit\n$/, "\n");
    const killed = await zingo([], line, { killWhen: /"txids"\s*:\s*\[\s*"[0-9a-f]{64}"/ });
    const txid = killed.out.match(/"txids"\s*:\s*\[\s*"([0-9a-f]{64})"/)?.[1];
    note(`killed after calculate: signal ${killed.signal}, txid printed: ${txid ?? "none"}`);
    assert.ok(txid, `calculate never printed a txid: ${killed.out.slice(-300)}`);
    const tx = await zingo([], `transmit ${txid}\nquit\n`);
    note(`transmit from a fresh process after the kill:\n${tx.out.trim()}\n${tx.err.trim()}`);
  });

  it("I13 note_reservation: a second stage while the first is still Calculated", async () => {
    const to = await ownAddress();
    const a = await stage(to);
    const b = await stage(to).catch((e) => ({ txid: `ERROR ${(e as Error).message.slice(0, 160)}`, run: undefined }));
    note(`stage A ${a.txid}\nstage B ${b.txid}\n${a.txid === b.txid ? "same txid: B did not build a new transaction" : "different txids"}`);
    const ta = await zingo([], `transmit ${a.txid}\nquit\n`);
    note(`transmit A:\n${ta.out.trim()}`);
    if (/^[0-9a-f]{64}$/.test(b.txid)) {
      const tb = await zingo([], `transmit ${b.txid}\nquit\n`);
      note(`transmit B after A:\n${tb.out.trim()}\n${tb.err.trim()}`);
    }
  });

  it("I13 no_args_transmit_sends_all: `transmit` with no txid sends every Calculated tx", async () => {
    const to = await ownAddress();
    const a = await stage(to);
    const tx = await zingo([], "transmit\nquit\n");
    note(`bare transmit after staging ${a.txid}:\n${tx.out.trim()}`);
    assert.ok(tx.out.includes(a.txid), "a bare transmit should have sent the staged transaction");
  });

  it("I13 wallet_file_lock: two zingo-cli processes on one wallet directory", async () => {
    const slow = zingo([], undefined, { timeoutMs: 60_000, killWhen: /never matches/ }).catch((e) => e as Error);
    await new Promise((r) => setTimeout(r, 15_000));
    const second = await zingo(["--nosync"], "balance\nquit\n");
    note(`second process while the first is open: exit ${second.code}\n${second.out.trim().slice(0, 300)}\n${second.err.trim().slice(0, 300)}`);
    await slow;
  });

  it("I13 one_session_send_calculate_transmit: one process runs send, calculate and transmit", async () => {
    const to = await ownAddress();
    const lines = buildStageInput({ amountZats: AMOUNT, recipient: to }).split("\n").filter((l) => l && l !== "quit");
    const child = spawn(BIN, ["--chain", "testnet", "--server", SERVER, "--data-dir", WALLET], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", () => undefined);
    const waitFor = async (re: RegExp, what: string) => {
      const end = Date.now() + 300_000;
      while (!re.test(out)) {
        if (Date.now() > end) {
          child.kill("SIGKILL");
          throw new Error(`timed out waiting for ${what}; output so far: ${out.slice(-300)}`);
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    };
    for (const l of lines) child.stdin.write(l + "\n");
    await waitFor(/"txids"\s*:\s*\[\s*"[0-9a-f]{64}"/, "calculate to print a txid");
    const txid = out.match(/"txids"\s*:\s*\[\s*"([0-9a-f]{64})"/)![1];
    const mark = out.length;
    child.stdin.write(`transmit ${txid}\n`);
    await waitFor(new RegExp(txid), "transmit to answer").catch(() => undefined);
    await new Promise((r) => setTimeout(r, 20_000));
    child.stdin.write("quit\n");
    child.stdin.end();
    await new Promise((r) => child.on("exit", r));
    const after = out.slice(mark);
    note(`one session: txid ${txid}\ntransmit answer in the same session:\n${after.trim().slice(0, 600)}`);
    assert.ok(transmitted(out.slice(mark), txid), "the same session did not transmit the txid it just calculated");
  });
});
