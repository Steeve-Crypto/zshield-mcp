import { spawn } from "node:child_process";
import { join } from "node:path";

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

/** The wallet lock file inside a payment store's folder. */
export const WALLET_LOCK_FILE = "send.flock";

/** The lock holder was lost (its process died) while a send still needed it. */
export class LockLostError extends Error {
  constructor() {
    super("The wallet lock was lost while this payment was in progress.");
    this.name = "LockLostError";
  }
}

/**
 * The full wallet lock: held by one paying process for the whole send, released only when
 * the send finishes or the process dies. There is no lease, no timer and no stealing.
 */
export interface WalletLock {
  /** Throws LockLostError if the lock holder is gone. */
  assertHeld(): void;
  /** Gives the lock up. Resolves once the OS lock is really released. Safe to call twice. */
  release(): Promise<void>;
}

/**
 * The OS lock is held by a tiny perl process (perl is already needed for the zingo-cli
 * wrapper) that takes flock(2) on the lock file, then reads its stdin until end of file.
 * The write end of that pipe is ours. When we release, or die, however we die, the pipe
 * closes, the holder exits and the kernel drops the lock. A frozen (SIGSTOP) parent keeps
 * it, and nothing else ever takes it away. Node has no flock binding, and the holder owns
 * the file descriptor, which is why this is a child process and not a `flock` command run
 * and forgotten.
 */
const HOLDER = [
  "use strict; use Fcntl qw(:flock O_WRONLY O_APPEND O_CREAT O_NOFOLLOW O_NONBLOCK); use Time::HiRes qw(time sleep);",
  "$| = 1; my ($file, $wait) = @ARGV; umask(077);",
  "sysopen(my $fh, $file, O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW | O_NONBLOCK, 0600) or do { print \"ERR\\n\"; exit 77 };",
  "my @st = stat($fh); unless (-f $fh && @st && $st[4] == $<) { print \"ERR\\n\"; exit 77 }",
  "my $end = time() + $wait / 1000;",
  "until (flock($fh, LOCK_EX | LOCK_NB)) { if (time() >= $end) { print \"BUSY\\n\"; exit 75 } sleep(0.05) }",
  "print \"LOCKED\\n\";",
  "1 while sysread(STDIN, my $buf, 4096);",
].join(" ");

const RELEASE_GRACE_MS = 3000;

function takeOsLock(file: string, waitMs: number): Promise<WalletLock> {
  return new Promise((resolve, reject) => {
    const child = spawn("perl", ["-e", HOLDER, "--", file, String(Math.max(0, Math.floor(waitMs)))], { stdio: ["pipe", "pipe", "ignore"] });
    let exited = false;
    let settled = false;
    let out = "";
    const gone = new Promise<void>((r) => child.once("close", () => r()));
    child.once("exit", () => (exited = true));
    // The holder must never keep this process alive.
    child.unref();
    (child.stdin as unknown as { unref?: () => void }).unref?.();
    (child.stdout as unknown as { unref?: () => void }).unref?.();
    child.stdin.on("error", () => {});
    const timer = setTimeout(() => settle(new Error("The wallet lock holder did not answer.")), waitMs + 5000);
    const settle = (result: WalletLock | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (result instanceof Error) {
        child.kill("SIGKILL");
        reject(result);
      } else resolve(result);
    };
    child.once("error", (e: NodeJS.ErrnoException) =>
      settle(new Error(e.code === "ENOENT" ? "perl is required for the wallet lock and was not found." : `The wallet lock holder could not start: ${e.message}`))
    );
    child.once("close", () => settle(new Error("The wallet lock holder exited before it took the lock.")));
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
      if (settled) return;
      if (out.includes("LOCKED")) {
        let released = false;
        settle({
          assertHeld() {
            if (released || exited) throw new LockLostError();
          },
          async release() {
            if (released) return;
            released = true;
            child.stdin.end();
            if (exited) return;
            const kill = setTimeout(() => child.kill("SIGKILL"), RELEASE_GRACE_MS);
            await gone;
            clearTimeout(kill);
          },
        });
      } else if (out.includes("BUSY")) settle(new BusyError(waitMs, "Another zshield-mcp process holds the wallet lock."));
      else if (out.includes("ERR")) settle(new Error("The wallet lock file could not be opened."));
    });
  });
}

/**
 * Take this process's queue for the payment store, then the OS lock that every zshield-mcp
 * process on the same wallet also takes. Throws BusyError after `waitMs` in total.
 *
 * With `store.requireOsLock` (live mode) a missing perl or an unsupported platform is an
 * error. Without it (the mock chain) the lock falls back to the in-process queue alone.
 */
export async function acquireWalletLock(
  store: { dir: string; requireOsLock?: boolean },
  waitMs: number,
  _purpose?: string
): Promise<WalletLock> {
  const start = Date.now();
  const releaseLocal = await sendLockFor(store.dir).acquire(waitMs);
  try {
    let os: WalletLock | undefined;
    try {
      if (process.platform === "win32") throw new Error("The OS wallet lock is not supported on this platform.");
      os = await takeOsLock(join(store.dir, WALLET_LOCK_FILE), Math.max(0, waitMs - (Date.now() - start)));
    } catch (e) {
      if (e instanceof BusyError || store.requireOsLock) throw e;
    }
    let released = false;
    return {
      assertHeld() {
        if (released) throw new LockLostError();
        os?.assertHeld();
      },
      async release() {
        if (released) return;
        released = true;
        try {
          await os?.release();
        } finally {
          releaseLocal();
        }
      },
    };
  } catch (e) {
    releaseLocal();
    throw e;
  }
}
