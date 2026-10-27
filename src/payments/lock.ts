import type { ChainAdapter } from "../chain/types.js";

/** How long a send waits for another send on the same wallet before BUSY, by default. */
export const SEND_QUEUE_WAIT_DEFAULT_MS = 10_000;
export const SEND_QUEUE_WAIT_MAX_MS = 600_000;

export class BusyError extends Error {
  constructor(waitedMs: number) {
    super(`Another payment from this wallet is in progress; waited ${waitedMs} ms. Nothing was sent. Try again shortly.`);
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
