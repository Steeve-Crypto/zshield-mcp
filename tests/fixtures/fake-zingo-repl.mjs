#!/usr/bin/env node
// Stands in for zingo-cli's interactive prompt in sync tests. Answers `sync status` with
// status blocks taken from real zingo-cli output in fixtures/zingo, and `quit` like it.
// FAKE_SYNC_MODE: complete (done on the second status), never (never done), hang (also
// ignores quit). FAKE_SYNC_LOG: file that gets argv and every line received.
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const mode = process.env.FAKE_SYNC_MODE ?? "complete";
const log = (s) => process.env.FAKE_SYNC_LOG && appendFileSync(process.env.FAKE_SYNC_LOG, s + "\n");
const read = (n) => readFileSync(new URL(`./zingo/${n}`, import.meta.url), "utf8");
const blocks = (t) => [...t.matchAll(/\{\s*"scan_ranges"[\s\S]*?"total_outputs"\s*:\s*\d+\s*\}/g)].map((m) => m[0]);
const done = blocks(read("repl-sync-complete.txt"));
const cut = blocks(read("repl-sync-cut-short.txt"));
log(`argv ${JSON.stringify(process.argv.slice(2))}`);
process.stdout.write("Launching sync task...\nLaunching save task...\n");
let asked = 0;
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  log(`line ${line}`);
  if (line === "sync status") {
    asked++;
    const block = mode === "complete" && asked >= 2 ? done[2] : asked === 1 ? done[0] : cut[1];
    process.stdout.write(`(test) Block:0 [Syncing] >> ${block}\n`);
  } else if (line === "quit") {
    if (mode === "hang") return;
    process.stdout.write("Save task shutdown successfully.\nZingo CLI quit successfully.\n");
    process.exit(0);
  }
});
if (mode === "hang") setInterval(() => {}, 1000);
rl.on("close", () => {
  if (mode !== "hang") process.exit(0);
});
