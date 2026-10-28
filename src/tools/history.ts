import { z } from "zod";
import { storeFor } from "../payments/store.js";
import { TESTNET_EXPLORER } from "../chain/live.js";
import { formatZats } from "../policy/amount.js";
import type { TxSummary } from "../types.js";
import { ReadRejection, runReadTool, type ReadDeps } from "./read.js";

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
 * Read-only: recent wallet transactions, newest first. It never takes the payment lease: it reads the
 * wallet file offline, as last synced, under one overall deadline, and only one runs at a time.
 */
export async function executeHistory(input: HistoryInput, deps: ReadDeps) {
  const live = deps.config.chainMode === "live";
  return runReadTool<TxSummary[]>(
    "zcash_history",
    deps.config,
    async () => {
      const limit = checkLimit(input.limit);
      const wallet = storeFor(deps.config, deps.chain).dir;
      if (reading.has(wallet)) throw new ReadRejection("BUSY", "Another zcash_history call is still running. Try again shortly.");
      reading.add(wallet);
      try {
        return await deps.chain.getHistory(limit, { offline: true, verifiedOnly: true });
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
        // Who a send paid, so a caller can tell two sends of one amount apart.
        outgoing: t.outgoing?.map((n) => ({ recipient: n.recipient, value_zats: n.valueZats.toString(), memo: n.memo || undefined })),
        explorer_url: live ? `${TESTNET_EXPLORER}${t.txid}` : undefined,
      })),
    }),
    { limit: input.limit }
  );
}
