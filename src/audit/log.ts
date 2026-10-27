import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { MAX_AUDIT_ROW_BYTES, MAX_RECIPIENT_LENGTH } from "../policy/limits.js";
import { MAX_AMOUNT_LENGTH } from "../policy/amount.js";
import type { AuditEntry, ReadAuditEntry } from "../types.js";

/**
 * Short salted fingerprint of a viewing key: the first 16 hex characters of
 * sha256(salt | key). The key itself is never written anywhere.
 */
export function fingerprintViewKey(material: string, salt: string): string {
  return createHash("sha256").update(`${salt}|${material}`).digest("hex").slice(0, 16);
}

/** Characters of an oversized recipient kept in the audit row, next to its hash. */
const RECIPIENT_PREFIX = 64;
/** Any other string field longer than this is cut when a row is over the size limit. */
const FIELD_LIMIT = 1024;

function cut(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}...[truncated]` : s;
}

/**
 * Returns a copy of the row that fits in MAX_AUDIT_ROW_BYTES. An oversized recipient is
 * replaced by a short prefix plus its sha256, so the row still identifies it. An amount
 * string longer than MAX_AMOUNT_LENGTH is cut. If the row is
 * still too large, long string fields are cut, and as a last resort only the identifying
 * fields are kept. A row that changed carries `truncated: true`.
 */
export function boundAuditEntry<T extends object>(entry: T): T {
  let row: { [k: string]: unknown } = { ...(entry as { [k: string]: unknown }) };
  let truncated = false;
  if (typeof row.recipient === "string" && row.recipient.length > MAX_RECIPIENT_LENGTH) {
    row.recipient_sha256 = createHash("sha256").update(row.recipient).digest("hex");
    row.recipient = cut(row.recipient, RECIPIENT_PREFIX);
    truncated = true;
  }
  if (typeof row.amount_zec === "string" && row.amount_zec.length > MAX_AMOUNT_LENGTH) {
    row.amount_zec = cut(row.amount_zec, MAX_AMOUNT_LENGTH);
    truncated = true;
  }
  const size = (r: object) => Buffer.byteLength(JSON.stringify(r), "utf8");
  if (size(row) > MAX_AUDIT_ROW_BYTES) {
    for (const [k, v] of Object.entries(row)) {
      if (typeof v === "string" && v.length > FIELD_LIMIT) row[k] = cut(v, FIELD_LIMIT);
    }
    truncated = true;
  }
  if (size(row) > MAX_AUDIT_ROW_BYTES) {
    const keep = ["ts", "tool", "call_id", "status", "code", "mock_txid", "recipient_sha256", "view_key_fingerprint", "possible_txids"];
    row = Object.fromEntries(Object.entries(row).filter(([k]) => keep.includes(k)));
  }
  if (truncated) row.truncated = true;
  return row as unknown as T;
}

/** Appends one bounded row and returns the file it went to. */
export function appendAuditEntry(auditDir: string, entry: AuditEntry | ReadAuditEntry): string {
  mkdirSync(auditDir, { recursive: true });
  const day = entry.ts.slice(0, 10);
  const file = join(auditDir, `${day}.jsonl`);
  appendFileSync(file, `${JSON.stringify(boundAuditEntry(entry))}\n`, "utf8");
  return file;
}
