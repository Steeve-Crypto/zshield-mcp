import { spawn } from "node:child_process";
import { join } from "node:path";

/** How long a send waits for another send on the same wallet before BUSY, by default. */
export const SEND_QUEUE_WAIT_DEFAULT_MS = 20_000;
export const SEND_QUEUE_WAIT_MAX_MS = 600_000;

export class BusyError extends Error {
  constructor(waitedMs: number, detail = "Another payment from this wallet is in progress.") {
    super(`${detail} Waited ${waitedMs} ms. Nothing was sent. Try again shortly.`);
    this.name = "BusyError";
  }
}

/**
 * A mutex with a bounded wait. One holder at a time; queued payments go first, FIFO within each class, and
 * give up with BusyError after `waitMs`.
 */
/** Higher rank is served first; FIFO within a rank. Recovery outranks payments. */
export function lockRank(purpose?: string): number {
  if (purpose === "recovery") return 3;
  if (purpose === "maintenance" || purpose === "operator") return 2;
  if (purpose !== undefined && SHARED_READ_PURPOSES.has(purpose)) return 0;
  return 1;
}

/**
 * Ranked reader-writer lock. Rank 0 (reads) share the hold so history cannot monopolize
 * a payment; rank >= 1 is exclusive. Highest waiting rank is served first, FIFO within a rank.
 * Waiting writers block new readers so a flood of history calls cannot starve recovery or pay.
 */
export class SendLock {
  private readers = 0;
  private writer = false;
  private readonly waiters: { grant: () => void; done: boolean; rank: number }[] = [];

  get locked(): boolean {
    return this.writer || this.readers > 0;
  }

