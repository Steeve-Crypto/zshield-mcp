import { createHash } from "node:crypto";
import fs from "node:fs";
import { dirname, join } from "node:path";
import { MAX_AUDIT_ROW_BYTES, MAX_RECIPIENT_LENGTH } from "../policy/limits.js";
import { MAX_AMOUNT_LENGTH } from "../policy/amount.js";
import type { AuditEntry, RateLimitAuditEntry, ReadAuditEntry } from "../types.js";

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

/**
 * Flush a directory entry to disk, so a newly created file or folder survives a crash.
 * Windows cannot open a directory for fsync; NTFS journals the entry, so it is skipped there.
 */
export function fsyncDir(dir: string): void {
  if (process.platform === "win32") return;
  const fd = fs.openSync(dir, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Create `dir` if needed, fsyncing the parent of each folder that was created. */
export function ensureDurableDir(dir: string): void {
  const missing: string[] = [];
  for (let d = dir; !fs.existsSync(d); d = dirname(d)) {
    missing.unshift(d);
    if (dirname(d) === d) break;
  }
  if (missing.length === 0) return;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const d of missing) fsyncDir(dirname(d));
}

/**
 * Append `line` to `file` and fsync it before returning: open, write, fsync, close. A new
 * file is created with mode 0600 and its directory entry is fsynced too.
 */
export function appendDurable(file: string, line: string): void {
  const isNew = !fs.existsSync(file);
  const buf = Buffer.from(line, "utf8");
  const fd = fs.openSync(file, "a", 0o600);
  try {
    let off = 0;
    while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (isNew) fsyncDir(dirname(file));
}

/** Appends one bounded row, flushed to disk, and returns the file it went to. */
export function appendAuditEntry(auditDir: string, entry: AuditEntry | ReadAuditEntry | RateLimitAuditEntry): string {
  ensureDurableDir(auditDir);
  const day = entry.ts.slice(0, 10);
  const file = join(auditDir, `${day}.jsonl`);
  appendDurable(file, `${JSON.stringify(boundAuditEntry(entry))}\n`);
  return file;
}

/** Where rows go when the main audit directory cannot be written: AUDIT_FALLBACK_PATH, else beside the audit dir. */
export function fallbackAuditPath(auditDir: string, configured?: string): string {
  return configured ?? join(dirname(auditDir), "audit-fallback.jsonl");
}

export interface AuditWriteResult {
  /** True when the row reached disk, in the main log or the fallback file. */
  durable: boolean;
  /** The file the row went to, when durable. */
  file?: string;
  /** Set when the main log failed. */
  warning?: string;
}

type AuditRow = AuditEntry | ReadAuditEntry | RateLimitAuditEntry;
type StderrWrite = (line: string) => void;

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Write one audit row and never throw. Tries the main log, retries once, then appends to
 * the fallback file (mode 0600, fsynced). If that also fails, the row goes to stderr and
 * the result says it is not durable. Any failure is reported in `warning`.
 */
export function writeAuditRow(
  target: { auditDir: string; auditFallbackPath?: string },
  entry: AuditRow,
  stderr: StderrWrite = (line) => process.stderr.write(line)
): AuditWriteResult {
  const { auditDir } = target;
  let mainError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return { durable: true, file: appendAuditEntry(auditDir, entry) };
    } catch (e) {
      mainError = msg(e);
    }
  }
  const line = `${JSON.stringify(boundAuditEntry(entry))}\n`;
  const fallback = fallbackAuditPath(auditDir, target.auditFallbackPath);
  try {
    ensureDurableDir(dirname(fallback));
    appendDurable(fallback, line);
    return {
      durable: true,
      file: fallback,
      warning: `Audit row could not be written to ${auditDir} (${mainError}); it was written to ${fallback}.`,
    };
  } catch (e) {
    try {
      stderr(`zshield-mcp audit (not written to disk): ${line}`);
    } catch {
      // Nothing left to try.
    }
    return {
      durable: false,
      warning: `Audit row could not be written to ${auditDir} (${mainError}) or ${fallback} (${msg(e)}); it was printed to stderr only.`,
    };
  }
}
