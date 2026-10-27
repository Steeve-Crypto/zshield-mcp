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

/**
 * Read the allow-list. Cached by file identity, size, and mtime, so repeated calls cost
 * one stat; a changed file is read again. Bounded in bytes and entries. Errors name
 * neither the path nor the file content.
 */
export function loadAllowlist(path: string): RecipientEntry[] {
  let st: fs.Stats;
  try {
    st = fs.statSync(path);
  } catch (e) {
    throw new PolicyError("ALLOWLIST_UNAVAILABLE", `Cannot read the allow-list file: ${why(e)}.`);
  }
  if (!st.isFile()) throw new PolicyError("ALLOWLIST_UNAVAILABLE", "The allow-list path is not a regular file.");
  if (st.size > MAX_ALLOWLIST_BYTES) {
    throw new PolicyError("ALLOWLIST_UNAVAILABLE", `The allow-list file is larger than ${MAX_ALLOWLIST_BYTES} bytes.`);
  }
  const sig = `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
  const hit = cache.get(path);
  if (hit && hit.sig === sig) return hit.entries;

  let parsed: AllowlistFile;
  try {
    const fd = fs.openSync(path, fs.constants.O_RDONLY);
    try {
      const buf = Buffer.alloc(MAX_ALLOWLIST_BYTES + 1);
      let n = 0;
      for (let r; n < buf.length && (r = fs.readSync(fd, buf, n, buf.length - n, null)) > 0; ) n += r;
      if (n > MAX_ALLOWLIST_BYTES) throw Object.assign(new Error("too large"), { code: "EFBIG" });
      parsed = JSON.parse(buf.subarray(0, n).toString("utf8")) as AllowlistFile;
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
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
