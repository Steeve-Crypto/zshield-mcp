import fs from "node:fs";
import { join } from "node:path";
import { createExclusive, readPrivate } from "../fsafe.js";

/** A wallet directory cannot be repurposed across chains by changing configuration. */
export function bindWalletNetwork(directory: string, network: "mainnet" | "testnet"): () => void {
  const filename = ".zshield-network";
  const file = join(directory, filename);
  const expected = `${network}\n`;
  if (readPrivate(file, 32) === undefined) {
    const calls = join(directory, ".zshield-state", "calls");
    if (network === "mainnet" && fs.existsSync(calls) && fs.readdirSync(calls).length) {
      throw new Error("Unbound historical wallet state cannot be adopted as mainnet.");
    }
    createExclusive(directory, filename, expected);
  }
  const check = () => {
    if (readPrivate(file, 32) !== expected) throw new Error("Wallet network binding differs from configuration or is missing.");
  };
  check();
  return check;
}
