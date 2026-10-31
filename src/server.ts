import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MockChainAdapter } from "./chain/mock.js";
import { executePaymentStatus, paymentStatusInputSchema } from "./tools/status.js";
import { LiveChainAdapter } from "./chain/live.js";
import type { ChainAdapter } from "./chain/types.js";
import { loadConfig } from "./config.js";
import { executePay, payInputSchema } from "./tools/pay.js";
import { balanceInputSchema, executeBalance } from "./tools/balance.js";
import { executeReceiveAddress, receiveAddressInputSchema } from "./tools/address.js";
import { executeHistory, historyInputSchema, HISTORY_MAX_LIMIT } from "./tools/history.js";
import { describePolicy, POLICY_URI } from "./policy/describe.js";
import { RATE_LIMITED_MESSAGE, RateLimiter, RATE_LIMIT_DEFAULT_PER_MIN } from "./policy/rate.js";
import type { Config } from "./types.js";
import { homedir } from "node:os";
import { fallbackAuditPath } from "./audit/log.js";
import { redact, registerRedaction, registerServerUrl } from "./redact.js";
import { resolveStateDir, walletStateDir } from "./payments/store.js";

type ToolResult = { content: { type: "text"; text: string }[]; isError: boolean };

/** The response for a call refused by the rate limit. It repeats nothing from the call. */
export function rateLimitedResult(): ToolResult {
  const message = RATE_LIMITED_MESSAGE;
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ ok: false, status: "rejected", code: "RATE_LIMITED", message, error: message }, null, 2),
      },
    ],
    isError: true,
  };
}

export function createChain(config: Config): ChainAdapter {
  return config.chainMode === "live"
    ? new LiveChainAdapter({
        network: config.chainNetwork,
        zingoBin: config.zingoBin,
        dataDir: config.zingoDataDir,
        server: config.lightwalletd,
      })
    : new MockChainAdapter({ stateDir: config.zingoDataDir ? walletStateDir(config.zingoDataDir) : undefined });
}

/**
 * Register every local path and the server URL for redaction, so no response, log line,
 * or audit row shows them. Longer paths win, so the home folder only covers the rest.
 */
export function registerRedactions(config: Config, chain?: ChainAdapter): void {
  registerServerUrl(config.lightwalletd);
  registerRedaction(config.auditDir, "[audit dir]");
  registerRedaction(fallbackAuditPath(config.auditDir, config.auditFallbackPath), "[audit fallback]");
  registerRedaction(config.allowlistPath, "[allowlist]");
  registerRedaction(config.zingoDataDir, "[wallet dir]");
  if (chain) registerRedaction(resolveStateDir(config, chain), "[state dir]");
  const home = homedir();
  if (home && home !== "/" && home.length >= 4) registerRedaction(home, "~");
}

function redactResult(r: ToolResult): ToolResult {
  return { ...r, content: r.content.map((c) => ({ ...c, text: redact(c.text) })) };
}

export function createServer(config: Config = loadConfig(), chain: ChainAdapter = createChain(config)): McpServer {
  registerRedactions(config, chain);
  const limiter = new RateLimiter(
    config.rateLimitPerMin ?? RATE_LIMIT_DEFAULT_PER_MIN,
    config.auditDir,
    Date.now,
    undefined,
    config.auditFallbackPath
  );
  // Every tool call and resource read passes the rate limit first. A refused call never
  // reaches the tool. Every answer is redacted on the way out.
  const limited =
    <A extends unknown[]>(tool: string, fn: (...args: A) => Promise<ToolResult>) =>
    async (...args: A): Promise<ToolResult> =>
      redactResult(limiter.take(tool) ? await fn(...args) : rateLimitedResult());
  const server = new McpServer({
    name: "zshield-mcp",
    version: "0.1.0",
  });

  server.tool(
    "zcash_pay",
    "Pay shielded ZEC to an allow-listed recipient under a hard per-call spending cap. Mock chain by default; writes a viewing-key-fingerprinted audit log entry.",
    payInputSchema.shape,
    limited("zcash_pay", async (args: Record<string, unknown>) => {
      const parsed = payInputSchema.parse(args);
      const result = await executePay(parsed, { config, chain });
      return {
        content: [{ type: "text" as const, text: result.text }],
        isError: !result.ok,
      };
    })
  );

  server.tool(
    "zcash_balance",
    "Read-only. Returns the wallet's confirmed and spendable balance in zatoshis and as a ZEC string. Never moves funds. Writes an audit row.",
    balanceInputSchema.shape,
    limited("zcash_balance", async () => {
      const result = await executeBalance({ config, chain });
      return {
        content: [{ type: "text" as const, text: result.text }],
        isError: !result.ok,
      };
    })
  );

  server.tool(
    "zcash_receive_address",
    "Read-only. Returns the wallet's current unified address so others can pay it. Never moves funds. Writes an audit row.",
    receiveAddressInputSchema.shape,
    limited("zcash_receive_address", async () => {
      const result = await executeReceiveAddress({ config, chain });
      return {
        content: [{ type: "text" as const, text: result.text }],
        isError: !result.ok,
      };
    })
  );

  server.tool(
    "zcash_history",
    `Read-only. Returns recent wallet transactions, newest first. Optional limit from 1 to ${HISTORY_MAX_LIMIT}, default 10. Never moves funds. Writes an audit row.`,
    historyInputSchema.shape,
    limited("zcash_history", async (args: Record<string, unknown>) => {
      const result = await executeHistory(historyInputSchema.parse(args), { config, chain });
      return {
        content: [{ type: "text" as const, text: result.text }],
        isError: !result.ok,
      };
    })
  );

  server.tool(
    "zcash_payment_status",
    "Read-only. Where a zcash_pay call stands, by call_id, operation_id or idempotency_key: pending, broadcast, mined (with height and confirmations), expired, failed, or unknown. Never sends. Writes an audit row.",
    paymentStatusInputSchema.shape,
    limited("zcash_payment_status", async (args: Record<string, unknown>) => {
      const result = await executePaymentStatus(paymentStatusInputSchema.parse(args), { config, chain });
      return {
        content: [{ type: "text" as const, text: result.text }],
        isError: !result.ok,
      };
    })
  );

  server.resource("policy", POLICY_URI, { mimeType: "application/json" }, async () => ({
    contents: [
      {
        uri: POLICY_URI,
        mimeType: "application/json",
        text: redact(
          limiter.take("policy_resource") ? JSON.stringify(describePolicy(config), null, 2) : rateLimitedResult().content[0].text
        ),
      },
    ],
  }));

  return server;
}
