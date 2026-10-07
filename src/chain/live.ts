import type { ChainAdapter } from "./types.js";
import type { PaymentReceipt, PaymentRequest } from "../types.js";

/**
 * Stub for a future light-wallet / LWD adapter.
 * Not wired — calling pay() always throws.
 */
export class LiveChainAdapter implements ChainAdapter {
  readonly mode = "live" as const;

  async pay(_req: PaymentRequest): Promise<PaymentReceipt> {
    throw new Error(
      "Live chain adapter is not implemented yet. Set CHAIN_MODE=mock."
    );
  }
}
