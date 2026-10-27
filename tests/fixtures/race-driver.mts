// Runs one server operation in its own process, the way a second MCP server on the same
// wallet would. Config comes from the environment and the working directory, through the
// server's own loadConfig and createChain. Prints one JSON line.
// argv: pay <key> <amount> | recover | status <key>
import { loadConfig } from "../../src/config.ts";
import { createChain } from "../../src/server.ts";
import { executePay } from "../../src/tools/pay.ts";
import { paymentStatus } from "../../src/tools/status.ts";
import { recoverPendingPayments } from "../../src/payments/recovery.ts";

const [op, key, amount] = process.argv.slice(2);
const config = loadConfig();
const chain = createChain(config);
let result: unknown;
if (op === "pay") {
  const r = await executePay({ amount_zec: amount ?? "0.001", recipient: process.env.RACE_RECIPIENT!, idempotency_key: key }, { config, chain });
  result = { code: r.code, ...JSON.parse(r.text) };
} else if (op === "recover") {
  result = await recoverPendingPayments(config, chain);
} else if (op === "status") {
  try {
    result = await paymentStatus(config, chain, { idempotency_key: key });
  } catch (e) {
    result = { error: e instanceof Error ? e.message : String(e), code: (e as { code?: string }).code };
  }
}
process.stdout.write(JSON.stringify(result) + "\n");
process.exit(0);
