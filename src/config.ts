import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { parseZecToZats } from "./policy/amount.js";
import { resolveWalletDir } from "./chain/live.js";
import { parseRateLimit, RATE_LIMIT_DEFAULT_PER_MIN } from "./policy/rate.js";
import type { Config, ChainMode } from "./types.js";

function envOr<T>(key: string, fallback: T, parse: (v: string) => T): T {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  return parse(v);
}

const KNOWN_MODES = ["mock", "live", "testnet"];

export function loadConfig(cwd = process.cwd()): Config {
  const yamlPath = resolve(cwd, "config/default.yaml");
  let fromFile: Partial<{
    spending_cap_zec: number | string;
    allowlist_path: string;
    chain_mode: string;
    audit_dir: string;
    view_key_fingerprint_salt: string;
    rate_limit_per_min: number | string;
  }> = {};

  if (existsSync(yamlPath)) {
    fromFile = parseYaml(readFileSync(yamlPath, "utf8")) ?? {};
  }

  const rawMode = envOr("CHAIN_MODE", fromFile.chain_mode ?? "mock", (v) => v).trim().toLowerCase();
  if (!KNOWN_MODES.includes(rawMode)) {
    throw new Error(
      `Unknown CHAIN_MODE "${rawMode}". Expected one of: ${KNOWN_MODES.join(", ")}. Mainnet is not supported.`
    );
  }
  const chainMode: ChainMode = rawMode === "mock" ? "mock" : "live";
  // Kept as given (env values stay strings) and validated as whole zatoshis, never rounded.
  const spendingCapZec = envOr<number | string>("SPENDING_CAP_ZEC", fromFile.spending_cap_zec ?? 0.1, (v) => v);
  try {
    parseZecToZats(spendingCapZec, "SPENDING_CAP_ZEC");
  } catch (e) {
    throw new Error(
      `SPENDING_CAP_ZEC must be a positive ZEC amount with at most 8 decimals, got "${spendingCapZec}". ${e instanceof Error ? e.message : ""}`.trim()
    );
  }

  return {
    spendingCapZec,
    allowlistPath: resolve(
      cwd,
      envOr("ALLOWLIST_PATH", fromFile.allowlist_path ?? "./allowlists/recipients.example.json", (v) => v)
    ),
    chainMode,
    auditDir: resolve(cwd, envOr("AUDIT_DIR", fromFile.audit_dir ?? "./audits", (v) => v)),
    viewKeyFingerprintSalt: envOr(
      "VIEW_KEY_FINGERPRINT_SALT",
      fromFile.view_key_fingerprint_salt ?? "dev-only-change-me",
      (v) => v
    ),
    chainNetwork: rawMode === "testnet" ? "testnet" : undefined,
    zingoBin: process.env.ZINGO_BIN,
    // Live mode needs an absolute wallet path; loading fails here rather than fall back to a relative one.
    zingoDataDir: chainMode === "live" ? resolveWalletDir(process.env.ZINGO_DATA_DIR) : process.env.ZINGO_DATA_DIR,
    lightwalletd: process.env.LIGHTWALLETD_URL,
    rateLimitPerMin: parseRateLimit(
      envOr<number | string>("RATE_LIMIT_PER_MIN", fromFile.rate_limit_per_min ?? RATE_LIMIT_DEFAULT_PER_MIN, (v) => v)
    ),
  };
}
