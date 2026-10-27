import { z } from "zod";
import { runReadTool, type ReadDeps } from "./read.js";

export const receiveAddressInputSchema = z.object({});

/** Read-only: the wallet's current unified address. */
export async function executeReceiveAddress(deps: ReadDeps) {
  return runReadTool<string>(
    "zcash_receive_address",
    deps.config,
    () => deps.chain.getReceiveAddress(),
    (address) => ({ address, network: deps.config.chainMode === "live" ? "testnet" : "mock" })
  );
}
