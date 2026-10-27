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
] as const;

/** zcash_pay failed after policy passed, or the server is misconfigured. Audited with status `error`. */
export const PAY_ERROR_CODES = ["AUDIT_WRITE_FAILED", "CHAIN_ERROR", "CONFIG_ERROR"] as const;

/** Read-only tool failures. */
export const READ_ERROR_CODES = ["INVALID_LIMIT", "MAINNET_REFUSED", "CHAIN_ERROR"] as const;

export type PayRejectionCode = (typeof PAY_REJECTION_CODES)[number];
export type PayErrorCode = (typeof PAY_ERROR_CODES)[number];
export type PayCode = PayRejectionCode | PayErrorCode;
export type ReadErrorCode = (typeof READ_ERROR_CODES)[number];
