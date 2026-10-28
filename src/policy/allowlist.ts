import fs from "node:fs";
import type { AllowlistFile, RecipientEntry } from "../types.js";
import { PolicyError } from "./caps.js";

/** The largest allow-list file read. A bigger one is refused, not read. */
export const MAX_ALLOWLIST_BYTES = 1024 * 1024;
/** The most entries an allow-list may have. */
export const MAX_ALLOWLIST_ENTRIES = 10_000;

/** The last list read per path, kept while the file's identity, size, and mtime stay the same. */
const cache = new Map<string, { sig: string; entries: RecipientEntry[] }>();

function why(e: unknown): string {
  const code = (e as NodeJS.ErrnoException)?.code;
  if (typeof code === "string") return code;
  return e instanceof SyntaxError ? "not valid JSON" : "unreadable";
}

/** A test seam: runs between the check and the open. */
export const hooks: { beforeOpen?: () => void } = {};

const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

/**
 * Refuse an allow-list file another local user could have swapped or edited: a symlink,
 * a non-regular file, one owned by someone other than this user or root, or one that is
 * group- or other-writable. Modes and owners mean nothing on Windows.
 */
function checkListStat(st: fs.Stats): void {
  if (st.isSymbolicLink()) throw new PolicyError("ALLOWLIST_UNAVAILABLE", "The allow-list path is a symlink. Point the setting at the real file.");
  if (!st.isFile()) throw new PolicyError("ALLOWLIST_UNAVAILABLE", "The allow-list path is not a regular file.");
  if (process.platform === "win32" || typeof process.getuid !== "function") return;
  if (st.uid !== process.getuid() && st.uid !== 0) {
    throw new PolicyError("ALLOWLIST_UNAVAILABLE", "The allow-list file is owned by another user.");
  }
  if ((st.mode & 0o022) !== 0) {
    throw new PolicyError("ALLOWLIST_UNAVAILABLE", "The allow-list file is writable by group or other users. Run: chmod go-w on it.");
  }
}

/** Startup check: a missing file is left to the first call; an unsafe one stops the server. */
export function assertAllowlistFileSafe(path: string): void {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(path);
  } catch {
    return;
  }
  checkListStat(st);
}

/**
 * Read the allow-list. Never follows a symlink. The opened descriptor must be the file
 * that was checked (same device, inode, owner, and mode). Cached by file identity, size,
 * and mtime, so repeated calls cost one stat; a changed file is read again. Bounded in
 * bytes and entries. Errors name neither the path nor the file content.
 */
export function loadAllowlist(path: string): RecipientEntry[] {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(path);
  } catch (e) {
    throw new PolicyError("ALLOWLIST_UNAVAILABLE", `Cannot read the allow-list file: ${why(e)}.`);
  }
  checkListStat(st);
  if (st.size > MAX_ALLOWLIST_BYTES) {
    throw new PolicyError("ALLOWLIST_UNAVAILABLE", `The allow-list file is larger than ${MAX_ALLOWLIST_BYTES} bytes.`);
  }
  const sig = `${st.dev}:${st.ino}:${st.mode}:${st.uid}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
  const hit = cache.get(path);
  if (hit && hit.sig === sig) return hit.entries;

  let parsed: AllowlistFile;
  try {
    hooks.beforeOpen?.();
    const fd = fs.openSync(path, fs.constants.O_RDONLY | NOFOLLOW);
    try {
      const open = fs.fstatSync(fd);
      if (open.dev !== st.dev || open.ino !== st.ino || open.uid !== st.uid || open.mode !== st.mode) {
        throw new PolicyError("ALLOWLIST_UNAVAILABLE", "The allow-list file changed while it was being opened.");
      }
      const buf = Buffer.alloc(MAX_ALLOWLIST_BYTES + 1);
      let n = 0;
      for (let r; n < buf.length && (r = fs.readSync(fd, buf, n, buf.length - n, null)) > 0; ) n += r;
      if (n > MAX_ALLOWLIST_BYTES) throw Object.assign(new Error("too large"), { code: "EFBIG" });
      parsed = JSON.parse(buf.subarray(0, n).toString("utf8")) as AllowlistFile;
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    if (e instanceof PolicyError) throw e;
    throw new PolicyError("ALLOWLIST_UNAVAILABLE", `Cannot read the allow-list file: ${why(e)}.`);
  }
  if (!parsed?.recipients || !Array.isArray(parsed.recipients)) {
    throw new PolicyError("ALLOWLIST_UNAVAILABLE", 'The allow-list file must contain a "recipients" array.');
  }
  if (parsed.recipients.length > MAX_ALLOWLIST_ENTRIES) {
    throw new PolicyError("ALLOWLIST_UNAVAILABLE", `The allow-list has more than ${MAX_ALLOWLIST_ENTRIES} entries.`);
  }
  const entries = parsed.recipients.filter((r) => typeof r?.address === "string" && r.address.length > 0);
  cache.set(path, { sig, entries });
  if (cache.size > 16) cache.delete(cache.keys().next().value!);
  return entries;
}

export function assertRecipientAllowed(
  recipient: string,
  allowlist: RecipientEntry[]
): RecipientEntry {
  const hit = allowlist.find((r) => r.address === recipient);
  if (!hit) {
    // The recipient is not repeated here; it is already in the audit row's recipient field.
    throw new PolicyError("NOT_ALLOWLISTED", "Recipient is not on the allow-list. Add it to the allow-list file and restart.");
  }
  return hit;
}

export function isRecipientAllowed(recipient: string, allowlist: RecipientEntry[]): boolean {
  return allowlist.some((r) => r.address === recipient);
}
