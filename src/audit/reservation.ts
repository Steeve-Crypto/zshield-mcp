import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { auditBudgetDirectory, AUDIT_SLOT_BYTES, DEFAULT_AUDIT_MAX_BYTES, parseAuditBudget, initializeAuditBudget, type AuditBudget } from "./budget.js";
import { ensurePrivateDir, fsyncDir, safeRecordPath } from "../fsafe.js";
import { MAX_AUDIT_ROW_BYTES } from "../policy/limits.js";

export const JOURNAL_HEADER_BYTES = 4096;
export const JOURNAL_SLOT_BYTES = 12288; // state + length + digest + maximum JSON row, block-aligned
const MAGIC = "ZSHIELD_PAYMENT_AUDIT_V1 ";
function failure(message: string, code = "AUDIT_RESERVATION_FAILED"): never {
  throw Object.assign(new Error(message), { code });
}
function openPrivate(file: string, flags: number): number {
  const fd = fs.openSync(safeRecordPath(file), flags | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || (process.getuid && st.uid !== process.getuid())) failure("Unsafe payment audit reservation.");
    fs.fchmodSync(fd, 0o600);
    return fd;
  } catch (e) { fs.closeSync(fd); throw e; }
}
function header(fd: number): number {
  const st = fs.fstatSync(fd), buf = Buffer.alloc(JOURNAL_HEADER_BYTES);
  if (fs.readSync(fd, buf, 0, buf.length, 0) !== buf.length) failure("Incomplete payment audit reservation.");
  const match = buf.toString("latin1").match(/^ZSHIELD_PAYMENT_AUDIT_V1 ([1-9][0-9]*)\n\0*$/);
  const slots = match ? Number(match[1]) : 0;
  if (!Number.isSafeInteger(slots) || slots < 1 || slots > Math.floor(1073741824 / AUDIT_SLOT_BYTES) ||
      st.size !== JOURNAL_HEADER_BYTES + slots * JOURNAL_SLOT_BYTES || st.blocks * 512 < st.size) {
    failure("Invalid or physically unallocated payment audit reservation.");
  }
  return slots;
}

/** Real zero-filled blocks, fsynced BEFORE exclusive publication. Never ftruncate sparse space.
 * Only non-CoW ext4/XFS are qualified. Do not reflink, deduplicate or compress live journals.
 * Increasing capacity requires offline migration, not silent replacement of evidence.
 */
