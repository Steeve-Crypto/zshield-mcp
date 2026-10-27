import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/types.ts";

export const ALLOWED = "u1mockrecipientaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

export function tempConfig(overrides: Partial<Config> = {}): Config {
  const root = mkdtempSync(join(tmpdir(), "zshield-test-"));
  const allowPath = join(root, "allow.json");
  writeFileSync(allowPath, JSON.stringify({ recipients: [{ address: ALLOWED, label: "Demo" }] }));
  return {
    spendingCapZec: 0.1,
    allowlistPath: allowPath,
    chainMode: "mock",
    auditDir: join(root, "audits"),
    viewKeyFingerprintSalt: "test-salt",
    ...overrides,
  };
}

/** Every audit row in the config's audit dir, oldest first. */
export function readAuditRows(config: Config): Record<string, unknown>[] {
  return readdirSync(config.auditDir)
    .sort()
    .flatMap((f) => readFileSync(join(config.auditDir, f), "utf8").trim().split("\n"))
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}
