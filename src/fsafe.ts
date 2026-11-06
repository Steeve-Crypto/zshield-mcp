import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { dirname, join, resolve, parse } from "node:path";

/**
 * File helpers for the audit log and the payment store. They refuse symlinks and files
 * owned by another user, and tighten loose modes, so a planted or shared file cannot
 * redirect or forge what the server reads and writes.
 */

const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

export class UnsafePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafePathError";
  }
}

function myUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

/** Throws unless `st` is owned by this process's user. A no-op where uids do not exist. */
function checkOwner(path: string, st: fs.Stats): void {
  const uid = myUid();
  if (uid !== undefined && st.uid !== uid) {
    throw new UnsafePathError(`${path} is owned by uid ${st.uid}, not this user (${uid}).`);
  }
}

/** Flush a directory entry to disk. Windows cannot open a directory for fsync; NTFS journals it. */
export function fsyncDir(dir: string): void {
  if (process.platform === "win32") return;
  dir = dirname(safeRecordPath(join(dir, ".flush")));
  const fd = fs.openSync(dir, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Make sure `dir` is a private directory this user owns: create it (mode 0700, parents
 * fsynced) if missing, refuse a symlink, a non-directory, or another owner, and tighten
 * group or other bits to 0700. Returns a note when a mode was repaired.
 */
export function ensurePrivateDir(dir: string): string | undefined {
  dir = safeRecordPath(dir);
  const missing: string[] = [];
  for (let d = dir; !fs.existsSync(d); d = dirname(d)) {
    missing.unshift(d);
    if (dirname(d) === d) break;
  }
  if (missing.length > 0) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const d of missing) fsyncDir(dirname(d));
  }
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink()) throw new UnsafePathError(`${dir} is a symlink. Point the setting at the real directory.`);
  if (!st.isDirectory()) throw new UnsafePathError(`${dir} is not a directory.`);
  checkOwner(dir, st);
  if (process.platform !== "win32" && (st.mode & 0o077) !== 0) {
    fs.chmodSync(dir, 0o700);
    return `${dir} was mode ${(st.mode & 0o777).toString(8)}; set to 700.`;
  }
  return undefined;
}

/**
 * Check one existing file: refuse a symlink, a non-regular file, or another owner, and
 * tighten a loose mode to 0600. Missing files are fine. Returns a note when repaired.
 */
