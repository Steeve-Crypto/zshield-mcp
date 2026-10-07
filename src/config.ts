import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Config, ChainMode } from "./types.js";

function envOr<T>(key: string, fallback: T, parse: (v: string) => T): T {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  return parse(v);
}

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

  const chainMode = envOr(
    "CHAIN_MODE",
    (fromFile.chain_mode as ChainMode) ?? "mock",
    (v) => v as ChainMode
  );

  return {
    spendingCapZec: envOr(
      "SPENDING_CAP_ZEC",
      fromFile.spending_cap_zec ?? 0.1,
      (v) => Number(v)
    ),
    allowlistPath: resolve(
      cwd,
      envOr("ALLOWLIST_PATH", fromFile.allowlist_path ?? "./allowlists/recipients.example.json", (v) => v)
    ),
    chainMode: chainMode === "live" ? "live" : "mock",
    auditDir: resolve(cwd, envOr("AUDIT_DIR", fromFile.audit_dir ?? "./audits", (v) => v)),
    viewKeyFingerprintSalt: envOr(
      "VIEW_KEY_FINGERPRINT_SALT",
      fromFile.view_key_fingerprint_salt ?? "dev-only-change-me",
      (v) => v
    ),
  };
}
