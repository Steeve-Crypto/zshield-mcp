import { z } from "zod";
import { storeFor } from "../payments/store.js";
import { runReadTool, withWalletRead, type ReadDeps } from "./read.js";

export const receiveAddressInputSchema = z.object({});

/** Read-only: the wallet's current unified address. */
export async function executeReceiveAddress(deps: ReadDeps) {
  return runReadTool<string>(
    "zcash_receive_address",
    deps.config,
    () => withWalletRead(storeFor(deps.config, deps.chain), "zcash_receive_address", () => deps.chain.getReceiveAddress({ offline: false })),
    (address) => ({ address, network: deps.config.chainMode === "live" ? "testnet" : "mock" })
  );
}
