import { createHash, randomBytes } from "node:crypto";
import type { ChainAdapter } from "./types.js";
import type { PaymentReceipt, PaymentRequest, WalletBalance } from "../types.js";

/** Flat fee the mock charges per send, in zatoshis (matches the ZIP 317 minimum of 10,000). */
export const MOCK_FEE_ZATS = 10_000n;
/** Fixed, obviously fake unified address for the mock wallet. */
export const MOCK_RECEIVE_ADDRESS = "u1mockwallet" + "0".repeat(60);
/** Default starting balance of the mock wallet: 10 ZEC. */
export const MOCK_START_ZATS = 1_000_000_000n;

export interface MockTx {
  txid: string;
  kind: "received" | "sent";
  valueZats: bigint;
  feeZats: bigint;
  recipient?: string;
  memo?: string;
  datetime: string;
}

export interface MockOptions {
  startingBalanceZats?: bigint;
}

/**
 * Mock shielded wallet: no network. Keeps an in-memory ledger so balance and history
 * reflect the payments made through it. Starts with one funding receive.
 */
export class MockChainAdapter implements ChainAdapter {
  readonly mode = "mock" as const;
  private balanceZats: bigint;
  protected readonly txs: MockTx[] = [];

  constructor(opts: MockOptions = {}) {
    this.balanceZats = opts.startingBalanceZats ?? MOCK_START_ZATS;
    if (this.balanceZats > 0n) {
      this.txs.push({
        txid: `mock_${randomBytes(16).toString("hex")}`,
        kind: "received",
        valueZats: this.balanceZats,
        feeZats: 0n,
        datetime: new Date().toISOString(),
      });
    }
  }

  async pay(req: PaymentRequest): Promise<PaymentReceipt> {
    if (typeof req.amountZats !== "bigint" || req.amountZats <= 0n) {
      throw new Error("Amount must be a positive integer number of zatoshis");
    }
    const needed = req.amountZats + MOCK_FEE_ZATS;
    if (needed > this.balanceZats) {
      throw new Error(
        `Insufficient funds in mock wallet: need ${needed} zatoshis including fee, have ${this.balanceZats}.`
      );
    }
    const nonce = randomBytes(16).toString("hex");
    const txid = createHash("sha256")
      .update(`mock|${req.recipient}|${req.amountZats}|${nonce}`)
      .digest("hex");

    // Synthetic viewing-key material: fingerprint only in audit; never a real key
    const viewKeyMaterial = `vk_mock_${createHash("sha256")
      .update(`${txid}|${req.recipient}`)
      .digest("hex")
      .slice(0, 32)}`;

    const mockTxid = `mock_${txid.slice(0, 32)}`;
    this.balanceZats -= needed;
    this.txs.push({
      txid: mockTxid,
      kind: "sent",
      valueZats: req.amountZats,
      feeZats: MOCK_FEE_ZATS,
      recipient: req.recipient,
      memo: req.memo,
      datetime: new Date().toISOString(),
    });

    return {
      txid: mockTxid,
      amountZats: req.amountZats,
      recipient: req.recipient,
      memo: req.memo,
      viewKeyMaterial,
      mode: "mock",
    };
  }

  async getBalance(): Promise<WalletBalance> {
    return {
      confirmedZats: this.balanceZats,
      spendableZats: this.balanceZats,
      unconfirmedZats: 0n,
    };
  }

  async getReceiveAddress(): Promise<string> {
    return MOCK_RECEIVE_ADDRESS;
  }
}
