#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createChain, createServer } from "./server.js";
import { recoverPendingPayments } from "./payments/recovery.js";
import { restrictUmask, startupChecks } from "./startup.js";

async function main() {
  const config = loadConfig();
  try {
    for (const warning of startupChecks(config)) console.error(warning);
    restrictUmask(config);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
  const chain = createChain(config);
  const server = createServer(config, chain);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `zshield-mcp listening (stdio) cap=${config.spendingCapZec} ZEC mode=${config.chainMode}`
  );
  // Sends interrupted by a crash or kill: reconcile against wallet history in the
  // background and write a recovery row for each. Never resends.
  void recoverPendingPayments(config, chain).then((rows) => {
    for (const r of rows) console.error(`zshield-mcp recovery: call ${r.call_id} ${r.status}${r.txid ? ` ${r.txid}` : ""}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
