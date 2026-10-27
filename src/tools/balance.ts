import { z } from "zod";
import { formatZats } from "../policy/amount.js";
import type { WalletBalance } from "../types.js";
import { runReadTool, type ReadDeps } from "./read.js";

export const balanceInputSchema = z.object({});

/** Read-only: the wallet's confirmed and spendable balance. */
export async function executeBalance(deps: ReadDeps) {
  return runReadTool<WalletBalance>(
    "zcash_balance",
    deps.config,
    () => deps.chain.getBalance(),
    (b) => ({
      confirmed_zats: b.confirmedZats.toString(),
      confirmed_zec: formatZats(b.confirmedZats),
      spendable_zats: b.spendableZats.toString(),
      spendable_zec: formatZats(b.spendableZats),
      unconfirmed_zats: b.unconfirmedZats.toString(),
      unconfirmed_zec: formatZats(b.unconfirmedZats),
    })
  );
}
