import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
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
    spending_cap_zec: number;
    allowlist_path: string;
    chain_mode: string;
    audit_dir: string;
    view_key_fingerprint_salt: string;
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
  const spendingCapZec = envOr("SPENDING_CAP_ZEC", fromFile.spending_cap_zec ?? 0.1, (v) => Number(v));
  if (!Number.isFinite(spendingCapZec) || spendingCapZec <= 0) {
    throw new Error(`SPENDING_CAP_ZEC must be a positive number, got "${spendingCapZec}".`);
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
    zingoDataDir: process.env.ZINGO_DATA_DIR,
    lightwalletd: process.env.LIGHTWALLETD_URL,
  };
}
