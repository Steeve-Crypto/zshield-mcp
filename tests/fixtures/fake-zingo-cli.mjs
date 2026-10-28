#!/usr/bin/env node
// A stand-in zingo-cli for tests that run the server in separate processes. One shared
// FAKE_ZINGO_STATE folder plays the chain: sends.jsonl holds every quicksend, and
// `transactions` prints them back as confirmed sends in zingo-cli's format.
// FAKE_ZINGO_HOLD=<path>: `info` writes <path>.reached and waits for <path>.go, so a test
// can stall a process inside its pre-send health check.
// A send is two steps like the real CLI: `send` + `calculate` builds a transaction (staged.jsonl,
// listed as "calculated", never broadcast) and `transmit <txid>` broadcasts it (sends.jsonl).
// FAKE_ZINGO_SEND=hang: a transmit is recorded, then the process never answers.
// FAKE_ZINGO_STAGE_EXIT=1: the process fails right after building, so nothing is transmitted.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const state = process.env.FAKE_ZINGO_STATE;
if (!state) {
  process.stderr.write("FAKE_ZINGO_STATE is not set\n");
  process.exit(2);
}
// Two live fakes at once would be two wallet processes on one wallet: say so in overlap.log.
{
  const running = join(state, "running");
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  if (existsSync(running)) {
    const other = Number(readFileSync(running, "utf8"));
    if (other && other !== process.pid && alive(other)) appendFileSync(join(state, "overlap.log"), `${process.pid} overlaps ${other}\n`);
  }
  writeFileSync(running, String(process.pid));
  process.on("exit", () => {
    try {
      if (readFileSync(running, "utf8") === String(process.pid)) unlinkSync(running);
    } catch {
      // gone
    }
  });
}
const sendsFile = join(state, "sends.jsonl");
const stagedFile = join(state, "staged.jsonl");
const HEIGHT = 1000;
const args = process.argv.slice(2);
const cmd = args.at(-1);
const out = (s) => process.stdout.write(s);

function readLines(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
const sends = () => readLines(sendsFile);
// A transmitted transaction is no longer merely calculated.
const staged = () => readLines(stagedFile).filter((x) => !sends().some((t) => t.txid === x.txid));
const pretty = (v) => JSON.stringify(v, null, 2) + "\n";

const utc = (ms) => new Date(ms).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");

function block(s) {
  const calculated = s.state === "calculated";
  return [
    "{",
    `    txid: ${s.txid}`,
    `    datetime: ${utc(s.at)}`,
    `    status: ${calculated ? "calculated" : "confirmed"}`,
    ...(calculated ? [] : [`    blockheight: ${HEIGHT - 1}`]),
    "    kind: sent",
    `    value: ${s.amount}`,
    "    fee: 10000",
    "    outgoing orchard notes: ",
    "\t{",
    `            value: ${s.amount}`,
    `            memo: ${s.memo ?? ""}`,
    `            recipient: ${s.address}`,
    "            output index: 0",
    "        }",
    "    outgoing sapling notes: ",
    "}",
  ].join("\n");
}

const done = [...readFileSync(new URL("./zingo/repl-sync-complete.txt", import.meta.url), "utf8").matchAll(
  /\{\s*"scan_ranges"[\s\S]*?"total_outputs"\s*:\s*\d+\s*\}/g
)].map((m) => m[0]);

async function hold() {
  const path = process.env.FAKE_ZINGO_HOLD;
  if (!path) return;
  writeFileSync(`${path}.reached`, String(process.pid));
  while (!existsSync(`${path}.go`)) await new Promise((r) => setTimeout(r, 25));
}

async function oneShot() {
  switch (cmd) {
    case "info":
      await hold();
      return out(`{\n  "chain_name": "test",\n  "latest_block_height": ${HEIGHT}\n}\n`);
    case "height":
      return out(`{\n  "height": ${HEIGHT}\n}\n`);
    case "spendable_balance":
      return out(`{\n  "spendable_balance": 100000000\n}\n`);
    case "balance":
      return out(readFileSync(new URL("./zingo/balance.txt", import.meta.url), "utf8"));
    case "addresses":
      return out(pretty([{ address_index: 0, encoded_address: "utest1" + "d".repeat(100), has_orchard: true }]));
    case "export_ufvk":
      return out(JSON.stringify({ ufvk: "uviewtest1" + "q".repeat(80), birthday: 1 }) + "\n");
    case "transactions":
      return out("Launching save task...\n\n" + [...staged().map((x) => ({ ...x, state: "calculated" })), ...sends()].sort((a, b) => b.at - a.at).map(block).join("\n") + "\n");
    case "all": {
      const all = [...staged().map((x) => ({ ...x, state: "calculated" })), ...sends()];
      if (args.at(-2) === "notes")
        return out(
          pretty({
            orchard_notes: {
              note_summaries: all.map((x) => ({
                txid: x.txid,
                status: x.state === "calculated" ? "calculated" : `confirmed at block height ${HEIGHT - 1}`,
                spend_status: "unspent",
                memo: null,
              })),
            },
          })
        );
      return out(pretty({ transparent_coins: [] }));
    }
    case "messages":
      return out(
        pretty({
          value_transfers: sends()
            .filter((x) => x.memo)
            .map((x) => ({ txid: x.txid, recipient_address: x.address, memos: [x.memo] })),
        })
      );
    default:
      process.stderr.write(`fake zingo-cli: unknown command ${cmd}\n`);
      process.exit(1);
  }
}

function prompt() {
  out("Launching sync task...\nLaunching save task...\n");
  let asked = 0;
  let pending;
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const send = line.match(/^send '(.*)'$/);
    const transmit = line.match(/^transmit ([0-9a-f]{64})$/);
    if (send) {
      pending = JSON.parse(send[1])[0];
    } else if (line === "calculate") {
      const n = staged().length + sends().length;
      const txid = createHash("sha256").update(`${process.pid}:${n}:${Date.now()}:${JSON.stringify(pending)}`).digest("hex");
      appendFileSync(stagedFile, JSON.stringify({ txid, at: Date.now(), pid: process.pid, ...pending }) + "\n");
      out(`{\n  "fee": 10000\n}\n{\n  "txids": [\n    "${txid}"\n  ]\n}\n`);
      if (process.env.FAKE_ZINGO_STAGE_EXIT === "1") process.exit(1);
    } else if (transmit) {
      const entry = staged().find((x) => x.txid === transmit[1]);
      if (!entry) return out(`{\n  "error": "no such calculated transaction"\n}\n`);
      appendFileSync(sendsFile, JSON.stringify({ ...entry, at: Date.now() }) + "\n");
      if (process.env.FAKE_ZINGO_SEND === "hang") {
        setInterval(() => {}, 1000);
        return;
      }
      out(`{\n  "txids": [\n    "${entry.txid}"\n  ]\n}\n`);
    } else if (line === "sync status") {
      asked++;
      out(`(test) Block:0 [Syncing] >> ${asked >= 2 ? done[2] : done[0]}\n`);
    } else if (line === "quit") {
      out("Save task shutdown successfully.\nZingo CLI quit successfully.\n");
      process.exit(0);
    }
  });
}

// The prompt starts when argv ends with the base options; a one-shot command comes last.
const base = args.at(-2) === "--data-dir" || cmd === "--waitsync";
if (base) prompt();
else await oneShot();
