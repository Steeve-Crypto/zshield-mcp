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
}

export type PayStatus = "ok" | "rejected" | "error";

export interface AuditEntry {
  ts: string;
  tool: "zcash_pay";
  amount_zec: number;
  recipient: string;
  allowlist_hit: boolean;
  cap_zec: number;
  status: PayStatus;
  mock_txid?: string;
  view_key_fingerprint: string;
  error?: string;
  memo?: string;
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
  /** Opaque viewing-key material used only for fingerprinting — never logged raw */
  viewKeyMaterial: string;
  mode: ChainMode;
}
