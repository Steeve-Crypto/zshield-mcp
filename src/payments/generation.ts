import fs from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createExclusive, ensurePrivateDir, readPrivate, replaceAtomic, UnsafePathError } from "../fsafe.js";

/**
 * The store generation (F-91): one small file that every writer of a payment record
 * changes before it writes, so a reader learns what changed by reading one file instead
 * of every call. Like the SQLite file change counter, it says whether anything changed;
 * unlike it, it also names what changed, for a bounded window of recent writes.
 *
 * It lives at calls/zshield-generation/state.json:
 *   { v: 1, epoch, gen, head, recent: [[gen, name, hash], ...] }
 * `gen` counts writes. `head` is a hash chain over every write in this epoch, seeded by
 * a random epoch, and `recent` holds the last RECENT_WINDOW writes with the chain value
 * after each. A reader that cached the totals at (epoch, gen, head) trusts its cache only
 * when the file shows the same epoch and the entry for its own `gen` with the same chain
 * value; it then re-reads exactly the names in the newer entries. Anything else (a missing
 * or unreadable file, another epoch, a lower gen, a different chain value at its gen, its
 * gen older than the window) makes it rebuild from every record. A restored snapshot
 * either lowers `gen` or, once new writes pass the old value, carries different random
 * chain values, so a restore can never look like a continuation.
 *
 * Ordering. A writer announces BEFORE it writes the record, and a charge is announced
 * again after it is written. A crash between the two steps leaves an announcement with
 * no new record, which only makes the next reader re-read an unchanged call. A record
 * is never visible to another process before its announcement is, so a reader that saw
 * a given generation, and read the named calls after it, has seen every write announced
 * up to it. Records are only written under the exclusive wallet lock when they carry a
 * charge, and caches are only updated under that lock, so no charge can be in flight
 * while a reader re-reads.
 *
 * When the announcement cannot be written (ENOSPC, EIO) the writer removes the file
 * instead, which makes every reader rebuild in full, and only then writes the record.
 * When even that fails, the record is not written. Nothing here is ever trusted to be
 * durable: after a crash every process starts with an empty cache and reads every record.
 *
 * The folder name is a valid call id to older versions, and its files are not valid call
 * events, so an older binary that scans the calls (every older spending check and store
 * open) refuses instead of writing charges this file does not announce.
 */

export const GENERATION_DIR = "zshield-generation";
const STATE = "state.json";
const FORMAT = "format.json";
/** How many recent writes the file names. Bounds its size (about 40 KB). */
export const RECENT_WINDOW = 512;
const MAX_BYTES = 64 * 1024;
const HEX32 = /^[a-f0-9]{32}$/;
/** Names short enough to keep the file bounded. Any other write is entered as "*": rebuild. */
const NAME = /^[A-Za-z0-9_-][A-Za-z0-9._%-]{0,63}$/;
export const UNNAMED = "*";

export type Generation = { epoch: string; gen: number; head: string; recent: [number, string, string][] };
/** A point a reader validated its cache at. */
export type Mark = { epoch: string; gen: number; head: string };

export function generationDir(storeDir: string): string {
  return join(storeDir, "calls", GENERATION_DIR);
}

const chain = (prev: string, gen: number, name: string, nonce: string) =>
  createHash("sha256").update(`${prev}\n${gen}\n${name}\n${nonce}`).digest("hex").slice(0, 32);

function parse(raw: string): Generation | undefined {
  let g: unknown;
  try { g = JSON.parse(raw); } catch { return undefined; }
  const o = g as Record<string, unknown>;
  if (!o || typeof o !== "object" || o.v !== 1 || typeof o.epoch !== "string" || !HEX32.test(o.epoch) || typeof o.head !== "string" || !HEX32.test(o.head)) return undefined;
  if (typeof o.gen !== "number" || !Number.isSafeInteger(o.gen) || o.gen < 0 || !Array.isArray(o.recent) || o.recent.length > RECENT_WINDOW) return undefined;
  const recent = o.recent as unknown[];
  for (let i = 0; i < recent.length; i++) {
    const e = recent[i];
    if (!Array.isArray(e) || e.length !== 3 || e[0] !== o.gen - (recent.length - 1 - i) || typeof e[1] !== "string" || !(NAME.test(e[1]) || e[1] === UNNAMED) || typeof e[2] !== "string" || !HEX32.test(e[2])) return undefined;
  }
  if (recent.length && (recent[recent.length - 1] as string[])[2] !== o.head) return undefined;
  return { epoch: o.epoch, gen: o.gen, head: o.head, recent: recent as [number, string, string][] };
}

