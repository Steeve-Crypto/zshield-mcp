import { spawn } from "node:child_process";
import { READ_LOCK_WAIT_MS, lockWaitWithin, missingPerl, wrapForWallet, wrapperRefusal, type Wrapped } from "./walletlock.js";

/** What a bounded sync achieved. */
export interface SyncResult {
  /** The sync reached the chain tip before the time ran out */
  complete: boolean;
  /** Last height the sync reported scanned to, when it reported one */
  scannedHeight?: number;
  elapsedMs: number;
  /** Why it is not complete, when it is not */
  detail?: string;
}

export interface SyncOptions {
  timeoutMs: number;
  /** How often to ask `sync status`. */
  pollMs?: number;
  /** How long `quit` may take to save the wallet before the process is killed. */
  quitGraceMs?: number;
  /** Run under the OS wallet lock on this file (see walletlock.ts). */
  lockFile?: string;
}

/**
 * Runs zingo-cli's interactive prompt on the wallet, asks for `sync status` every
 * `pollMs`, and quits as soon as the sync is complete or `timeoutMs` has passed. Quit
 * saves the wallet; the process is killed only if quit itself hangs. Injectable for tests.
 */
export type WalletSyncer = (bin: string, args: string[], opts: SyncOptions) => Promise<SyncResult>;

export const DEFAULT_SYNC_POLL_MS = 2_000;
export const DEFAULT_QUIT_GRACE_MS = 15_000;

export interface SyncStatus {
  percentage: number;
  syncStartHeight: number;
  allScanned: boolean;
  scannedHeight?: number;
}

/**
 * Parse every `sync status` JSON block in zingo-cli prompt output, oldest first. Each
 * holds scan_ranges, sync_start_height and percentage_total_blocks_scanned.
 */
export function parseSyncStatuses(out: string): SyncStatus[] {
  const found: SyncStatus[] = [];
  for (const m of out.matchAll(/\{\s*"scan_ranges"[\s\S]*?"total_outputs"\s*:\s*\d+\s*\}/g)) {
    let j: {
      scan_ranges?: { priority?: string; end_block?: string | number }[];
      sync_start_height?: number;
      percentage_total_blocks_scanned?: number;
    };
    try {
      j = JSON.parse(m[0]);
    } catch {
      continue;
    }
    const ranges = Array.isArray(j.scan_ranges) ? j.scan_ranges : [];
    const ends = ranges.map((r) => Number(r.end_block)).filter((n) => Number.isFinite(n));
    found.push({
      percentage: Number(j.percentage_total_blocks_scanned ?? 0),
      syncStartHeight: Number(j.sync_start_height ?? 0),
      allScanned: ranges.length > 0 && ranges.every((r) => r.priority === "Scanned"),
      scannedHeight: ends.length ? Math.max(...ends) : undefined,
    });
  }
  return found;
}

/**
 * A sync is done when the session has started (sync_start_height above 0), every scan
 * range is Scanned, and the percentage is 100. Right after launch zingo-cli reports
 * ranges Scanned with 0% and a start height of 0, which is not done.
 */
export function syncComplete(s: SyncStatus): boolean {
  return s.syncStartHeight > 0 && s.allScanned && s.percentage >= 100;
}

export const defaultSyncer: WalletSyncer = (bin, args, opts) =>
  new Promise((resolve) => {
    const started = Date.now();
    const pollMs = opts.pollMs ?? DEFAULT_SYNC_POLL_MS;
    const graceMs = opts.quitGraceMs ?? DEFAULT_QUIT_GRACE_MS;
    let out = "";
    let complete = false;
    let quitting = false;
    let detail: string | undefined;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let wrapped: Wrapped | undefined;
    if (opts.lockFile) {
      try {
        wrapped = wrapForWallet(bin, args, { lockFile: opts.lockFile, waitMs: lockWaitWithin(READ_LOCK_WAIT_MS, opts.timeoutMs) });
      } catch (e) {
        resolve({ complete: false, elapsedMs: 0, detail: e instanceof Error ? e.message : String(e) });
        return;
      }
    }
    const child = spawn(wrapped?.bin ?? bin, wrapped?.args ?? args, { stdio: ["pipe", "pipe", "pipe"] });
    const write = (line: string) => {
      if (child.stdin.writable) child.stdin.write(`${line}\n`);
    };
    const quit = (why?: string) => {
      if (quitting) return;
      quitting = true;
      if (why) detail = why;
      clearInterval(poll);
      clearTimeout(deadline);
      write("quit");
      child.stdin.end();
      killTimer = setTimeout(() => child.kill("SIGKILL"), graceMs);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(deadline);
      if (killTimer) clearTimeout(killTimer);
      const last = parseSyncStatuses(out).at(-1);
      const refusal = wrapped ? wrapperRefusal(wrapped.nonce, out) : undefined;
      if (refusal) detail = refusal.message;
      resolve({
        complete,
        scannedHeight: last?.scannedHeight,
        elapsedMs: Date.now() - started,
        ...(complete ? {} : { detail: detail ?? "zingo-cli exited before the sync finished" }),
      });
    };
    const onData = (chunk: Buffer) => {
      out += chunk.toString();
      if (out.length > 1_000_000) out = out.slice(-200_000);
      if (!complete && !quitting) {
        const last = parseSyncStatuses(out).at(-1);
        if (last && syncComplete(last)) {
          complete = true;
          quit();
        }
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.stdin.on("error", () => {
      // The prompt exited first; the exit handler reports it.
    });
    child.on("error", (e) => {
      detail = (wrapped ? missingPerl(e as NodeJS.ErrnoException)?.message : undefined) ?? `zingo-cli could not start: ${e.message}`;
      finish();
    });
    child.on("close", finish);
    const poll = setInterval(() => write("sync status"), pollMs);
    const deadline = setTimeout(() => quit(`sync did not finish within ${opts.timeoutMs} ms`), opts.timeoutMs);
  });
