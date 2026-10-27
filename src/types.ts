export type ChainMode = "mock" | "live";

export interface RecipientEntry {
  address: string;
  label?: string;
}

export interface AllowlistFile {
  recipients: RecipientEntry[];
}

export interface Config {
  spendingCapZec: number;
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
  amount_zec: number;
  /** Address as passed; an oversized one is cut to a prefix and recipient_sha256 is set */
  recipient: string;
  allowlist_hit: boolean;
  cap_zec: number;
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

export interface PaymentRequest {
  amountZec: number;
  recipient: string;
  memo?: string;
}

export interface PaymentReceipt {
  txid: string;
  amountZec: number;
  recipient: string;
  memo?: string;
  /** Opaque viewing-key material used only for fingerprinting, never logged raw */
  viewKeyMaterial: string;
  mode: ChainMode;
}
