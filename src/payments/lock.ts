import type { ChainAdapter } from "../chain/types.js";
import { acquireFileLock } from "./filelock.js";

/** How long a send waits for another send on the same wallet before BUSY, by default. */
export const SEND_QUEUE_WAIT_DEFAULT_MS = 10_000;
export const SEND_QUEUE_WAIT_MAX_MS = 600_000;

export class BusyError extends Error {
  constructor(waitedMs: number, detail = "Another payment from this wallet is in progress.") {
    super(`${detail} Waited ${waitedMs} ms. Nothing was sent. Try again shortly.`);
    this.name = "BusyError";
  }
}

/**
 * A mutex with a bounded wait. One holder at a time; others queue in arrival order and
 * give up with BusyError after `waitMs`.
 */
export class SendLock {
  private held = false;
  private readonly waiters: { grant: () => void; done: boolean }[] = [];

  get locked(): boolean {
    return this.held;
  }

  acquire(waitMs: number): Promise<() => void> {
    const release = () => this.release();
    if (!this.held) {
      this.held = true;
      return Promise.resolve(once(release));
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        done: false,
        grant: () => {
          clearTimeout(timer);
          waiter.done = true;
          resolve(once(release));
        },
      };
      const timer = setTimeout(() => {
        waiter.done = true;
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new BusyError(waitMs));
      }, waitMs);
      this.waiters.push(waiter);
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next.grant();
    else this.held = false;
  }
}

function once(fn: () => void): () => void {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    fn();
  };
}

const byWallet = new Map<string, SendLock>();
const byAdapter = new WeakMap<ChainAdapter, SendLock>();

/** The lock for the adapter's wallet. Live adapters share one per wallet directory. */
export function sendLockFor(chain: ChainAdapter): SendLock {
  const id = chain.walletId;
  if (id !== undefined) {
    let lock = byWallet.get(id);
    if (!lock) byWallet.set(id, (lock = new SendLock()));
    return lock;
  }
  let lock = byAdapter.get(chain);
  if (!lock) byAdapter.set(chain, (lock = new SendLock()));
  return lock;
}

/** SEND_QUEUE_WAIT_MS: whole milliseconds from 0 to SEND_QUEUE_WAIT_MAX_MS. */
export function parseSendQueueWait(value: unknown): number {
  const n = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > SEND_QUEUE_WAIT_MAX_MS) {
    throw new Error(`SEND_QUEUE_WAIT_MS must be a whole number from 0 to ${SEND_QUEUE_WAIT_MAX_MS}.`);
  }
  return n;
}

/**
 * The full wallet lock: this process's lock for the wallet, then the lock file in the
 * wallet directory, which other zshield-mcp processes on the same wallet also take.
 * Mock adapters have no directory and use only the in-process lock. Throws BusyError
 * after `waitMs` in total.
 */
export async function acquireWalletLock(
  chain: ChainAdapter,
  waitMs: number,
  purpose: string,
  now: () => number = Date.now
): Promise<() => void> {
  const start = now();
  const releaseLocal = await sendLockFor(chain).acquire(waitMs);
  if (!chain.lockDir) return releaseLocal;
  try {
    const releaseFile = await acquireFileLock(chain.lockDir, { waitMs: Math.max(0, waitMs - (now() - start)), purpose });
    return () => {
      releaseFile();
      releaseLocal();
    };
  } catch (e) {
    releaseLocal();
    throw e;
  }
}

/**
 * Run a read-only wallet call without racing a send or sync. A one-shot zingo-cli run
 * syncs and saves the wallet file, so it takes the wallet lock without waiting. If a
 * send or sync holds the lock, the call reads the wallet file offline instead, as last
 * synced. `fn` gets `offline` set accordingly.
 */
export async function withWalletRead<T>(chain: ChainAdapter, purpose: string, fn: (offline: boolean) => Promise<T>): Promise<T> {
  let release: (() => void) | undefined;
  try {
    release = await acquireWalletLock(chain, 0, purpose);
  } catch (e) {
    if (e instanceof BusyError) return fn(true);
    throw e;
  }
  try {
    return await fn(false);
  } finally {
    release();
  }
}
