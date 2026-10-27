#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createChain, createServer, registerRedactions } from "./server.js";
import { redact } from "./redact.js";
import { recoverPendingPayments } from "./payments/recovery.js";
import { runStartup } from "./startup.js";

/** Every line this process prints goes through redaction. */
function log(message: string): void {
  console.error(redact(message));
}

async function main() {
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
    registerRedactions(config);
    for (const warning of runStartup(config)) log(warning);
  } catch (e) {
    log(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
  const chain = createChain(config);
  const server = createServer(config, chain);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`zshield-mcp listening (stdio) cap=${config.spendingCapZec} ZEC mode=${config.chainMode}`);
  // Sends interrupted by a crash or kill: reconcile against wallet history in the
  // background and write a recovery row for each. Never resends.
  void recoverPendingPayments(config, chain)
    .then((rows) => {
      for (const r of rows) log(`zshield-mcp recovery: call ${r.call_id} ${r.status}${r.txid ? ` ${r.txid}` : ""}`);
    })
    .catch((e: unknown) => log(`zshield-mcp recovery failed: ${e instanceof Error ? e.message : String(e)}`));
}

main().catch((err) => {
  log(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
