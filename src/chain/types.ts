import type { PaymentReceipt, PaymentRequest, TxSummary, WalletBalance } from "../types.js";

export interface ChainAdapter {
  readonly mode: "mock" | "live";
  pay(req: PaymentRequest): Promise<PaymentReceipt>;
  /** Read-only. Never moves funds. */
  getBalance(): Promise<WalletBalance>;
  /** Read-only. The wallet's current unified address. */
  getReceiveAddress(): Promise<string>;
  /** Read-only. Up to `limit` recent transactions, newest first. */
  getHistory(limit: number): Promise<TxSummary[]>;
}
