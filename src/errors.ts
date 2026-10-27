/**
 * Stable machine codes for failed tool calls. Clients should branch on `code`,
 * not on the message text, which may change.
 */

/** zcash_pay was refused by policy. Nothing was sent. Audited with status `rejected`. */
export const PAY_REJECTION_CODES = [
  "INVALID_RECIPIENT",
  "INVALID_MEMO",
  "INVALID_AMOUNT",
  "CAP_EXCEEDED",
  "INVALID_CAP",
  "MAINNET_REFUSED",
  "INVALID_ADDRESS",
  "NOT_ALLOWLISTED",
  "ALLOWLIST_UNAVAILABLE",
  "INVALID_IDEMPOTENCY_KEY",
  "IDEMPOTENCY_CONFLICT",
] as const;

/** zcash_pay failed after policy passed, or the server is misconfigured. Audited with status `error`. */
export const PAY_ERROR_CODES = [
  "AUDIT_WRITE_FAILED",
  "VIEWKEY_UNAVAILABLE",
  "CHAIN_ERROR", "CONFIG_ERROR",
  "BUSY",
  "WALLET_NOT_SYNCED",
  "INSUFFICIENT_FUNDS",
  "CHAIN_UNREACHABLE",
] as const;

/**
 * zcash_pay was attempted but its outcome is not known, for example zingo-cli timed out
 * mid-send. The payment may have been broadcast. Audited with status `unknown`.
 */
export const PAY_UNKNOWN_CODES = ["SEND_UNCONFIRMED", "PAYMENT_PENDING"] as const;

/** Read-only tool failures. */
export const READ_ERROR_CODES = ["INVALID_LIMIT", "MAINNET_REFUSED", "CHAIN_ERROR", "INVALID_LOOKUP", "PAYMENT_NOT_FOUND"] as const;

/** Any tool: too many calls this minute. Refused before the tool runs. Counted in one summary audit row per window. */
export const RATE_LIMIT_CODES = ["RATE_LIMITED"] as const;

export type PayRejectionCode = (typeof PAY_REJECTION_CODES)[number];
export type PayErrorCode = (typeof PAY_ERROR_CODES)[number];
export type PayUnknownCode = (typeof PAY_UNKNOWN_CODES)[number];
export type PayCode = PayRejectionCode | PayErrorCode | PayUnknownCode;
export type ReadErrorCode = (typeof READ_ERROR_CODES)[number];
