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

export type PayStatus = "ok" | "rejected" | "error";

export interface AuditEntry {
  ts: string;
  tool: "zcash_pay";
  /** Amount as passed to the tool */
  amount_zec: number | string;
  /** Amount in integer zatoshis, as a decimal string; absent when the amount was invalid */
  amount_zats?: string;
  recipient: string;
  allowlist_hit: boolean;
  cap_zec: number | string;
  status: PayStatus;
  mock_txid?: string;
  view_key_fingerprint: string;
  error?: string;
  memo?: string;
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
