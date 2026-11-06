import { PolicyError } from "./caps.js";

/**
 * Size limits on caller-controlled input. Every string a caller sends can end up in an
 * audit row, and every audit row is written to disk and echoed in the tool response, so
 * each one is bounded before anything else happens.
 */

/** Longest recipient accepted. Zcash unified addresses are a few hundred characters at most. */
export const MAX_RECIPIENT_LENGTH = 256;
/** Zcash memo field size, in UTF-8 bytes. */
export const MAX_MEMO_BYTES = 512;
/** Hard ceiling for one serialized audit row, in UTF-8 bytes. */
export const MAX_AUDIT_ROW_BYTES = 8192;
/** Most candidate transactions (possible_sends) any one result or audit row lists. */
export const MAX_CANDIDATES = 10;

/** Addresses are bech32 or base58: visible ASCII, no spaces or control characters. */
const ADDRESS_CHARS = /^[\x21-\x7e]+$/;

export function recipientProblem(recipient: unknown): string | undefined {
  if (typeof recipient !== "string" || recipient.length === 0) return "Recipient must be a non-empty string.";
  if (recipient.length > MAX_RECIPIENT_LENGTH) return `Recipient is longer than ${MAX_RECIPIENT_LENGTH} characters.`;
  if (!ADDRESS_CHARS.test(recipient)) return "Recipient contains characters that cannot appear in an address.";
  return undefined;
}

/**
 * Control and line-break characters. zingo-cli prints a memo into a line-based listing, so
 * a memo with a line break could forge fields of that listing (a recipient, even a whole
 * transaction) and could not be matched back to its send. Memos are one line of text.
 */
const MEMO_FORBIDDEN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

export function memoProblem(memo: unknown): string | undefined {
  if (memo === undefined) return undefined;
  if (typeof memo !== "string") return "Memo must be a string.";
  if (Buffer.byteLength(memo, "utf8") > MAX_MEMO_BYTES) return `Memo is longer than ${MAX_MEMO_BYTES} bytes.`;
  if (MEMO_FORBIDDEN.test(memo)) return "Memo contains a control or line-break character. Use one line of text.";
  // The wallet listing prints a memo with its edges trimmed, and matching compares the
  // listed text to the sent text. A memo that trimming would change could never be matched
  // back exactly, so it is refused rather than quietly changed.
  if (memo !== memo.trim()) return "Memo starts or ends with whitespace. Remove it; the memo is sent exactly as given.";
  // A lone surrogate is not text: it would be sent as a replacement character, not as given.
  if (LONE_SURROGATE.test(memo)) return "Memo is not well-formed text (it holds an unpaired surrogate).";
  return undefined;
}

/**
 * Rejects an oversized or malformed recipient or memo. The messages never repeat the
 * caller's value, so a hostile input cannot grow the error, the audit row, or the response.
 */
export function assertPayInputBounded(recipient: unknown, memo: unknown): void {
  const recipientIssue = recipientProblem(recipient);
  if (recipientIssue) throw new PolicyError("INVALID_RECIPIENT", recipientIssue);
  const memoIssue = memoProblem(memo);
  if (memoIssue) throw new PolicyError("INVALID_MEMO", memoIssue);
}
