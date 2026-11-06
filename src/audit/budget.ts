import fs from "node:fs";
import { dirname, join } from "node:path";
import { createExclusive, ensurePrivateDir, readPrivate } from "../fsafe.js";
import { MAX_AUDIT_ROW_BYTES } from "../policy/limits.js";

/** Each durable reservation covers one maximum-sized row plus its newline. */
export const AUDIT_SLOT_BYTES = MAX_AUDIT_ROW_BYTES + 1;
export const DEFAULT_AUDIT_MAX_BYTES = 64 * 1024 * 1024;
export interface AuditBudget {
  auditMaxBytes?: number;
  auditDiagnosticMaxBytes?: number;
}

function capacity(): never {
  throw Object.assign(new Error("Audit capacity exhausted; archive logs before renewing capacity."), {
    code: "AUDIT_CAPACITY",
  });
}

export function parseAuditBudget(value: unknown): number {
  const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < AUDIT_SLOT_BYTES || n > 1024 * 1024 * 1024) {
    throw new Error(`Audit byte budgets must be whole numbers from ${AUDIT_SLOT_BYTES} to 1073741824.`);
  }
  return n;
}

/**
 * Charge a durable, exclusive slot BEFORE appending. A crash or failed write consumes
 * capacity conservatively. O_EXCL publication arbitrates separate processes; no lease,
 * stale-lock deletion, counter race, or log/state pruning is involved. Budget directories
 * live beside the sink, not among JSONL files. Never reset while any writer is running.
 */
export function reserveAudit(file: string, financial: boolean, budget: AuditBudget, daily: boolean): void {
  const root = daily ? dirname(file) : file;
  const dir = `${root}.budget`;
  ensurePrivateDir(dir);
  const baselineFile = join(dir, "baseline.json");
  let baseline = readPrivate(baselineFile, 1024);
  if (baseline === undefined) {
    // Existing logs count too. Overcharge both pools rather than discard old evidence.
    const files = daily
      ? fs
          .readdirSync(root)
          .filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n))
          .map((n) => join(root, n))
      : [file];
    let bytes = 0;
    for (const f of files) {
      try {
        const st = fs.lstatSync(f);
        if (!st.isFile() || st.isSymbolicLink()) throw new Error("Unsafe audit sink.");
        bytes += st.size;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    }
    createExclusive(dir, "baseline.json", JSON.stringify({ bytes }));
    baseline = readPrivate(baselineFile, 1024);
  }
  const bytes = JSON.parse(baseline ?? "null")?.bytes;
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("Invalid audit capacity record.");
  const max = parseAuditBudget(
    (financial ? budget.auditMaxBytes : budget.auditDiagnosticMaxBytes) ?? DEFAULT_AUDIT_MAX_BYTES,
  );
  const slots = Math.floor((max - bytes) / AUDIT_SLOT_BYTES);
  // A bounded search; starting at a random slot avoids scanning a long occupied prefix.
  const start = slots > 0 ? Math.floor(Math.random() * slots) : 0;
  const occupied = new Set(fs.readdirSync(dir));
  for (let i = 0; i < slots; i++) {
    const name = `${financial ? "payment" : "diagnostic"}-${(start + i) % slots}`;
    if (!occupied.has(name) && createExclusive(dir, name, "")) return;
  }
  capacity();
}
