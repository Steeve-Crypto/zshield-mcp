#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
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
  const server = createServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `zshield-mcp listening (stdio) cap=${config.spendingCapZec} ZEC mode=${config.chainMode}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
