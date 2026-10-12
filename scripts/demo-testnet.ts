/**
 * Testnet demo: one real shielded send through the zcash_pay policy path.
 * Sender wallet: ~/.zshield-testnet/wallet (must be funded from a testnet faucet).
 * Recipient wallet: ~/.zshield-testnet/recipient (fresh, created on first run).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { LiveChainAdapter, TESTNET_EXPLORER } from "../src/chain/live.ts";
import { executePay } from "../src/tools/pay.ts";
import type { Config } from "../src/types.ts";

const base = join(homedir(), ".zshield-testnet");
const amount = Number(process.env.DEMO_AMOUNT_ZEC ?? "0.001");
const bin = process.env.ZINGO_BIN ?? "zingo-cli";
const server = process.env.LIGHTWALLETD_URL ?? "https://testnet.zec.rocks:443";

async function main() {
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const recipientWallet = new LiveChainAdapter({ network: "testnet", zingoBin: bin, server, dataDir: join(base, "recipient") });
  const addrOut = await recipientWallet.run(["addresses"]);
  const recipient = addrOut.match(/utest1[0-9a-z]+/)?.[0];
  if (!recipient) throw new Error(`No utest address found in: ${addrOut.slice(0, 300)}`);

  const allowPath = join(base, "demo-allowlist.json");
  writeFileSync(allowPath, JSON.stringify({ recipients: [{ address: recipient, label: "demo recipient" }] }, null, 2));

  const config: Config = {
    spendingCapZec: 0.01,
    allowlistPath: allowPath,
    chainMode: "live",
    chainNetwork: "testnet",
    auditDir: join(base, "audits"),
    viewKeyFingerprintSalt: "testnet-demo",
  };
  const chain = new LiveChainAdapter({ network: "testnet", zingoBin: bin, server, dataDir: join(base, "wallet") });

  console.log(`Sending ${amount} TAZ to ${recipient.slice(0, 24)}... (cap ${config.spendingCapZec})`);
  const res = await executePay({ amount_zec: amount, recipient, memo: "zshield-mcp testnet demo" }, { config, chain });
  if (!res.ok) {
    console.error(res.text);
    process.exit(1);
  }
  const txid = res.audit.mock_txid!;
  console.log(`txid: ${txid}`);
  console.log(`explorer: ${TESTNET_EXPLORER}${txid}`);
  console.log(`audit: ${config.auditDir}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
