import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { dirname, join } from "node:path";
import { createExclusive, ensurePrivateDir, readPrivate, checkPrivateFile } from "../fsafe.js";
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
 * Charge a durable reservation BEFORE appending. A crash or failed write consumes
 * capacity conservatively. OS flock serializes fixed-inode counters; there is no lease,
 * stale-lock deletion, or log/state pruning. Legacy slot files remain charged. Budget directories
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
  // Keep legacy charges; never delete evidence or reset capacity during upgrade.
  const prefix = financial ? "payment" : "diagnostic";
  const legacy = fs.readdirSync(dir).filter((name) => new RegExp(`^${prefix}-[0-9]+$`).test(name)).length;
  const ledger = join(dir, `${prefix}.counter`);
  if (!fs.existsSync(ledger)) createExclusive(dir, `${prefix}.counter`, "");
  checkPrivateFile(ledger);
  // A fixed inode per pool. File length is the monotonic reservation count. flock
  // serializes processes; a crash after truncate only overcharges. fsync precedes
  // success, so no audit append can outrun its durable reservation. No leases.
  const charged = spawnSync("perl", ["-e", RESERVE_COUNTER, "--", ledger, String(Math.max(0, slots - legacy))], {
    encoding: "utf8", timeout: 2000, maxBuffer: 1024,
  });
  if (charged.status === 75) capacity();
  if (charged.status !== 0 || charged.stdout !== "RESERVED\n") throw new Error("Audit reservation counter unavailable.");
}

const RESERVE_COUNTER = [
  "use strict; use Fcntl qw(:flock O_RDWR O_NOFOLLOW O_NONBLOCK); use Time::HiRes qw(time sleep); use IO::Handle;",
  "my ($file, $max) = @ARGV;",
  "sysopen(my $fh, $file, O_RDWR | O_NOFOLLOW | O_NONBLOCK) or die 'open';",
  "my @st = stat($fh); die 'unsafe counter' unless -f $fh && @st && $st[4] == $<;",
  "my $end = time() + 1; until (flock($fh, LOCK_EX | LOCK_NB)) { die 'busy' if time() >= $end; sleep(0.005) }",
  "my $size = -s $fh; exit 75 if $size >= $max;",
  "truncate($fh, $size + 1) or die 'truncate'; $fh->sync or die 'sync'; print \"RESERVED\\n\";",
].join(" ");
