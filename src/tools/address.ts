import { z } from "zod";
import { withWalletRead } from "../payments/lock.js";
import { runReadTool, type ReadDeps } from "./read.js";

export const receiveAddressInputSchema = z.object({});

/** Read-only: the wallet's current unified address. */
export async function executeReceiveAddress(deps: ReadDeps) {
  return runReadTool<string>(
    "zcash_receive_address",
    deps.config,
    () => withWalletRead(deps.chain, "zcash_receive_address", (offline) => deps.chain.getReceiveAddress({ offline })),
    (address) => ({ address, network: deps.config.chainMode === "live" ? "testnet" : "mock" })
  );
}
