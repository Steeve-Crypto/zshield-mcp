import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, linkSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { BusyError } from "./lock.js";

/** Name of the lock file in the wallet data directory. */
export const WALLET_LOCK_FILE = ".zshield-wallet.lock";
/**
 * A lock older than this is stale even when its process looks alive. Longer than the
 * longest send (15 minutes) plus a bounded sync, so a slow send is never broken into.
 */
export const LOCK_STALE_MS = 30 * 60_000;
/** A lock file that cannot be parsed is stale once it is this old (a crash mid-write). */
const UNREADABLE_STALE_MS = 10_000;
const POLL_MS = 100;

export interface LockInfo {
  pid: number;
  host: string;
  started: string;
  purpose: string;
  token: string;
}

export interface FileLockOptions {
  /** How long to wait for the lock before BusyError. 0 tries once. */
  waitMs: number;
  purpose: string;
  staleMs?: number;
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

function readInfo(path: string): { text: string; info?: LockInfo } | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  try {
    const info = JSON.parse(text) as LockInfo;
    if (typeof info.pid === "number" && typeof info.started === "string") return { text, info };
  } catch {
    // Unparsable; judged by file age below.
  }
  return { text };
}

/** Why the lock at `path` is stale, or undefined when its holder may still be working. */
export function staleReason(
  path: string,
  found: { text: string; info?: LockInfo },
  opts: { staleMs: number; now: number; isAlive: (pid: number) => boolean }
): string | undefined {
  if (!found.info) {
    let age = 0;
    try {
      age = opts.now - statSync(path).mtimeMs;
    } catch {
      return undefined;
    }
    return age > UNREADABLE_STALE_MS ? "unreadable lock file" : undefined;
  }
  const { info } = found;
  if (info.host === hostname() && !opts.isAlive(info.pid)) return `process ${info.pid} is gone`;
  const age = opts.now - Date.parse(info.started);
  if (!(age <= opts.staleMs)) return `held for more than ${opts.staleMs} ms`;
  return undefined;
}

function tryCreate(path: string, info: LockInfo): boolean {
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
  try {
    writeSync(fd, JSON.stringify(info));
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
 * Take the wallet lock file in `dir`, shared by every zshield-mcp process on the wallet.
 * Created with O_EXCL and mode 0600. A lock whose process is gone (same host) or that is
 * older than `staleMs` is broken. Waits up to `waitMs`, then throws BusyError.
 * Returns a release function that removes the file only if it is still this lock.
 */
export async function acquireFileLock(dir: string, opts: FileLockOptions): Promise<() => void> {
  const path = join(dir, WALLET_LOCK_FILE);
  const now = opts.now ?? Date.now;
  const isAlive = opts.isAlive ?? pidAlive;
  const staleMs = opts.staleMs ?? LOCK_STALE_MS;
  const deadline = now() + opts.waitMs;
  const info: LockInfo = {
    pid: process.pid,
    host: hostname(),
    started: new Date(now()).toISOString(),
    purpose: opts.purpose,
    token: randomBytes(8).toString("hex"),
  };
  for (;;) {
    info.started = new Date(now()).toISOString();
    const text = JSON.stringify(info);
    if (tryCreate(path, info)) return releaser(path, text);
    const found = readInfo(path);
    if (found && staleReason(path, found, { staleMs, now: now(), isAlive })) {
      breakStale(path, found.text);
      continue;
    }
    if (now() >= deadline) {
      const who = found?.info ? ` (pid ${found.info.pid}, ${found.info.purpose})` : "";
      throw new BusyError(opts.waitMs, `Another zshield-mcp process holds the wallet lock${who}.`);
    }
    await new Promise((r) => setTimeout(r, Math.min(POLL_MS, Math.max(1, deadline - now()))));
  }
}

function releaser(path: string, text: string): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    try {
      if (readFileSync(path, "utf8") === text) unlinkSync(path);
    } catch {
      // Already removed or replaced.
    }
  };
}