  acquire(waitMs: number, payment = false, purpose?: string): Promise<() => void> {
    const rank = purpose !== undefined ? lockRank(purpose) : payment ? 1 : lockRank(undefined);
    const release = once(() => this.releaseRank(rank));
    if (this.tryEnter(rank)) return Promise.resolve(release);
    return new Promise((resolve, reject) => {
      const waiter = {
        done: false,
        rank,
        grant: () => {
          clearTimeout(timer);
          waiter.done = true;
          resolve(release);
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

  private tryEnter(rank: number): boolean {
    if (rank === 0) {
      if (this.writer || this.waiters.some((w) => !w.done && w.rank > 0)) return false;
      this.readers++;
      return true;
    }
    if (this.writer || this.readers > 0) return false;
    this.writer = true;
    return true;
  }

  private releaseRank(rank: number): void {
    if (rank === 0) this.readers = Math.max(0, this.readers - 1);
    else this.writer = false;
    this.drain();
  }

  private drain(): void {
    for (;;) {
      let best = -1;
      for (let i = 0; i < this.waiters.length; i++) {
        if (this.waiters[i].done) continue;
        if (best < 0 || this.waiters[i].rank > this.waiters[best].rank) best = i;
      }
      if (best < 0) return;
      const rank = this.waiters[best].rank;
      if (rank === 0) {
        // Admit every waiting reader while no writer is ahead.
        if (this.writer || this.waiters.some((w) => !w.done && w.rank > 0)) return;
        const readers = this.waiters.filter((w) => !w.done && w.rank === 0);
        for (const w of readers) {
          const i = this.waiters.indexOf(w);
          if (i >= 0) this.waiters.splice(i, 1);
          this.readers++;
          w.grant();
        }
        return;
      }
      if (this.writer || this.readers > 0) return;
      const w = this.waiters.splice(best, 1)[0];
      this.writer = true;
      w.grant();
      return;
    }
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
  "$| = 1; my ($file, $wait, $shared) = @ARGV; umask(077);",
  "sysopen(my $fh, $file, O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW | O_NONBLOCK, 0600) or do { print \"ERR\\n\"; exit 77 };",
  "my @st = stat($fh); unless (-f $fh && @st && $st[4] == $<) { print \"ERR\\n\"; exit 77 }",
  "my $end = time() + $wait / 1000;",
  "until (flock($fh, ($shared ? LOCK_SH : LOCK_EX) | LOCK_NB)) { if (time() >= $end) { print \"BUSY\\n\"; exit 75 } sleep(0.05) }",
  "print \"LOCKED\\n\";",
  "1 while sysread(STDIN, my $buf, 4096);",
].join(" ");

const RELEASE_GRACE_MS = 3000;

/**
 * Fair exclusive admission for the payment turnstile: waiters take sequentially numbered
 * tickets and only the holder of the lowest outstanding ticket may poll for the flock.
 * Shared readers skip the ticket (they only need to observe writers, not order among themselves).
 */
function takeFairTicket(dir: string, waitMs: number): Promise<{ release: () => void }> {
  return new Promise((resolve, reject) => {
    const child = spawn("perl", ["-e", FAIR_TICKET, "--", dir, String(Math.max(0, Math.floor(waitMs)))], { stdio: ["pipe", "pipe", "ignore"] });
    let settled = false;
    let out = "";
    const gone = new Promise<void>((r) => child.once("close", () => r()));
    child.unref();
    (child.stdin as unknown as { unref?: () => void }).unref?.();
    (child.stdout as unknown as { unref?: () => void }).unref?.();
    child.stdin.on("error", () => {});
    const timer = setTimeout(() => settle(new Error("The fair lock ticket holder did not answer.")), waitMs + 5000);
    const settle = (result: { release: () => void } | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (result instanceof Error) {
        child.kill("SIGKILL");
        reject(result);
      } else resolve(result);
    };
    child.once("error", (e: NodeJS.ErrnoException) =>
      settle(new Error(e.code === "ENOENT" ? "perl is required for the wallet lock and was not found." : `The fair lock ticket holder could not start: ${e.message}`))
    );
    child.once("close", () => settle(new Error("The fair lock ticket holder exited early.")));
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
      if (settled) return;
      if (out.includes("READY")) {
        let released = false;
        settle({
          release() {
            if (released) return;
            released = true;
            child.stdin.end();
          },
        });
        void gone;
      } else if (out.includes("BUSY")) settle(new BusyError(waitMs, "Another zshield-mcp process holds the wallet lock."));
      else if (out.includes("ERR")) settle(new Error("The fair lock ticket file could not be opened."));
    });
  });
}

const FAIR_TICKET = [
  "use strict; use Fcntl qw(:flock O_RDWR O_RDONLY O_CREAT O_NOFOLLOW O_NONBLOCK O_WRONLY O_EXCL); use Time::HiRes qw(time sleep); use IO::Handle;",
  "$| = 1; my ($dir, $wait) = @ARGV; umask(077);",
  "my $seq = \"$dir/ticket.seq\";",
  "sysopen(my $sfh, $seq, O_RDWR | O_CREAT | O_NOFOLLOW | O_NONBLOCK, 0600) or do { print \"ERR\\n\"; exit 77 };",
  "my @sst = stat($sfh); unless (-f $sfh && @sst && $sst[4] == $<) { print \"ERR\\n\"; exit 77 }",
  "my $end = time() + $wait / 1000;",
  "until (flock($sfh, LOCK_EX | LOCK_NB)) { if (time() >= $end) { print \"BUSY\\n\"; exit 75 } sleep(0.01) }",
  "sysseek($sfh, 0, 0); read($sfh, my $cur, 32); $cur = 0 if !defined $cur || $cur !~ /^[0-9]+$/; my $ticket = 0 + $cur; my $next = $ticket + 1;",
  "sysseek($sfh, 0, 0); truncate($sfh, 0); print $sfh $next; $sfh->flush;",
  "my $base = sprintf(\"ticket.%020d.%d\", $ticket, $$); my $mine = \"$dir/$base\";",
  // The ticket is created and flocked while the sequence lock is held, so a ticket file whose flock
  // can be taken (under the sequence lock) belongs to a dead waiter and is removed instead of blocking everyone.
  "sysopen(my $tfh, $mine, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600) or do { flock($sfh, LOCK_UN); print \"ERR\\n\"; exit 77 };",
  "flock($tfh, LOCK_EX | LOCK_NB) or do { unlink($mine); flock($sfh, LOCK_UN); print \"ERR\\n\"; exit 77 };",
  "flock($sfh, LOCK_UN);",
  "sub earliest { my $best; opendir(my $d, $dir) or return undef; for my $n (readdir($d)) { next unless $n =~ /^ticket\\.\\d+\\.\\d+$/; $best = $n if !defined $best || $n lt $best } closedir($d); $best }",
  "sub reap { my ($n) = @_; sysopen(my $o, \"$dir/$n\", O_RDONLY | O_NOFOLLOW | O_NONBLOCK) or return; if (flock($o, LOCK_EX | LOCK_NB)) { if (flock($sfh, LOCK_EX | LOCK_NB)) { unlink(\"$dir/$n\"); flock($sfh, LOCK_UN) } } close($o) }",
  "for (;;) { my $e = earliest(); last if defined $e && $e eq $base; if (time() >= $end) { unlink($mine); print \"BUSY\\n\"; exit 75 } reap($e) if defined $e; sleep(0.02) }",
  "print \"READY\\n\";",
  "1 while sysread(STDIN, my $buf, 4096);",
  "unlink($mine); close($tfh);",
].join(" ");

function takeOsLock(file: string, waitMs: number, shared = false): Promise<WalletLock> {
  return new Promise((resolve, reject) => {
    const child = spawn("perl", ["-e", HOLDER, "--", file, String(Math.max(0, Math.floor(waitMs))), shared ? "1" : "0"], { stdio: ["pipe", "pipe", "ignore"] });
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
/** Exclusive OS turnstile: payments, recovery and maintenance. Shared would let reads starve writers. */
/** Wallet reads that may share the lock with each other. Anything else, known or not, is exclusive. */
const SHARED_READ_PURPOSES = new Set(["zcash_history", "zcash_balance", "zcash_receive_address", "zcash_payment_status"]);

function isSharedRead(purpose?: string): boolean {
  return purpose !== undefined && SHARED_READ_PURPOSES.has(purpose);
}

function needsExclusivePriority(purpose?: string): boolean {
  return !isSharedRead(purpose);
}

/** Local queue priority for classes that must not lose to ordinary reads. */
function isPriorityLocal(purpose?: string): boolean {
  return needsExclusivePriority(purpose);
}

export async function acquireWalletLock(
  store: { dir: string; requireOsLock?: boolean },
  waitMs: number,
  purpose?: string
): Promise<WalletLock> {
  const start = Date.now();
  const remaining = () => Math.max(0, waitMs - (Date.now() - start));
  const exclusive = needsExclusivePriority(purpose);
  // Local admission FIRST: never spawn a perl holder for a call the in-process mutex will refuse.
  // Recovery outranks payments so unresolved-send probes cannot starve crash recovery (F-69).
  const releaseLocal = await sendLockFor(store.dir).acquire(waitMs, isPriorityLocal(purpose), purpose);
  let ticket: { release: () => void } | undefined;
  let priority: WalletLock | undefined;
  let os: WalletLock | undefined;
  try {
    try {
      if (process.platform === "win32") throw new Error("The OS wallet lock is not supported on this platform.");
      // Exclusive writers take a fair cross-process ticket before the flock so later payments
      // cannot leapfrog an earlier authorized one at the OS turnstile (F-65).
      if (exclusive) ticket = await takeFairTicket(store.dir, remaining());
      // Exclusive turnstile for pay/recovery/maintenance so shared reads cannot cut in
      // between nonblocking retries. Readers take a shared pass only for admission.
      priority = await takeOsLock(join(store.dir, "send-priority.flock"), remaining(), !exclusive);
      // The ticket only orders admission to the turnstile. Once the exclusive turnstile is held no
      // later ticket can pass it, so hand the ticket on now: the send must not depend on it staying alive.
      ticket?.release();
      ticket = undefined;
      // Reads share send.flock so a history scan cannot monopolize payments (F-28).
      // Payments still take it exclusive and wait only for the short read deadline.
      os = await takeOsLock(join(store.dir, WALLET_LOCK_FILE), remaining(), !exclusive);
      if (!exclusive) { await priority.release(); priority = undefined; }
    } catch (e) {
      await priority?.release();
      priority = undefined;
      ticket?.release();
      ticket = undefined;
      if (e instanceof BusyError || store.requireOsLock) throw e;
    }
    let released = false;
    return {
      assertHeld() {
        if (released) throw new LockLostError();
        os?.assertHeld();
        priority?.assertHeld();
      },
      async release() {
        if (released) return;
        released = true;
        try {
          await os?.release();
        } finally {
          try { await priority?.release(); } finally {
            try { ticket?.release(); } finally { releaseLocal(); }
          }
        }
      },
    };
  } catch (e) {
    try { await os?.release(); } finally {
      try { await priority?.release(); } finally {
        try { ticket?.release(); } finally { releaseLocal(); }
      }
    }
    throw e;
  }
}


/** Maintenance must also exclude CLI children left alive by a killed server. */
export async function acquireMaintenanceLock(store: { dir: string; requireOsLock?: boolean }, waitMs = 30_000): Promise<WalletLock> {
  const app = await acquireWalletLock(store, waitMs, "maintenance");
  try {
    const backend = await takeOsLock(join(store.dir, "zingo.flock"), waitMs);
    return { assertHeld() { app.assertHeld(); backend.assertHeld(); }, async release() { await backend.release(); await app.release(); } };
  } catch (error) { await app.release(); throw error; }
}