export function checkPrivateFile(path: string): string | undefined {
  path = safeRecordPath(path);
  let st: fs.Stats;
  try {
    st = fs.lstatSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  if (st.isSymbolicLink()) throw new UnsafePathError(`${path} is a symlink.`);
  if (!st.isFile()) throw new UnsafePathError(`${path} is not a regular file.`);
  checkOwner(path, st);
  if (process.platform !== "win32" && (st.mode & 0o077) !== 0) {
    fs.chmodSync(path, 0o600);
    return `${path} was mode ${(st.mode & 0o777).toString(8)}; set to 600.`;
  }
  return undefined;
}

/** Validate an open descriptor: a regular file owned by this user, mode tightened to 0600. */
function checkFd(fd: number, path: string): void {
  const st = fs.fstatSync(fd);
  if (!st.isFile()) throw new UnsafePathError(`${path} is not a regular file.`);
  checkOwner(path, st);
  if (process.platform !== "win32" && (st.mode & 0o077) !== 0) fs.fchmodSync(fd, 0o600);
}

/**
 * Append `data` to `file` and fsync it. Never follows a symlink, refuses a file owned by
 * another user, and tightens a loose mode. A new file is created 0600 and its directory
 * entry fsynced.
 */
export function appendPrivate(file: string, data: string): void {
  file = safeRecordPath(file);
  const isNew = !fs.existsSync(file);
  const fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_CREAT | NOFOLLOW, 0o600);
  try {
    checkFd(fd, file);
    // One buffer, one write call: a short write is an error and is never finished with a
    // second call, which could land in the middle of another process's row. If the file
    // does not end in a newline (a crash left a partial row) this row starts on a new line.
    const size = fs.fstatSync(fd).size;
    const last = Buffer.alloc(1);
    const needsLead = size > 0 && fs.readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 0x0a;
    const buf = Buffer.from(needsLead ? `\n${data}` : data, "utf8");
    try {
      const n = fs.writeSync(fd, buf, 0, buf.length);
      if (n !== buf.length) throw Object.assign(new Error(`short write to ${file}`), { code: "EIO" });
    } catch (e) {
      undoPartialAppend(fd, size, buf);
      throw e;
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (isNew) fsyncDir(dirname(file));
}

/** Cut off what a failed append left, but only bytes that are exactly the start of our own row. */
function undoPartialAppend(fd: number, size: number, buf: Buffer): void {
  try {
    const now = fs.fstatSync(fd).size;
    if (now <= size || now > size + buf.length) return;
    const got = Buffer.alloc(now - size);
    fs.readSync(fd, got, 0, got.length, size);
    if (got.equals(buf.subarray(0, got.length))) fs.ftruncateSync(fd, size);
  } catch {
    // Best effort: the next append starts on a new line either way.
  }
}

/** Read a small private file without following a symlink. Undefined when missing. */
export function readPrivate(path: string, maxBytes: number): string | undefined {
  path = safeRecordPath(path);
  let fd: number;
  try {
    // O_NONBLOCK: a planted FIFO must not block the event loop before we can reject it.
    const nonblock = fs.constants.O_NONBLOCK ?? 0;
    fd = fs.openSync(path, fs.constants.O_RDONLY | NOFOLLOW | nonblock);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new UnsafePathError(`${path} is not a regular file.`);
    checkOwner(path, st);
    if (st.size > maxBytes) throw new UnsafePathError(`${path} is larger than ${maxBytes} bytes.`);
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = fs.readSync(fd, buf, off, st.size - off, off);
      if (n === 0) break;
      off += n;
    }
    return buf.subarray(0, off).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function writeTemp(dir: string, data: string): string {
  dir = dirname(safeRecordPath(join(dir, "placeholder")));
  const tmp = join(dir, `.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o600);
  try {
    const buf = Buffer.from(data, "utf8");
    let off = 0;
    while (off < buf.length) {
      const n = fs.writeSync(fd, buf, off, buf.length - off);
      if (n <= 0) throw Object.assign(new Error("State write made no progress."), { code: "EIO" });
      off += n;
    }
    fs.fsyncSync(fd);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* retain original failure */ }
    throw e;
  } finally {
    fs.closeSync(fd);
  }
  return tmp;
}

/**
 * Create `dir/name` holding `data`, only if no such name exists. The content is written
 * and fsynced under a temporary name first, then hard linked into place, so a reader
 * never sees a partial file and exactly one of several racing writers wins.
 * Returns false when the name already existed.
 */
export function createExclusive(dir: string, name: string, data: string): boolean {
  dir = dirname(safeRecordPath(join(dir, name)));
  const tmp = writeTemp(dir, data);
  try {
    fs.linkSync(tmp, join(dir, name));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Already gone.
    }
  }
  try {
    fsyncDir(dir);
  } catch (e) {
    // Already linked and visible to other processes. Rolling back would drop their
    // reservations or leave a caller believing the key was free when it is not.
    if (fs.existsSync(join(dir, name))) return true;
    throw e;
  }
  return true;
}

/** Replace `dir/name` with `data` atomically (write, fsync, rename, fsync the dir). */
export function replaceAtomic(dir: string, name: string, data: string): void {
  dir = dirname(safeRecordPath(join(dir, name)));
  const tmp = writeTemp(dir, data);
  fs.renameSync(tmp, join(dir, name));
  fsyncDir(dir);
}

/**
 * Refuse to rely on `path` when a directory above it lets another local user swap what it
 * names: a group- or other-writable directory without the sticky bit, or one owned by a
 * user who is neither root nor this one. Symlinks are resolved first, and a path that does
 * not exist yet is judged by its nearest existing parent. A no-op on Windows. `me` is for tests.
 */
export function assertSafeAncestors(path: string, me: number | undefined = myUid()): void {
  if (process.platform === "win32" || me === undefined) return;
  validateComponents(dirname(resolve(path)), me);
}

function checkNamespace(path: string, st: fs.Stats, me: number): void {
  if (st.uid !== 0 && st.uid !== me) throw new UnsafePathError(`${path} is owned by uid ${st.uid}, who could swap the configured namespace.`);
  if (!st.isSymbolicLink() && (st.mode & 0o022) && !(st.mode & 0o1000)) throw new UnsafePathError(`${path} is writable by other users and not sticky.`);
}

/** Judge lexical components BEFORE following links, then judge their targets too.
 * Every accepted namespace component is controlled by root or this service's uid.
 * Sticky shared directories protect the next service-owned component from other uids.
 * No other local user can swap a component between validation and open; same-uid/root
 * compromise remains outside this boundary. Root-owned OS aliases (/var on macOS)
 * are supported, but attacker-owned aliases to an otherwise safe target are refused.
 */
function validateComponents(dir: string, me: number): void {
  const root = parse(dir).root;
  let cur = root;
  for (const part of ["", ...dir.slice(root.length).split(/[\\/]/).filter(Boolean)]) {
    if (part) cur = join(cur, part);
    let st: fs.Stats;
    try { st = fs.lstatSync(cur); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") break;
      throw e;
    }
    checkNamespace(cur, st, me);
    const old = recordParents.get(cur);
    if (old) {
      const real = fs.realpathSync(cur), now = fs.statSync(real);
      if (old.real !== real || old.dev !== now.dev || old.ino !== now.ino) throw new UnsafePathError("A record ancestor no longer matches its pinned namespace.");
    }
    if (st.isSymbolicLink()) {
      const real = fs.realpathSync(cur);
      // realpath contains no links. Check the entire resolved chain, not just its leaf.
      for (let p = real; ; p = dirname(p)) {
        const target = fs.lstatSync(p);
        checkNamespace(p, target, me);
        if (!target.isDirectory()) throw new UnsafePathError("A record ancestor is not a directory.");
        if (dirname(p) === p) break;
      }
    } else if (!st.isDirectory()) throw new UnsafePathError("A record ancestor is not a directory.");
  }
}

const recordParents = new Map<string, { real: string; dev: number; ino: number }>();
/** Retain canonical parent identity; runtime operations use the canonical namespace.
 * Missing suffixes are resolved beneath the nearest existing, checked parent. Pins
 * survive for the process lifetime, so retargeting an accepted alias fails closed.
 */
export function safeRecordPath(path: string): string {
  if (process.platform === "win32") return path;
  const absolute = resolve(path), parent = dirname(absolute);
  assertSafeAncestors(absolute);
  let existing = parent;
  while (!fs.existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
  const real = fs.realpathSync(existing), st = fs.statSync(real);
  const old = recordParents.get(existing);
  if (old && (old.real !== real || old.dev !== st.dev || old.ino !== st.ino)) throw new UnsafePathError("A record directory no longer matches its pinned namespace.");
  if (!old) recordParents.set(existing, { real, dev: st.dev, ino: st.ino });
  return join(real, absolute.slice(existing.length));
}