/**
 * The current generation, or undefined when it is missing or cannot be trusted (unreadable,
 * malformed, not a private regular file). Undefined always means: rebuild in full.
 */
export function readGeneration(storeDir: string): Generation | undefined {
  let raw: string | undefined;
  try { raw = readPrivate(join(generationDir(storeDir), STATE), MAX_BYTES); } catch { return undefined; }
  return raw === undefined ? undefined : parse(raw);
}

/**
 * What changed since `mark`: the names written after it, or undefined when the cache at
 * `mark` cannot be continued and must be rebuilt.
 */
export function changedSince(g: Generation | undefined, mark: Mark | undefined): string[] | undefined {
  if (!g || !mark || g.epoch !== mark.epoch || g.gen < mark.gen) return undefined;
  if (g.gen === mark.gen) return g.head === mark.head ? [] : undefined;
  const first = g.gen - g.recent.length + 1;
  if (mark.gen < first) return undefined;
  if (g.recent[mark.gen - first][2] !== mark.head) return undefined;
  return [...new Set(g.recent.slice(mark.gen - first + 1).map((e) => e[1]))];
}

export const markOf = (g: Generation): Mark => ({ epoch: g.epoch, gen: g.gen, head: g.head });

/**
 * Announce a write of `name` (a call folder name, or "spending-budget"). A name too long
 * for the file is entered as UNNAMED, which makes every reader rebuild in full. Call it before
 * the write, and for a charge again after it. Throws only when the write must not happen:
 * the announcement could not be made and the generation could not be invalidated either.
 */
export function announce(storeDir: string, name: string): void {
  if (!NAME.test(name)) name = UNNAMED;
  const dir = generationDir(storeDir);
  try {
    ensurePrivateDir(dir);
    // A real call folder of that name would be mixed with this one. Never write into it.
    if (fs.existsSync(join(dir, "intent.json"))) throw new UnsafePathError("A call record occupies the store generation folder.");
    if (!fs.existsSync(join(dir, FORMAT))) createExclusive(dir, FORMAT, JSON.stringify({ zshield_generation_format: 1 }));
    let raw: string | undefined;
    try { raw = readPrivate(join(dir, STATE), MAX_BYTES); } catch (e) { if (e instanceof UnsafePathError) throw e; raw = undefined; }
    const prior = raw === undefined ? undefined : parse(raw);
    // Missing or untrustworthy: start a new epoch. Every reader then rebuilds in full.
    const base: Generation = prior ?? { epoch: randomBytes(16).toString("hex"), gen: 0, head: randomBytes(16).toString("hex"), recent: [] };
    const gen = base.gen + 1;
    if (!Number.isSafeInteger(gen)) throw new Error("Store generation out of range.");
    const head = chain(base.head, gen, name, randomBytes(8).toString("hex"));
    const recent = [...base.recent, [gen, name, head] as [number, string, string]].slice(-RECENT_WINDOW);
    replaceAtomic(dir, STATE, JSON.stringify({ v: 1, epoch: base.epoch, gen, head, recent }));
  } catch (e) {
    if (e instanceof UnsafePathError) throw e;
    invalidate(storeDir, e);
  }
}

/**
 * Remove the generation so every reader rebuilds in full. Removing a file needs no free
 * space. Throws the original failure when even that is impossible.
 */
function invalidate(storeDir: string, cause: unknown): void {
  try {
    fs.unlinkSync(join(generationDir(storeDir), STATE));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      // Nothing to invalidate, unless the folder itself could not be made: then there is
      // still no generation, and readers rebuild in full.
      return;
    }
    throw cause;
  }
}