export function ensurePaymentReservation(file: string, budget: AuditBudget, daily: boolean): string {
  const { dir } = initializeAuditBudget(file, daily);
  const type = fs.statfsSync(dir).type;
  if (process.platform !== "linux" || ![0xef53, 0x58465342].includes(type)) {
    failure("Payment audit reservations require a qualified Linux ext4 or XFS volume.");
  }
  const slots = Math.floor(parseAuditBudget(budget.auditMaxBytes ?? DEFAULT_AUDIT_MAX_BYTES) / AUDIT_SLOT_BYTES);
  const path = join(dir, "payment-evidence.bin");
  if (!fs.existsSync(path)) {
    const tmp = join(dir, `.tmp-reservation-${process.pid}-${randomBytes(8).toString("hex")}`);
    const fd = openPrivate(tmp, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL);
    try {
      const bytes = JOURNAL_HEADER_BYTES + slots * JOURNAL_SLOT_BYTES;
      const chunk = Buffer.alloc(64 * 1024);
      let offset = 0;
      while (offset < bytes) {
        const length = Math.min(chunk.length, bytes - offset);
        const n = fs.writeSync(fd, chunk, 0, length, offset);
        if (n <= 0) failure("Payment audit preallocation made no progress.");
        offset += n;
      }
      const head = Buffer.alloc(JOURNAL_HEADER_BYTES);
      head.write(`${MAGIC}${slots}\n`, "ascii");
      if (fs.writeSync(fd, head, 0, head.length, 0) !== head.length) failure("Incomplete payment audit header.");
      fs.fsyncSync(fd);
      header(fd); // Reject sparse/compressed allocation before publication.
      try { fs.linkSync(tmp, path); } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      fsyncDir(dir);
    } finally {
      fs.closeSync(fd);
      try { fs.unlinkSync(tmp); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    }
  }
  const fd = openPrivate(path, fs.constants.O_RDWR);
  try {
    if (header(fd) < slots) failure("Payment audit reservation is too small; offline capacity migration required.");
    // Repairs a visible publication whose creator failed its directory fsync.
    fsyncDir(dir);
  } finally { fs.closeSync(fd); }
  return path;
}

/** Fixed slots, not append growth. An I(ncomplete) slot is permanently charged after a crash.
 * The flock, marker, body, commit marker and fsync all occur on the SAME inherited inode.
 */
export function appendPaymentEvidence(path: string, row: object, allowance?: number): void {
  const data = Buffer.from(JSON.stringify(row), "utf8");
  if (data.length > MAX_AUDIT_ROW_BYTES) failure("Payment audit row exceeds its reserved slot.");
  const fd = openPrivate(path, fs.constants.O_RDWR);
  try {
    const slots = header(fd), limit = Math.min(slots, allowance ?? slots);
    if (!Number.isSafeInteger(limit) || limit < 0) failure("Invalid payment audit allowance.");
    const result = spawnSync("perl", ["-e", WRITE_SLOT, "--", String(slots), String(JOURNAL_HEADER_BYTES), String(JOURNAL_SLOT_BYTES), String(limit)], {
      input: data, encoding: "utf8", timeout: 5000, maxBuffer: 1024,
      stdio: ["pipe", "pipe", "pipe", fd],
    });
    if (result.status === 75) failure("Reserved payment audit slots exhausted; offline archival required.", "AUDIT_CAPACITY");
    if (result.status !== 0 || !/^WRITTEN [0-9]+\n$/.test(result.stdout ?? "")) failure("Reserved payment audit write failed; no durable evidence acknowledged.");
  } finally { fs.closeSync(fd); }
}
const WRITE_SLOT = String.raw`
use strict; use Fcntl qw(:flock SEEK_SET); use Time::HiRes qw(time sleep); use IO::Handle; use Digest::SHA qw(sha256_hex);
my ($slots,$header,$stride,$limit)=@ARGV; open(my $fh, '+<&=3') or die 'fd'; binmode($fh);
my $end=time()+2; until(flock($fh, LOCK_EX|LOCK_NB)){ die 'busy' if time()>=$end; sleep(0.005) }
my @st=stat($fh); die 'inode' unless -f $fh && $st[4]==$< && $st[7]==$header+$slots*$stride;
local $/; my $data=<STDIN>; die 'row' if !defined($data) || length($data)>8192;
sub writeall { my ($s)=@_; my $off=0; while($off<length($s)){ my $n=syswrite($fh,$s,length($s)-$off,$off); die 'write' unless $n; $off+=$n } }
for(my $i=0;$i<$limit;$i++){
  my $pos=$header+$i*$stride; sysseek($fh,$pos,SEEK_SET)==$pos or die 'seek';
  sysread($fh,my $mark,1)==1 or die 'read';
  next if $mark eq 'C' || $mark eq 'I'; die 'marker' unless $mark eq "\0";
  sysseek($fh,$pos,SEEK_SET)==$pos or die 'seek'; sysread($fh,my $empty,$stride)==$stride or die 'read'; die 'dirty' if $empty =~ /[^\0]/;
  sysseek($fh,$pos,SEEK_SET)==$pos or die 'seek'; writeall('I'); $fh->sync or die 'sync';
  writeall(sprintf('%08x',length($data)).sha256_hex($data).$data); $fh->sync or die 'sync';
  sysseek($fh,$pos,SEEK_SET)==$pos or die 'seek'; writeall('C'); $fh->sync or die 'sync';
  print "WRITTEN $i\n"; exit 0;
} exit 75;
`;

/** Operator export: complete rows only, checksummed; incomplete slots remain visible as counts. */
export function readPaymentEvidence(path: string): { rows: object[]; incomplete: number; capacity: number } {
  const fd = openPrivate(path, fs.constants.O_RDONLY);
  try {
    const capacity = header(fd), rows: object[] = []; let incomplete = 0;
    for (let i = 0; i < capacity; i++) {
      const buf = Buffer.alloc(JOURNAL_SLOT_BYTES);
      if (fs.readSync(fd, buf, 0, buf.length, JOURNAL_HEADER_BYTES + i * JOURNAL_SLOT_BYTES) !== buf.length) failure("Short payment audit slot.");
      if (buf[0] === 0 && buf.every(x => x === 0)) continue;
      if (buf[0] === 73) { incomplete++; continue; }
      if (buf[0] !== 67 || !/^[0-9a-f]{8}$/.test(buf.toString("latin1", 1, 9))) failure("Corrupt payment audit slot.");
      const len = parseInt(buf.toString("latin1", 1, 9), 16), data = buf.subarray(73, 73 + len);
      if (len > MAX_AUDIT_ROW_BYTES || createHash("sha256").update(data).digest("hex") !== buf.toString("latin1", 9, 73)) failure("Corrupt payment audit checksum.");
      rows.push(JSON.parse(data.toString("utf8")) as object);
    }
    return { rows, incomplete, capacity };
  } finally { fs.closeSync(fd); }
}

/** Slot markers are monotonic; health includes incomplete reservations, never just JSONL bytes. */
export function paymentReservationUsage(file: string, daily: boolean): number {
  const path = join(auditBudgetDirectory(file, daily), "payment-evidence.bin");
  if (!fs.existsSync(path)) return 0;
  const fd = openPrivate(path, fs.constants.O_RDONLY);
  try {
    const slots = header(fd), marker = Buffer.alloc(1); let used = 0;
    for (let i = 0; i < slots; i++) {
      if (fs.readSync(fd, marker, 0, 1, JOURNAL_HEADER_BYTES + i * JOURNAL_SLOT_BYTES) !== 1) failure("Short payment audit marker.");
      if (marker[0] === 67 || marker[0] === 73) used++;
      else if (marker[0] !== 0) failure("Corrupt payment audit marker.");
    }
    return used;
  } finally { fs.closeSync(fd); }
}
