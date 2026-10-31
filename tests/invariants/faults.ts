// Filesystem fault injection for the invariant suite. fsafe.ts and store.ts call fs functions
// as properties of the default `fs` export (fs.fsyncSync, ...), so patching them here
// reaches the production code with no seam.
import fs from "node:fs";
import { mock } from "node:test";

export interface FaultRule {
  /** Which call to fail. `path` is the file the descriptor was opened on, or the rename target. */
  op: "writeSync" | "fsyncSync" | "openSync" | "renameSync" | "linkSync";
  match: (path: string) => boolean;
  code: "EIO" | "ENOSPC" | "EACCES";
  /** Fail only the first matching call (default: every matching call while armed). */
  once?: boolean;
  /** For openSync: fail only opens that create the file (O_CREAT). */
  creatingOnly?: boolean;
  /** For writeSync: write this fraction of the buffer first, then fail (a short write). */
  partial?: number;
}

export interface Faults {
  armed: boolean;
  hits: string[];
  restore(): void;
}

export function injectFault(rule: FaultRule): Faults {
  const paths = new Map<number, string>();
  const f: Faults = { armed: true, hits: [], restore: () => mock.restoreAll() };
  const fail = (what: string) => {
    f.hits.push(what);
    if (rule.once) f.armed = false;
    const e = new Error(`${rule.code}: injected fault at ${what}`) as NodeJS.ErrnoException;
    e.code = rule.code;
    return e;
  };
  const realOpen = fs.openSync;
  const realWrite = fs.writeSync;
  const realFsync = fs.fsyncSync;
  const realRename = fs.renameSync;
  const realLink = fs.linkSync;
  mock.method(fs, "openSync", (...a: Parameters<typeof fs.openSync>) => {
    const p = String(a[0]);
    if (rule.op === "openSync" && f.armed && rule.match(p) && (!rule.creatingOnly || (Number(a[1]) & fs.constants.O_CREAT) !== 0)) throw fail(`openSync ${p}`);
    const fd = realOpen(...a);
    paths.set(fd, p);
    return fd;
  });
  mock.method(fs, "writeSync", (...a: any[]) => {
    const p = paths.get(a[0]) ?? "";
    if (rule.op === "writeSync" && f.armed && rule.match(p)) {
      if (rule.partial !== undefined && Buffer.isBuffer(a[1])) {
        const len = a[3] ?? a[1].length - (a[2] ?? 0);
        (realWrite as any)(a[0], a[1], a[2] ?? 0, Math.max(1, Math.floor(len * rule.partial)));
      }
      throw fail(`writeSync ${p}`);
    }
    return (realWrite as any)(...a);
  });
  mock.method(fs, "fsyncSync", (fd: number) => {
    const p = paths.get(fd) ?? "";
    if (rule.op === "fsyncSync" && f.armed && rule.match(p)) throw fail(`fsyncSync ${p}`);
    return realFsync(fd);
  });
  mock.method(fs, "renameSync", (from: string, to: string) => {
    if (rule.op === "renameSync" && f.armed && rule.match(String(to))) throw fail(`renameSync ${to}`);
    return realRename(from, to);
  });
  mock.method(fs, "linkSync", (from: string, to: string) => {
    if (rule.op === "linkSync" && f.armed && rule.match(String(to))) throw fail(`linkSync ${to}`);
    return realLink(from, to);
  });
  return f;
}
