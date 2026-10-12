import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MockChainAdapter } from "./chain/mock.js";
import { LiveChainAdapter } from "./chain/live.js";
import type { ChainAdapter } from "./chain/types.js";
import { loadConfig } from "./config.js";
import { executePay, payInputSchema } from "./tools/pay.js";
import type { Config } from "./types.js";

export function createChain(config: Config): ChainAdapter {
  return config.chainMode === "live"
    ? new LiveChainAdapter({
        network: config.chainNetwork,
        zingoBin: config.zingoBin,
        dataDir: config.zingoDataDir,
        server: config.lightwalletd,
      })
    : new MockChainAdapter();
}

export function createServer(config: Config = loadConfig()): McpServer {
  const chain = createChain(config);
  const server = new McpServer({
    name: "zshield-mcp",
    version: "0.1.0",
  });

  server.tool(
    "zcash_pay",
    "Pay shielded ZEC to an allow-listed recipient under a hard per-call spending cap. Mock chain by default; writes a viewing-key-fingerprinted audit log entry.",
    {
      amount_zec: payInputSchema.shape.amount_zec,
      recipient: payInputSchema.shape.recipient,
      memo: payInputSchema.shape.memo,
    },
    async (args) => {
      const parsed = payInputSchema.parse(args);
      const result = await executePay(parsed, { config, chain });
      return {
        content: [{ type: "text" as const, text: result.text }],
        isError: !result.ok,
      };
    }
  );

  server.resource(
    "policy",
    "zshield://policy",
    async () => ({
      contents: [
        {
          uri: "zshield://policy",
          mimeType: "application/json",
          text: JSON.stringify(
            {
              spending_cap_zec: config.spendingCapZec,
              allowlist_path: config.allowlistPath,
              chain_mode: config.chainMode,
              audit_dir: config.auditDir,
            },
            null,
            2
          ),
        },
      ],
    })
  );

  return server;
}

// Keep zod import used for type-side clarity in tool registration
void z;
