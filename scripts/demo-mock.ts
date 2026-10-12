/**
 * Mock demo: no network, no real coins. One allowed payment, one blocked by
 * the spending cap, one blocked by the allow-list, then the audit log.
 */
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockChainAdapter } from "../src/chain/mock.ts";
import { executePay } from "../src/tools/pay.ts";
import type { Config } from "../src/types.ts";

const auditDir = mkdtempSync(join(tmpdir(), "zshield-demo-"));
const config: Config = {
  spendingCapZec: 0.1,
  allowlistPath: join(process.cwd(), "allowlists/recipients.example.json"),
  chainMode: "mock",
  auditDir,
  viewKeyFingerprintSalt: "demo-salt",
};
const deps = { config, chain: new MockChainAdapter() };
const merchant = "u1mockrecipientaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const short = (a: string) => a.slice(0, 16) + "…";

const calls = [
  { label: "0.05 ZEC to allow-listed merchant", input: { amount_zec: 0.05, recipient: merchant, memo: "coffee" } },
  { label: "0.5 ZEC to allow-listed merchant (over cap)", input: { amount_zec: 0.5, recipient: merchant } },
  { label: "0.01 ZEC to unknown address", input: { amount_zec: 0.01, recipient: "u1attackerzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz" } },
];

console.log(`zshield-mcp mock demo  (cap ${config.spendingCapZec} ZEC, mode ${config.chainMode})\n`);
for (const c of calls) {
  const r = await executePay(c.input, deps);
  const a = r.audit;
  const tag = r.ok ? "ALLOWED" : "BLOCKED";
  console.log(`> zcash_pay ${c.label}`);
  console.log(`  ${tag}  ${r.ok ? "txid " + a.mock_txid : a.error?.replace(a.recipient, short(a.recipient))}\n`);
}

console.log("Audit log:");
for (const f of readdirSync(auditDir)) {
  for (const line of readFileSync(join(auditDir, f), "utf8").trim().split("\n")) {
    const e = JSON.parse(line);
    console.log(`  ${e.ts.slice(11, 19)} ${e.status.padEnd(8)} ${String(e.amount_zec).padEnd(5)} ${short(e.recipient)} hit=${e.allowlist_hit} fp=${e.view_key_fingerprint}`);
  }
}
