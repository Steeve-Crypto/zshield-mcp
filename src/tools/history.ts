import { z } from "zod";
import { storeFor } from "../payments/store.js";
import { TESTNET_EXPLORER } from "../chain/live.js";
import { formatZats } from "../policy/amount.js";
import type { TxSummary } from "../types.js";
import { ReadRejection, runReadTool, withWalletRead, type ReadDeps } from "./read.js";

export const HISTORY_DEFAULT_LIMIT = 10;
export const HISTORY_MAX_LIMIT = 50;

export const historyInputSchema = z.object({
  // Kept loose here so a bad value reaches executeHistory and is audited as a rejection.
  limit: z
    .number()
    .optional()
    .describe(`How many recent transactions to return, 1 to ${HISTORY_MAX_LIMIT}. Default ${HISTORY_DEFAULT_LIMIT}.`),
});

export type HistoryInput = z.infer<typeof historyInputSchema>;

export function checkLimit(limit: unknown): number {
  if (limit === undefined) return HISTORY_DEFAULT_LIMIT;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > HISTORY_MAX_LIMIT) {
    throw new ReadRejection("INVALID_LIMIT", `limit must be a whole number from 1 to ${HISTORY_MAX_LIMIT}.`);
  }
  return limit;
}

/** Wallets with a history read running: one at a time, so reads cannot pile up. */
const reading = new Set<string>();

/**
 * Read-only: recent wallet transactions, newest first. It is BUSY while a send holds the wallet
 * lock. It reads the wallet file offline, as last synced, under one overall deadline, and only one runs at a time.
 */
export async function executeHistory(input: HistoryInput, deps: ReadDeps) {
  const live = deps.config.chainMode === "live";
  return runReadTool<TxSummary[]>(
    "zcash_history",
    deps.config,
    async () => {
      const limit = checkLimit(input.limit);
      const store = storeFor(deps.config, deps.chain);
      const wallet = store.dir;
      if (reading.has(wallet)) throw new ReadRejection("BUSY", "Another zcash_history call is still running. Try again shortly.");
      reading.add(wallet);
      try {
        // Refused while a send or sync holds the wallet lock: no read between stage and transmit.
        return await withWalletRead(store, "zcash_history", () => deps.chain.getHistory(limit, { offline: true, verifiedOnly: true }));
      } finally {
        reading.delete(wallet);
      }
    },
    (txs) => ({
      count: txs.length,
      transactions: txs.map((t) => ({
        txid: t.txid,
        time: t.time,
        status: t.status,
        block_height: t.blockHeight,
        target_height: t.targetHeight,
        kind: t.kind,
        value_zats: t.valueZats.toString(),
        value_zec: formatZats(t.valueZats),
        fee_zats: t.feeZats?.toString(),
        // No recipients or memos here. TxSummary.outgoing stays inside the server.
        explorer_url: live ? `${TESTNET_EXPLORER}${t.txid}` : undefined,
      })),
    }),
    { limit: input.limit }
  );
}
