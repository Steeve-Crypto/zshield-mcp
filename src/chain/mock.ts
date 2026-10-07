import { createHash, randomBytes } from "node:crypto";
import type { ChainAdapter } from "./types.js";
import type { PaymentReceipt, PaymentRequest } from "../types.js";

/**
 * Mock shielded payment: no network, deterministic-looking txid + synthetic view-key material.
 */
export class MockChainAdapter implements ChainAdapter {
  readonly mode = "mock" as const;

  async pay(req: PaymentRequest): Promise<PaymentReceipt> {
    const nonce = randomBytes(16).toString("hex");
    const txid = createHash("sha256")
      .update(`mock|${req.recipient}|${req.amountZec}|${nonce}`)
      .digest("hex");

    // Synthetic viewing-key material — fingerprint only in audit; never a real key
    const viewKeyMaterial = `vk_mock_${createHash("sha256")
      .update(`${txid}|${req.recipient}`)
      .digest("hex")
      .slice(0, 32)}`;

    return {
      txid: `mock_${txid.slice(0, 32)}`,
      amountZec: req.amountZec,
      recipient: req.recipient,
      memo: req.memo,
      viewKeyMaterial,
      mode: "mock",
    };
  }
}
