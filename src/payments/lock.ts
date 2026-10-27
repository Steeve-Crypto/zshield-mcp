import { acquireFileLock, type Lease } from "./filelock.js";

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

const byDir = new Map<string, SendLock>();

/** The in-process lock for one payment store. */
export function sendLockFor(stateDir: string): SendLock {
  let lock = byDir.get(stateDir);
  if (!lock) byDir.set(stateDir, (lock = new SendLock()));
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

/** The full wallet lock: this process's lock for the store, then the shared lease. */
export interface WalletLock extends Lease {}

/**
 * Take this process's lock for the payment store, then the lease file in it, which every
 * zshield-mcp process on the same wallet also takes. Throws BusyError after `waitMs` in total.
 */
export async function acquireWalletLock(
  store: { dir: string },
  waitMs: number,
  purpose: string,
  now: () => number = Date.now
): Promise<WalletLock> {
  const start = now();
  const releaseLocal = await sendLockFor(store.dir).acquire(waitMs);
  try {
    const lease = await acquireFileLock(store.dir, { waitMs: Math.max(0, waitMs - (now() - start)), purpose });
    return {
      assertHeld: () => lease.assertHeld(),
      release: () => {
        lease.release();
        releaseLocal();
      },
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
export async function withWalletRead<T>(store: { dir: string }, purpose: string, fn: (offline: boolean) => Promise<T>): Promise<T> {
  let lock: WalletLock | undefined;
  try {
    lock = await acquireWalletLock(store, 0, purpose);
  } catch (e) {
    if (e instanceof BusyError) return fn(true);
    throw e;
  }
  try {
    return await fn(false);
  } finally {
    lock.release();
  }
}
