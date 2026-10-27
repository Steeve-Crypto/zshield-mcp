#!/usr/bin/env node
// A stand-in zingo-cli for tests that run the server in separate processes. One shared
// FAKE_ZINGO_STATE folder plays the chain: sends.jsonl holds every quicksend, and
// `transactions` prints them back as confirmed sends in zingo-cli's format.
// FAKE_ZINGO_HOLD=<path>: `info` writes <path>.reached and waits for <path>.go, so a test
// can stall a process inside its pre-send health check.
// FAKE_ZINGO_SEND=hang: a quicksend is recorded, then the process never answers.
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
const HEIGHT = 1000;
const args = process.argv.slice(2);
const cmd = args.at(-1);
const out = (s) => process.stdout.write(s);

function sends() {
  if (!existsSync(sendsFile)) return [];
  return readFileSync(sendsFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

const utc = (ms) => new Date(ms).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");

function block(s) {
  return [
    "{",
    `    txid: ${s.txid}`,
    `    datetime: ${utc(s.at)}`,
    "    status: confirmed",
    `    blockheight: ${HEIGHT - 1}`,
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
    case "export_ufvk":
      return out(JSON.stringify({ ufvk: "uviewtest1" + "q".repeat(80), birthday: 1 }) + "\n");
    case "transactions":
      return out("Launching save task...\n\n" + sends().reverse().map(block).join("\n") + "\n");
    default:
      process.stderr.write(`fake zingo-cli: unknown command ${cmd}\n`);
      process.exit(1);
  }
}

function prompt() {
  out("Launching sync task...\nLaunching save task...\n");
  let asked = 0;
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const send = line.match(/^quicksend '(.*)'$/);
    if (send) {
      const [entry] = JSON.parse(send[1]);
      const n = sends().length;
      const txid = createHash("sha256").update(`${process.pid}:${n}:${Date.now()}:${line}`).digest("hex");
      appendFileSync(sendsFile, JSON.stringify({ txid, at: Date.now(), pid: process.pid, ...entry }) + "\n");
      if (process.env.FAKE_ZINGO_SEND === "hang") {
        setInterval(() => {}, 1000);
        return;
      }
      out(`{\n  "txids": [\n    "${txid}"\n  ]\n}\n`);
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
