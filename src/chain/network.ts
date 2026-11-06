/** Zcash address network checks. Live mode is testnet only. */

const TESTNET_PREFIXES = ["utest1", "ztestsapling1", "tm"];
const MAINNET_PREFIXES = ["u1", "zs1", "t1", "t3", "zc"];

export type AddressNetwork = "testnet" | "mainnet" | "unknown";

export function addressNetwork(addr: string): AddressNetwork {
  const a = addr.trim();
  if (TESTNET_PREFIXES.some((p) => a.startsWith(p))) return "testnet";
  if (MAINNET_PREFIXES.some((p) => a.startsWith(p))) return "mainnet";
  return "unknown";
}

export class NetworkError extends Error {
  /** "mainnet" when a mainnet address or network was refused */
  constructor(
    message: string,
    readonly reason: "mainnet" | "unknown" | "mode" = "unknown"
  ) {
    super(message);
    this.name = "NetworkError";
  }
}

export function assertTestnetAddress(addr: string): void {
  const net = addressNetwork(addr);
  if (net === "mainnet") {
    throw new NetworkError("Mainnet address rejected in testnet mode.", "mainnet");
  }
  if (net !== "testnet") {
    throw new NetworkError("Unrecognized address network.");
  }
}
