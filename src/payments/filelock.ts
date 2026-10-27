import { randomBytes } from "node:crypto";
import { closeSync, constants, fsyncSync, linkSync, openSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeSync } from "node:fs";
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
}

/** The holder lost the lease: it stalled past the lease time, or the file was replaced. */
export class LeaseLostError extends Error {
  constructor(detail: string) {
    super(`The wallet lock was lost (${detail}). Nothing more was done.`);
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
 * Why the lock at `path` is stale, or undefined when its holder may still be working.
 * Age is the time since the holder last renewed, read from the file's mtime.
 */
export function staleReason(
  path: string,
  text: string,
  opts: { leaseMs: number; now: number; isAlive: (pid: number) => boolean }
): string | undefined {
  let age: number;
  try {
    age = opts.now - statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
  const info = parseInfo(text);
  if (!info) return age > UNREADABLE_STALE_MS ? "unreadable lock file" : undefined;
  if (info.host === hostname() && !opts.isAlive(info.pid)) return `process ${info.pid} is gone`;
  if (age > opts.leaseMs) return `not renewed for more than ${opts.leaseMs} ms`;
  return undefined;
}

function tryCreate(path: string, text: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return true;
}

/**
 * Remove a stale lock without removing a fresh one that replaced it: move it aside, then
 * check it is still the file that was judged stale. If not, put it back.
 */
function breakStale(path: string, judged: string): void {
  const aside = `${path}.stale-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    renameSync(path, aside);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  let moved = "";
  try {
    moved = readFileSync(aside, "utf8");
  } catch {
    moved = "";
  }
  if (moved !== judged) {
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
  };
  const text = JSON.stringify(info);
  for (;;) {
    if (tryCreate(path, text)) return holdLease(path, text, leaseMs);
    const found = readText(path);
    if (found !== undefined && staleReason(path, found, { leaseMs, now: Date.now(), isAlive })) {
      breakStale(path, found);
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

function holdLease(path: string, text: string, leaseMs: number): Lease {
  let done = false;
  let lost: string | undefined;
  let renewedAt = Date.now();
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
      if (readFileSync(path, "utf8") !== text) {
        lost = "another process replaced it";
        return;
      }
      const t = new Date();
      utimesSync(path, t, t);
      renewedAt = t.getTime();
    } catch (e) {
      lost = (e as NodeJS.ErrnoException).code === "ENOENT" ? "the lock file was removed" : "it could not be renewed";
    }
  };
  const timer = setInterval(renew, Math.max(50, Math.floor(leaseMs / 4)));
  timer.unref?.();
  return {
    assertHeld() {
      if (done) throw new LeaseLostError("it was already released");
      // Renew now: this also checks the token and how long ago the last renewal was.
      renew();
      if (lost) throw new LeaseLostError(lost);
    },
    release() {
      if (done) return;
      done = true;
      clearInterval(timer);
      try {
        if (readFileSync(path, "utf8") === text) unlinkSync(path);
      } catch {
        // Already removed or replaced.
      }
    },
  };
}
