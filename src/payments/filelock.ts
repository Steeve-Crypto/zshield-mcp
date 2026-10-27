import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, openSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { BusyError } from "./lock.js";

/** Name of the lease file in the payment store. */
export const WALLET_LOCK_FILE = "wallet.lock";
/** Default lease: a holder that has not renewed for this long loses the lock. */
export const LOCK_LEASE_DEFAULT_MS = 60_000;
export const LOCK_LEASE_MIN_MS = 1_000;
export const LOCK_LEASE_MAX_MS = 600_000;
/** A lock file that cannot be parsed is stale once it is this old (a crash mid-write). */
const UNREADABLE_STALE_MS = 10_000;
const POLL_MS = 100;

/** ZSHIELD_LOCK_LEASE_MS, whole milliseconds from LOCK_LEASE_MIN_MS to LOCK_LEASE_MAX_MS. */
export function parseLockLease(value: unknown): number {
  const n = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < LOCK_LEASE_MIN_MS || n > LOCK_LEASE_MAX_MS) {
    throw new Error(`ZSHIELD_LOCK_LEASE_MS must be a whole number from ${LOCK_LEASE_MIN_MS} to ${LOCK_LEASE_MAX_MS}.`);
  }
  return n;
}

/** The lease time from the environment, or the default. Invalid values are caught at startup. */
export function lockLeaseMs(env: NodeJS.ProcessEnv = process.env): number {
  const v = env.ZSHIELD_LOCK_LEASE_MS;
  if (v === undefined || v === "") return LOCK_LEASE_DEFAULT_MS;
  try {
    return parseLockLease(v);
  } catch {
    return LOCK_LEASE_DEFAULT_MS;
  }
}

export interface LockInfo {
  pid: number;
  host: string;
  started: string;
  purpose: string;
  token: string;
  /** The holder's lease time. Others judge staleness by it, never by a shorter one of their own. */
  leaseMs: number;
  /**
   * Renewal counter, a fixed-width hex string the holder overwrites in place on every
   * renewal. A waiter that judged the file stale from one reading cannot remove it once
   * the counter has moved.
   */
  gen: string;
}

const GEN_WIDTH = 8;
const genText = (n: number) => n.toString(16).padStart(GEN_WIDTH, "0");

/** The holder lost the lease: it stalled past the lease time, or the file was replaced. */
export class LeaseLostError extends Error {
  constructor(readonly detail: string) {
    super(`The wallet lock was lost: ${detail}.`);
    this.name = "LeaseLostError";
  }
}

/** A held wallet lease. */
export interface Lease {
  /** Stop renewing and remove the file if it is still this lease. Safe to call twice. */
  release(): void;
  /**
   * Throws LeaseLostError unless the file still carries this lease's token and the last
   * renewal is recent enough that nobody could have judged it stale. Call it right
   * before any step that must not overlap another holder.
   */
  assertHeld(): void;
}

export interface FileLockOptions {
  /** How long to wait for the lock before BusyError. 0 tries once. */
  waitMs: number;
  purpose: string;
  /** Lease time. Defaults to ZSHIELD_LOCK_LEASE_MS or LOCK_LEASE_DEFAULT_MS. */
  leaseMs?: number;
  now?: () => number;
  /** Whether a process on this host is still running. */
  isAlive?: (pid: number) => boolean;
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it exists but belongs to someone else.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

function parseInfo(text: string): LockInfo | undefined {
  try {
    const info = JSON.parse(text) as LockInfo;
    if (typeof info.pid === "number" && typeof info.token === "string") return info;
  } catch {
    // Unparsable; judged by file age.
  }
  return undefined;
}

/**
 * The lease to judge a lock by: the longer of the holder's own recorded lease and ours. A
 * holder that renews every quarter of a long lease is never stale to a waiter that would
 * have used a short one. A file with no usable lease (an older version) is judged by ours.
 */
export function effectiveLeaseMs(info: LockInfo | undefined, ownLeaseMs: number): number {
  const theirs = info && Number.isFinite(info.leaseMs) ? Math.min(Math.max(info.leaseMs, LOCK_LEASE_MIN_MS), LOCK_LEASE_MAX_MS) : 0;
  return Math.max(theirs, ownLeaseMs);
}

/**
 * Why the lock at `path` is stale, or undefined when its holder may still be working.
 * Age is the time since the holder last renewed, read from the file's mtime. The file is
 * read before and after the stat; if it changed in between, a renewal happened and it is
 * not stale.
 */
export function staleReason(
  path: string,
  text: string,
  opts: { leaseMs: number; now: number; isAlive: (pid: number) => boolean }
): string | undefined {
  let age: number;
  try {
    age = opts.now - statSync(path).mtimeMs;
    if (readText(path) !== text) return undefined;
  } catch {
    return undefined;
  }
  const info = parseInfo(text);
  if (!info) return age > UNREADABLE_STALE_MS ? "unreadable lock file" : undefined;
  if (info.host === hostname() && !opts.isAlive(info.pid)) return `process ${info.pid} is gone`;
  const lease = effectiveLeaseMs(info, opts.leaseMs);
  if (age > lease) return `not renewed for more than ${lease} ms`;
  return undefined;
}

/** Create the lock file exclusively and write `text`. Returns the open descriptor, or undefined if the file exists. */
function tryCreate(path: string, text: string): number | undefined {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw e;
  }
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } catch (e) {
    closeSync(fd);
    throw e;
  }
  return fd;
}

/**
 * Remove a stale lock without removing a live one. The file is moved aside by rename,
 * which keeps its inode, then judged again as it now is: same text (so same renewal
 * counter) and still stale by its own mtime. A renewal that landed before the move shows
 * in either; one that comes after finds no file and the holder loses the lease. If the
 * second look says the holder is alive, the file is put back.
 */
