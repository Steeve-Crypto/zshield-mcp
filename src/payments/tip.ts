import type { ChainHealth } from "../types.js";

/**
 * How far a server's reported tip may sit below what this wallet already knows (its own
 * scanned height, or the highest tip it has seen) before the report is not believed. A
 * server a few blocks behind is normal. One far behind is stale, on another chain, or
 * lying, and an expiry anchored on its number could be proven too early.
 */
export const TIP_TOLERANCE_BLOCKS = 10;

/**
 * Why a health reading's chain tip cannot be trusted, or undefined. The tip must not be
 * below the wallet's own height, nor below the highest tip recorded for this wallet,
 * beyond the tolerance. A tip above both is always acceptable here; the lag limit
 * rejects one that is far ahead of the wallet.
 */
export function tipProblem(h: Pick<ChainHealth, "chainTip" | "walletHeight">, floor: number | undefined): string | undefined {
  if (h.chainTip < h.walletHeight - TIP_TOLERANCE_BLOCKS) {
    return `lightwalletd reports tip ${h.chainTip}, below the wallet's own height ${h.walletHeight}`;
  }
  if (floor !== undefined && h.chainTip < floor - TIP_TOLERANCE_BLOCKS) {
    return `lightwalletd reports tip ${h.chainTip}, below ${floor}, a tip it reported before`;
  }
  return undefined;
}

/** The height to anchor an expiry on: never below the reported tip, the wallet's height, or the recorded high mark. */
export function expiryAnchor(h: Pick<ChainHealth, "chainTip" | "walletHeight">, floor: number | undefined): number {
  return Math.max(h.chainTip, h.walletHeight, floor ?? 0);
}
