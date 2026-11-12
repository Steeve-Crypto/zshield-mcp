import { appendPaymentEvidence, ensurePaymentReservation } from "./reservation.js";
import { paymentSlotAllowance, reserveAudit, type AuditBudget, type AuditPool } from "./budget.js";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { appendPrivate, ensurePrivateDir } from "../fsafe.js";
import { redactDeep } from "../redact.js";
import { MAX_AUDIT_ROW_BYTES, MAX_RECIPIENT_LENGTH } from "../policy/limits.js";
import { MAX_AMOUNT_LENGTH } from "../policy/amount.js";
import type { AuditEntry, RateLimitAuditEntry, ReadAuditEntry } from "../types.js";
import type { RecoveryAuditEntry } from "../payments/recovery.js";

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
    const keep = ["ts", "tool", "call_id", "status", "code", "mock_txid", "recipient_sha256", "view_key_fingerprint", "possible_txids", "possible_sends", "txid", "block_height", "idempotency_key", "operation_id"];
    row = Object.fromEntries(Object.entries(row).filter(([k]) => keep.includes(k)));
  }
  // Last: candidate lists are the one thing the keep list lets through at any size.
  if (size(row) > MAX_AUDIT_ROW_BYTES) {
    delete row.possible_sends;
    delete row.possible_txids;
    truncated = true;
  }
  if (truncated) row.truncated = true;
  // The truncation marker itself consumes bytes. Keep the capacity reservation a
  // hard upper bound even when adding it takes a near-limit row over the boundary.
  if (size(row) > MAX_AUDIT_ROW_BYTES) {
    const identity = ["ts", "tool", "call_id", "operation_id", "status", "code", "txid", "mock_txid", "idempotency_key", "view_key_fingerprint"];
    row = Object.fromEntries(identity.filter((k) => row[k] !== undefined).map((k) => [k, typeof row[k] === "string" ? cut(row[k] as string, 128) : row[k]]));
    row.truncated = true;
  }
  return row as unknown as T;
}

export { fsyncDir } from "../fsafe.js";

/** Create `dir` if needed (0700, parents fsynced); refuse a symlink or another owner; tighten a loose mode. */
export function ensureDurableDir(dir: string): void {
  ensurePrivateDir(dir);
}

/**
 * Append `line` to `file` and fsync it before returning. Never follows a symlink, refuses
 * a file owned by another user, and tightens a loose mode to 0600.
 */
export function appendDurable(file: string, line: string): void {
  appendPrivate(file, line);
}

/** Appends one bounded row, flushed to disk, and returns the file it went to. */
export function appendAuditEntry(
  auditDir: string,
  entry: AuditEntry | ReadAuditEntry | RateLimitAuditEntry | RecoveryAuditEntry,
  budget: AuditBudget = {}
): string {
  ensureDurableDir(auditDir);
  const day = entry.ts.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("Invalid audit date.");
  const file = join(auditDir, `${day}.jsonl`);
  return appendReserved(file, entry, budget, true);
}

/** The JSONL file is a compatibility/traffic sink. Payment durability is the reserved journal. */
function appendReserved(file: string, entry: AuditRow, budget: AuditBudget, daily: boolean): string {
  const journal = ensurePaymentReservation(file, budget, daily);
  const pool = auditPool(entry);
  const bounded = boundAuditEntry(entry);
  if (pool === "payment") {
    appendPaymentEvidence(journal, bounded, paymentSlotAllowance(file, budget, daily));
    // Mirrors can fail when traffic has filled unreserved space. Never discard durable
    // payment evidence because a compatibility append needs another filesystem block.
    for (let attempt = 0; attempt < 2; attempt++) {
      try { appendDurable(file, `${JSON.stringify(bounded)}\n`); return file; } catch { /* journal remains durable */ }
    }
    return journal;
  }
  reserveAudit(file, pool, budget, daily);
  appendDurable(file, `${JSON.stringify(bounded)}\n`);
  return file;
}

