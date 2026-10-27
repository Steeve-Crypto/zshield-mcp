import type { PaymentReceipt, PaymentRequest, WalletBalance } from "../types.js";

export interface ChainAdapter {
  readonly mode: "mock" | "live";
  pay(req: PaymentRequest): Promise<PaymentReceipt>;
  /** Read-only. Never moves funds. */
  getBalance(): Promise<WalletBalance>;
}
