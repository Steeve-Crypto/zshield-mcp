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
  /** Live mode: how many blocks behind the tip the wallet may be and still send. Default 10 */
  healthMaxLagBlocks?: number;
  /** How long a send waits for another send on the same wallet before BUSY. Default 10000 */
  sendQueueWaitMs?: number;
  /** Where audit rows go when auditDir cannot be written. Default: audit-fallback.jsonl beside auditDir. */
  auditFallbackPath?: string;
  lightwalletd?: string;
  /** Tool calls allowed per minute in this process; default 60 */
  rateLimitPerMin?: number;
}

/** `unknown`: the send was attempted and may have been broadcast, but no txid came back */
export type PayStatus = "pending" | "ok" | "rejected" | "error" | "unknown" | "replayed";

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
  /** Salted hash of the wallet UFVK, the same on every row from one wallet. Null when the key could not be read */
  view_key_fingerprint: string | null;
  /** Stable machine code on rejected, error, and unknown rows, see README */
  code?: string;
  error?: string;
  memo?: string;
  /** Only when the recipient was too long to store: sha256 of the full value */
  recipient_sha256?: string;
  /** Set when the row was shortened to fit the size limit */
  truncated?: boolean;
  /** Unknown rows only: recent sent transactions in wallet history that match this amount */
  possible_txids?: string[];
  /** The same txids with how each one matched */
  possible_sends?: PossibleSend[];
  /** The caller's idempotency key, when one was given */
  idempotency_key?: string;
  /** sha256 of amount in zatoshis, recipient, and memo: what the key is bound to */
  params_sha256?: string;
  /** Replay rows only: the call whose outcome was returned. Nothing was sent */
  replay_of?: string;
  /** Testnet pending rows: the chain tip the pre-send check saw, used to prove expiry */
  chain_tip?: number;
}

/** Read-only tools. They never move funds. */
export type ReadTool = "zcash_balance" | "zcash_receive_address" | "zcash_history" | "zcash_payment_status";

/** One audit row per read-only tool call. Holds no balances, addresses, or keys. */
export interface ReadAuditEntry {
  ts: string;
  tool: ReadTool;
  call_id: string;
  mode: ChainMode;
  status: "ok" | "rejected" | "error";
  /** Stable machine code on rejected and error rows */
  code?: string;
  error?: string;
  /** zcash_history only: the limit that was asked for */
  limit?: unknown;
  /** zcash_payment_status only: the zcash_pay call that was looked up, when found */
  ref_call_id?: string;
}

/** One summary row for calls refused by the rate limit in a window. Holds no caller input. */
export interface RateLimitAuditEntry {
  ts: string;
  tool: "rate_limit";
  status: "rejected";
  code: "RATE_LIMITED";
  /** Start of the one-minute window the refused calls fell in */
  window_start: string;
  limit_per_min: number;
  refused_calls: number;
  refused_by_tool: Record<string, number>;
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
  /**
   * As zingo-cli reports it: confirmed (mined), transmitted (sent to the server, not yet
   * seen in a block by this wallet), mempool, calculated (built, not sent), or failed
   * (expired or rejected without being mined, so its inputs are spendable again)
   */
  status: string;
  /** Block the transaction was mined in. Only set when status is confirmed */
  blockHeight?: number;
  /**
   * For a transaction that is not confirmed, the height it was built for. It expires
   * unmined about 40 blocks later. Not a mined height
   */
  targetHeight?: number;
  /** For example sent or received */
  kind: string;
  /** Value moved, in integer zatoshis */
  valueZats: bigint;
  feeZats?: bigint;
  /** Notes this wallet sent, with recipient and memo, when the wallet output lists them */
  outgoing?: OutgoingNote[];
}

export interface OutgoingNote {
  recipient: string;
  valueZats: bigint;
  /** Empty when the note has no memo */
  memo: string;
  /** The unified address the wallet lists next to a different `recipient`, when it does */
  unifiedAddress?: string;
}

/** How sure a match between a send and a history entry is. */
export type MatchConfidence = "high" | "medium" | "low";

export interface PossibleSend {
  txid: string;
  confidence: MatchConfidence;
  /** What matched: recipient, amount, memo, time */
  matched: string[];
  status: string;
}

export interface PaymentRequest {
  /** Integer zatoshis */
  amountZats: bigint;
  recipient: string;
  memo?: string;
  /**
   * Called synchronously right before the wallet process is started, with nothing in
   * between. It throws if the caller no longer holds the wallet lease; the send is then
   * not started. The live adapter honors it; the mock chain has nothing to fence.
   */
  fence?: () => void;
}

export interface PaymentReceipt {
  txid: string;
  /** Integer zatoshis */
  amountZats: bigint;
  recipient: string;
  memo?: string;
  mode: ChainMode;
}

/** What the pre-send check reads from the wallet and server. */
export interface ChainHealth {
  /** Height the wallet has scanned to */
  walletHeight: number;
  /** Latest block height reported by the server */
  chainTip: number;
  spendableZats: bigint;
  /** Whether the bounded sync before the check finished. Absent when no sync was run */
  synced?: boolean;
  /** Why the sync did not finish */
  syncDetail?: string;
}
