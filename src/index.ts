#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

async function main() {
  const config = loadConfig();
  if (config.chainMode === "live") {
    console.error("zshield-mcp: CHAIN_MODE=live is stubbed; refusing to start. Use mock.");
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
