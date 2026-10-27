import type { SyncResult } from "./sync.js";
import type { ChainHealth, PaymentReceipt, PaymentRequest, TxSummary, WalletBalance } from "../types.js";

export interface ChainAdapter {
  readonly mode: "mock" | "live";
  /** Identifies the wallet, so sends from two adapters on one wallet share a lock. */
  readonly walletId?: string;
  /** Directory for the wallet lock file shared across processes. Mock adapters have none. */
  readonly lockDir?: string;
  pay(req: PaymentRequest): Promise<PaymentReceipt>;
  /** Read-only. Never moves funds. */
  getBalance(opts?: { offline?: boolean }): Promise<WalletBalance>;
  /** Read-only. The wallet's current unified address. */
  getReceiveAddress(opts?: { offline?: boolean }): Promise<string>;
  /**
   * Read-only. Up to `limit` recent transactions, newest first. `offline` reads the
   * wallet as last synced, without starting a sync.
   */
  getHistory(limit: number, opts?: { offline?: boolean }): Promise<TxSummary[]>;
  /**
   * Read-only. The wallet's unified full viewing key, used only to compute the salted
   * audit fingerprint. Callers must never log, store, or return it.
   */
  getViewingKey(): Promise<string>;
  /**
   * Read-only. Wallet height, chain tip from the server, and spendable zatoshis, for the
   * pre-send check. Throws ChainUnreachableError when the server does not answer in time.
   */
  checkHealth?(opts?: { sync?: boolean }): Promise<ChainHealth>;
  /**
   * Sync the wallet to the chain tip for at most `timeoutMs`. Scans and saves; never
   * sends. Callers hold the wallet lock. Never throws.
   */
  syncWallet?(timeoutMs: number): Promise<SyncResult>;
  /** Read-only, offline. The height the wallet has synced to, for confirmation counts. */
  walletHeight?(): Promise<number>;
}
