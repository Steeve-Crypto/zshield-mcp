import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fallbackAuditPath } from "../audit/log.js";
import { parseZecToZats } from "../policy/amount.js";
import type { AuditEntry } from "../types.js";

/** What the index knows about one zcash_pay call, rebuilt from audit rows. */
export interface PaymentRecord {
  callId: string;
  idempotencyKey?: string;
  paramsSha256?: string;
  /** The pending row written before the send */
  intent?: AuditEntry;
  /** The last row after the send: ok, error, rejected, or unknown */
  result?: AuditEntry;
}

interface Reservation {
  callId: string;
  paramsSha256: string;
}

/** Hash of the payment parameters that an idempotency key is bound to. Amounts compare by zatoshis. */
export function paymentParamsHash(input: { amount_zec: number | string; recipient: string; memo?: string }): string {
  let amount: string;
  try {
    amount = parseZecToZats(input.amount_zec, "amount_zec").toString();
  } catch {
    amount = `raw:${String(input.amount_zec)}`;
  }
  return createHash("sha256")
    .update(JSON.stringify([amount, input.recipient, input.memo ?? ""]))
    .digest("hex");
}

/**
 * zcash_pay calls by call_id and by idempotency key. Built from the audit log (main files
 * and the fallback file) when first used, then kept up to date as rows are written, so a
 * key survives a restart. A key is bound once its pending row is written; before that it
 * is only reserved in memory for the call that holds it.
 */
export class PaymentIndex {
  private readonly byCall = new Map<string, PaymentRecord>();
  private readonly byKey = new Map<string, string>();
  private readonly reserved = new Map<string, Reservation>();

  static load(target: { auditDir: string; auditFallbackPath?: string }): PaymentIndex {
    const index = new PaymentIndex();
    const files: string[] = [];
    try {
      if (existsSync(target.auditDir)) {
        for (const f of readdirSync(target.auditDir).sort()) if (f.endsWith(".jsonl")) files.push(join(target.auditDir, f));
      }
    } catch {
      // An unreadable audit dir is reported by the audit write itself.
    }
    const fallback = fallbackAuditPath(target.auditDir, target.auditFallbackPath);
    if (existsSync(fallback)) files.push(fallback);
    const rows: Record<string, unknown>[] = [];
    for (const file of files) {
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          rows.push(JSON.parse(line));
        } catch {
          // A torn last line after a crash; skip it.
        }
      }
    }
    // Rows from the main log and the fallback file interleave; order them by time.
    rows.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    for (const row of rows) index.record(row);
    return index;
  }

  /** Take in one audit row. Rows from other tools and replays are ignored. */
  record(row: Record<string, unknown>): void {
    if (row.tool !== "zcash_pay" || typeof row.call_id !== "string" || row.replay_of !== undefined) return;
    const entry = row as unknown as AuditEntry;
    let rec = this.byCall.get(entry.call_id);
    if (!rec) {
      rec = { callId: entry.call_id };
      this.byCall.set(entry.call_id, rec);
    }
    if (entry.status === "pending") rec.intent = entry;
    else rec.result = entry;
    if (entry.idempotency_key && entry.params_sha256 && entry.status === "pending") {
      rec.idempotencyKey = entry.idempotency_key;
      rec.paramsSha256 = entry.params_sha256;
      if (!this.byKey.has(entry.idempotency_key)) this.byKey.set(entry.idempotency_key, entry.call_id);
    }
  }

  byCallId(callId: string): PaymentRecord | undefined {
    return this.byCall.get(callId);
  }

  /** The bound call for a key, or the in-memory reservation of a call that has not written its intent yet. */
  byIdempotencyKey(key: string): { callId: string; paramsSha256: string; record?: PaymentRecord } | undefined {
    const callId = this.byKey.get(key);
    if (callId) {
      const record = this.byCall.get(callId)!;
      return { callId, paramsSha256: record.paramsSha256!, record };
    }
    return this.reserved.get(key);
  }

  reserve(key: string, callId: string, paramsSha256: string): void {
    this.reserved.set(key, { callId, paramsSha256 });
  }

  release(key: string, callId: string): void {
    if (this.reserved.get(key)?.callId === callId) this.reserved.delete(key);
  }

  /** Calls with a pending row and no result row. */
  unresolved(): PaymentRecord[] {
    return [...this.byCall.values()].filter((r) => r.intent && !r.result);
  }
}

const indexes = new Map<string, PaymentIndex>();

/** The index for one audit log, loaded on first use and shared within the process. */
export function paymentIndexFor(target: { auditDir: string; auditFallbackPath?: string }): PaymentIndex {
  const id = `${target.auditDir}\0${target.auditFallbackPath ?? ""}`;
  let index = indexes.get(id);
  if (!index) {
    index = PaymentIndex.load(target);
    indexes.set(id, index);
  }
  return index;
}

/** Forget loaded indexes, as a restart would. For tests. */
export function resetPaymentIndexes(): void {
  indexes.clear();
}
