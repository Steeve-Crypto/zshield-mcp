export type ChainMode = "mock" | "live";

export interface RecipientEntry {
  address: string;
  label?: string;
}

export interface AllowlistFile {
  recipients: RecipientEntry[];
}

export interface Config {
  /** Hard per-call cap in ZEC, at most 8 decimals; compared as integer zatoshis */
  spendingCapZec: number | string;
  allowlistPath: string;
  chainMode: ChainMode;
  auditDir: string;
  viewKeyFingerprintSalt: string;
  chainNetwork?: string;
  zingoBin?: string;
  zingoDataDir?: string;
  lightwalletd?: string;
}

export type PayStatus = "pending" | "ok" | "rejected" | "error";

export interface AuditEntry {
  ts: string;
  tool: "zcash_pay";
  /** Correlates the pending row written before a send with its result row */
  call_id: string;
  /** Amount as passed to the tool */
  amount_zec: number | string;
  /** Amount in integer zatoshis, as a decimal string; absent when the amount was invalid */
  amount_zats?: string;
  /** Address as passed; an oversized one is cut to a prefix and recipient_sha256 is set */
  recipient: string;
  allowlist_hit: boolean;
  cap_zec: number | string;
  status: PayStatus;
  mock_txid?: string;
  view_key_fingerprint: string;
  error?: string;
  memo?: string;
  /** Only when the recipient was too long to store: sha256 of the full value */
  recipient_sha256?: string;
  /** Set when the row was shortened to fit the size limit */
  truncated?: boolean;
}

/** Read-only tools. They never move funds. */
export type ReadTool = "zcash_balance" | "zcash_receive_address" | "zcash_history";

/** One audit row per read-only tool call. Holds no balances, addresses, or keys. */
export interface ReadAuditEntry {
  ts: string;
  tool: ReadTool;
  call_id: string;
  mode: ChainMode;
  status: "ok" | "rejected" | "error";
  error?: string;
  /** zcash_history only: the limit that was asked for */
  limit?: unknown;
}

/** Wallet balance in integer zatoshis. */
export interface WalletBalance {
  /** Sum of confirmed funds across all pools */
  confirmedZats: bigint;
  /** Funds the wallet can spend right now */
  spendableZats: bigint;
  /** Seen but not yet confirmed */
  unconfirmedZats: bigint;
}

/** One wallet transaction, newest first in history results. */
export interface TxSummary {
  txid: string;
  /** ISO-8601 time, when known */
  time?: string;
  /** For example confirmed, transmitted, or mempool */
  status: string;
  blockHeight?: number;
  /** For example sent or received */
  kind: string;
  /** Value moved, in integer zatoshis */
  valueZats: bigint;
  feeZats?: bigint;
}

export interface PaymentRequest {
  /** Integer zatoshis */
  amountZats: bigint;
  recipient: string;
  memo?: string;
}

export interface PaymentReceipt {
  txid: string;
  /** Integer zatoshis */
  amountZats: bigint;
  recipient: string;
  memo?: string;
  /** Opaque viewing-key material used only for fingerprinting, never logged raw */
  viewKeyMaterial: string;
  mode: ChainMode;
}
