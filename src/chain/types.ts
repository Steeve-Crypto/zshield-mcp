import type { PaymentReceipt, PaymentRequest } from "../types.js";

export interface ChainAdapter {
  readonly mode: "mock" | "live";
  pay(req: PaymentRequest): Promise<PaymentReceipt>;
}
