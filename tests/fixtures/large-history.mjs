#!/usr/bin/env node
import { once } from "node:events";
const args = process.argv.slice(2),
  tx = "ab".repeat(32),
  other = "cd".repeat(32);
async function emit(text) {
  if (!process.stdout.write(text)) await once(process.stdout, "drain");
}
const note = JSON.stringify({
  txid: other,
  status: "confirmed at block height 10",
  spend_status: "unspent",
  value: 1,
  memo: "x".repeat(80),
});
const block = `{\n    txid: ${other}\n    status: confirmed\n    blockheight: 10\n    kind: received\n    value: 1\n}\n`;
await emit("offline startup banner\n");
if (args.includes("notes")) {
  await emit('{"orchard_notes":{"note_summaries":[');
  for (let i = 0; i < 100; i++) await emit((note + ",").repeat(1000));
  await emit(
    JSON.stringify({ txid: tx, status: "confirmed at block height 1100", spend_status: "unspent", value: 10000 }) +
      "]}}\n",
  );
} else if (args.includes("coins")) await emit("{}\n");
else if (args.includes("messages")) await emit('{"value_transfers":[]}\n');
else if (args.includes("transactions")) {
  for (let i = 0; i < 120; i++) await emit(block.repeat(1000));
  await emit(`{\n    txid: ${tx}\n    status: confirmed\n    blockheight: 1100\n    kind: sent\n    value: 10000\n}\n`);
} else {
  process.exitCode = 1;
}
