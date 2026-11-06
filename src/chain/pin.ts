import fs from "node:fs";
import { resolve } from "node:path";

/**
 * The wallet directory, pinned at startup: its real path and its device and inode. zingo-cli
 * is given the real path, and every send checks that the configured path still leads to
 * the same directory, so a swapped symlink or directory cannot move the keys to another
 * wallet while the lock and payment store stay with this one.
 */
export interface DirPin {
  path: string;
  dev: bigint;
  ino: bigint;
}

const pins = new Map<string, DirPin>();

/** Pin `dir` once. A later call for the same path returns the first pin. Throws when the directory is missing. */
export function pinDir(dir: string): DirPin {
  const key = resolve(dir);
  const old = pins.get(key);
  if (old) return old;
  const path = fs.realpathSync(key);
  const st = fs.statSync(path, { bigint: true });
  if (!st.isDirectory()) throw new Error("The wallet path is not a directory.");
  const pin = { path, dev: st.dev, ino: st.ino };
  pins.set(key, pin);
  return pin;
}

/** Throws unless `dir` still resolves to the pinned directory. */
export function checkPin(dir: string, pin: DirPin): void {
  let same = false;
  try {
    const real = fs.realpathSync(resolve(dir));
    const st = fs.statSync(pin.path, { bigint: true });
    same = real === pin.path && st.dev === pin.dev && st.ino === pin.ino;
  } catch {
    same = false;
  }
  if (!same) throw new Error("The wallet directory no longer resolves to the directory pinned at startup.");
}

/** Forget every pin. For tests. */
export function resetPins(): void {
  pins.clear();
}