function breakStale(path: string, judged: string, opts: { leaseMs: number; isAlive: (pid: number) => boolean; afterMove?: () => void }): void {
  const aside = `${path}.stale-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    renameSync(path, aside);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  opts.afterMove?.();
  let still = false;
  try {
    const moved = readFileSync(aside, "utf8");
    still = moved === judged && staleReason(aside, moved, { leaseMs: opts.leaseMs, now: Date.now(), isAlive: opts.isAlive }) !== undefined;
  } catch {
    still = false;
  }
  if (!still) {
    try {
      linkSync(aside, path);
    } catch {
      // Someone took the lock in the meantime; theirs stands.
    }
  }
  try {
    unlinkSync(aside);
  } catch {
    // Already gone.
  }
}

/** Test seam: break the stale lock at `path`, running `afterMove` between the move and the second look. */
export function breakStaleLockForTest(path: string, judged: string, opts: { leaseMs: number; isAlive?: (pid: number) => boolean; afterMove?: () => void }): void {
  breakStale(path, judged, { leaseMs: opts.leaseMs, isAlive: opts.isAlive ?? pidAlive, afterMove: opts.afterMove });
}

/**
 * Take the wallet lease file in `dir`, shared by every zshield-mcp process on the wallet.
 * Created with O_EXCL and mode 0600. While held, a heartbeat renews the file's mtime
 * every quarter lease. A lock whose process is gone (same host), or that has not been
 * renewed for a whole lease, is broken. Waits up to `waitMs`, then throws BusyError.
 */
export async function acquireFileLock(dir: string, opts: FileLockOptions): Promise<Lease> {
  const path = join(dir, WALLET_LOCK_FILE);
  const now = opts.now ?? Date.now;
  const isAlive = opts.isAlive ?? pidAlive;
  const leaseMs = opts.leaseMs ?? lockLeaseMs();
  const deadline = now() + opts.waitMs;
  const info: LockInfo = {
    pid: process.pid,
    host: hostname(),
    started: new Date(now()).toISOString(),
    purpose: opts.purpose,
    token: randomBytes(16).toString("hex"),
    leaseMs,
    gen: genText(0),
  };
  const text = JSON.stringify(info);
  for (;;) {
    const fd = tryCreate(path, text);
    if (fd !== undefined) return holdLease(path, text, leaseMs, fd);
    const found = readText(path);
    if (found !== undefined && staleReason(path, found, { leaseMs, now: Date.now(), isAlive })) {
      breakStale(path, found, { leaseMs, isAlive });
      continue;
    }
    if (now() >= deadline) {
      const other = found === undefined ? undefined : parseInfo(found);
      const who = other ? ` (pid ${other.pid}, ${other.purpose})` : "";
      throw new BusyError(opts.waitMs, `Another zshield-mcp process holds the wallet lock${who}.`);
    }
    await new Promise((r) => setTimeout(r, Math.min(POLL_MS, Math.max(1, deadline - now()))));
  }
}

function holdLease(path: string, firstText: string, leaseMs: number, fd: number): Lease {
  let done = false;
  let lost: string | undefined;
  let renewedAt = Date.now();
  let gen = 0;
  let text = firstText;
  const genAt = firstText.indexOf(`"gen":"`) + `"gen":"`.length;
  const closeFd = () => {
    try {
      closeSync(fd);
    } catch {
      // Already closed.
    }
  };
  /** Whether the path still names the file this lease created, by inode and by content. */
  const stillMine = (): boolean => {
    // A waiter that is judging this file moves it aside for a moment and puts it back if the
    // holder turns out to be alive, so an absent file is looked for again before it counts.
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const a = fstatSync(fd);
        const b = statSync(path);
        return a.ino === b.ino && a.dev === b.dev && readFileSync(path, "utf8") === text;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") return false;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    return false;
  };
  const renew = () => {
    if (done || lost) return;
    // A renewal this late means the process stalled. Another process may judge the lease
    // stale soon, or already has, so this holder stops trusting it. Healthy holders renew
    // every quarter lease, well inside this margin.
    if (Date.now() - renewedAt > leaseMs / 2) {
      lost = "it was not renewed in time";
      return;
    }
    try {
      if (!stillMine()) {
        lost = "another process replaced it";
        return;
      }
      // Bump the counter in place (same size, same inode), then the mtime, then look again:
      // a waiter that moved the file in between leaves a different file at the path.
      const next = genText(++gen);
      writeSync(fd, next, genAt);
      text = text.slice(0, genAt) + next + text.slice(genAt + GEN_WIDTH);
      const t = new Date();
      utimesSync(path, t, t);
      if (!stillMine()) {
        lost = "another process replaced it";
        return;
      }
      renewedAt = t.getTime();
    } catch (e) {
      lost = (e as NodeJS.ErrnoException).code === "ENOENT" ? "the lock file was removed" : "it could not be renewed";
    }
  };
  // The file must already be the one just created, and carry nothing a waiter could have changed.
  if (!stillMine()) lost = "another process replaced it";
  const timer = setInterval(renew, Math.max(50, Math.floor(leaseMs / 4)));
  timer.unref?.();
  return {
    assertHeld() {
      if (done) throw new LeaseLostError("it was already released");
      // Renew now: this also checks the file and how long ago the last renewal was.
      renew();
      if (lost) throw new LeaseLostError(lost);
    },
    release() {
      if (done) return;
      done = true;
      clearInterval(timer);
      try {
        if (stillMine()) unlinkSync(path);
      } catch {
        // Already removed or replaced.
      }
      closeFd();
    },
  };
}