/** Reserve both sinks before any caller-controlled traffic can consume their free disk. */
export function prepareAuditReservations(target: { auditDir: string; auditFallbackPath?: string } & AuditBudget): string[] {
  const warnings: string[] = [];
  const sinks = [{ file: join(target.auditDir, "2000-01-01.jsonl"), daily: true },
    { file: fallbackAuditPath(target.auditDir, target.auditFallbackPath), daily: false }];
  let ready = 0;
  for (const sink of sinks) {
    try {
      ensureDurableDir(dirname(sink.file));
      ensurePaymentReservation(sink.file, target, sink.daily);
      ready++;
    } catch (e) { warnings.push(`Payment audit reservation unavailable (${msg(e)}).`); }
  }
  if (ready === 0) throw Object.assign(new Error("No physically reserved payment audit destination is available."), { code: "AUDIT_RESERVATION_FAILED" });
  return warnings;
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

type AuditRow = AuditEntry | ReadAuditEntry | RateLimitAuditEntry | RecoveryAuditEntry;
/** When set, live audit files must not change (maintenance snapshot in progress). */
let auditFreezeDepth = 0;
export function freezeAuditWrites(): void { auditFreezeDepth++; }
export function unfreezeAuditWrites(): void { auditFreezeDepth = Math.max(0, auditFreezeDepth - 1); }
export function auditWritesFrozen(): boolean { return auditFreezeDepth > 0; }
function auditPool(row: AuditRow): AuditPool {
  // Only rows that record or precede a real payment mutation use the protected pool. A
  // refused payment or resume is per-call evidence in its own
  // fail-closed pool, so caller-controlled refusals cannot exhaust payment capacity (F-59),
  // and cannot fall into the diagnostic pool where exhaustion drops evidence (F-75).
  if (row.tool === "zcash_pay") {
    if (row.status === "replayed") return "diagnostic";
    // Infrastructure/busy errors before an operation exists are refusals of THIS attempt,
    // not payment mutations. Keep legacy unknown/tx-bearing evidence protected.
    const preauthorizationError = row.status === "error" && !row.operation_id && !row.mock_txid
      && !row.possible_txids?.length && !row.possible_sends?.length;
    return row.status === "rejected" || preauthorizationError || (row as { refusal?: boolean }).refusal ? "refusal" : "payment";
  }
  if (row.tool === "zcash_pay_recovery") return (row as { refusal?: boolean }).refusal ? "refusal" : "payment";
  return "diagnostic";
}
// Capacity refusals must not turn stderr into an unbounded replacement audit sink.
const capacityWarnings = new Set<string>();
type StderrWrite = (line: string) => void;

/** Why a write failed, without the absolute path a filesystem error message carries. */
function msg(e: unknown): string {
  const code = (e as NodeJS.ErrnoException)?.code;
  return typeof code === "string" && ["EACCES", "EPERM", "ENOENT", "ENOTDIR", "ENOSPC", "EIO", "EDQUOT", "ELOOP", "AUDIT_CAPACITY", "AUDIT_RESERVATION_FAILED"].includes(code) ? code : "storage failure";
}

/**
 * Write one audit row and never throw. Tries the main log, retries once, then appends to
 * the fallback file (mode 0600, fsynced). If that also fails, the row goes to stderr and
 * the result says it is not durable. Any failure is reported in `warning`.
 */
export function writeAuditRow(
  target: { auditDir: string; auditFallbackPath?: string } & AuditBudget,
  entry: AuditRow,
  stderr: StderrWrite = (line) => process.stderr.write(line)
): AuditWriteResult {
  const { auditDir } = target;
  // No row carries a server credential or a local path, even inside an error message.
  entry = redactDeep(entry);
  // Maintenance snapshots copy live audit files; mutating them mid-copy aborts backup (F-68).
  if (auditFreezeDepth > 0) {
    return { durable: false, warning: "Audit writes are frozen during maintenance snapshot; row was not written." };
  }
  // Both reservations are attempted first. A failed destination remains unavailable;
  // a healthy fallback retains its own independent, physically allocated evidence slots.
  try { prepareAuditReservations(target); } catch { /* per-sink errors below preserve fallback reporting */ }
  let mainError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const file = appendAuditEntry(auditDir, entry, target);
      return { durable: true, file, warning: file.endsWith("payment-evidence.bin")
        ? "Payment evidence persisted in reserved journal; compatibility JSONL mirror could not be written." : undefined };
    } catch (e) {
      mainError = msg(e);
    }
  }
  const line = `${JSON.stringify(boundAuditEntry(entry))}\n`;
  const fallback = fallbackAuditPath(auditDir, target.auditFallbackPath);
  try {
    ensureDurableDir(dirname(fallback));
    const persisted = appendReserved(fallback, entry, target, false);
    return {
      durable: true,
      file: persisted,
      warning: `Audit row could not be written to the audit dir (${mainError}); it was written to the fallback file${persisted.endsWith("payment-evidence.bin") ? " reserved journal (JSONL mirror unavailable)" : ""}.`,
    };
  } catch (e) {
    try {
      if (mainError !== "AUDIT_CAPACITY" && msg(e) !== "AUDIT_CAPACITY") {
        stderr(`zshield-mcp audit (not written to disk): ${line}`);
      } else if (!capacityWarnings.has(auditDir)) {
        if (capacityWarnings.size >= 128) capacityWarnings.clear();
        capacityWarnings.add(auditDir);
        stderr("zshield-mcp: audit capacity exhausted; further audit rows are refused until capacity is renewed.\n");
      }
    } catch {
      // Nothing left to try.
    }
    return {
      durable: false,
      warning: `Audit row could not be written to the audit dir (${mainError}) or the fallback file (${msg(e)}); it was printed to stderr only.`,
    };
  }
}
