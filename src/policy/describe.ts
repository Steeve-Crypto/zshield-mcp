import { loadAllowlist } from "./allowlist.js";
import { formatZats, MAX_DECIMALS, parseZecToZats } from "./amount.js";
import { RATE_LIMIT_DEFAULT_PER_MIN } from "./rate.js";
import type { Config } from "../types.js";

export const POLICY_URI = "zshield://policy";
export const PAYMENT_TOOLS = ["zcash_pay"] as const;
export const READ_ONLY_TOOLS = ["zcash_balance", "zcash_receive_address", "zcash_history", "zcash_payment_status"] as const;

/**
 * Snapshot of the active policy for the zshield://policy resource.
 * Read fresh on every request, so the allow-list size matches the file the next
 * zcash_pay call will check (the read is cached by file size and mtime). Never includes
 * the fingerprint salt, any key, or a local path.
 */
export function describePolicy(config: Config) {
  let cap: { zats: string; zec: string } | null = null;
  let capError: string | undefined;
  try {
    const zats = parseZecToZats(config.spendingCapZec, "Spending cap");
    cap = { zats: zats.toString(), zec: formatZats(zats) };
  } catch (e) {
    capError = e instanceof Error ? e.message : String(e);
  }

  let allowlistSize: number | null = null;
  let allowlistError: string | undefined;
  try {
    allowlistSize = new Set(loadAllowlist(config.allowlistPath).map((r) => r.address)).size;
  } catch (e) {
    allowlistError = e instanceof Error ? e.message : String(e);
  }

  const live = config.chainMode === "live";
  return {
    mode: live ? "testnet" : "mock",
    chain_adapter: live ? "zingo-cli" : "mock",
    mainnet: "refused",
    limits: {
      per_call_cap_zec: cap?.zec ?? null,
      per_call_cap_zats: cap?.zats ?? null,
      cap_error: capError,
      daily_or_rolling_cap: "none",
      amount_unit: "integer zatoshis, 1 ZEC = 100000000",
      max_decimals: MAX_DECIMALS,
      tool_calls_per_min: config.rateLimitPerMin ?? RATE_LIMIT_DEFAULT_PER_MIN,
    },
    allowlist: {
      size: allowlistSize,
      error: allowlistError,
      match: "exact address string",
      on_failure: allowlistError ? "every zcash_pay call is rejected until the file is fixed" : undefined,
    },
    audit: {
      every_call_audited: true,
      pending_row_before_send: true,
      rate_limited_calls: "not audited one by one; counted in one summary row per minute",
    },
    tools: {
      payment: [...PAYMENT_TOOLS],
      read_only: [...READ_ONLY_TOOLS],
    },
  };
}
