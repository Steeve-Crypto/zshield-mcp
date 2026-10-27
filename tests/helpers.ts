import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.ts";
import type { CliRunner } from "../src/chain/live.ts";
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

/** A connected in-memory MCP client for a fresh server. */
export async function connect(config: Config = tempConfig()) {
  const server = createServer(config);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientT);
  return { client, config };
}

export function textOf(res: unknown): string {
  const content = (res as { content: { type: string; text: string }[] }).content;
  return content[0].text;
}

/** A fake testnet UFVK for tests. Not a real key. */
export const TEST_UFVK = "uviewtest1" + "q".repeat(80);

/** Wraps a fake CLI runner so `export_ufvk` answers with TEST_UFVK and is not passed on. */
export function withUfvk(runner: CliRunner): CliRunner {
  return async (bin, args, opts) =>
    args.includes("export_ufvk") ? JSON.stringify({ ufvk: TEST_UFVK, birthday: 1 }) : runner(bin, args, opts);
}
