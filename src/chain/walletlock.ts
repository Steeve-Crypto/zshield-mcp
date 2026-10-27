import { randomBytes } from "node:crypto";
import { ensurePrivateDir } from "../fsafe.js";
import { dirname } from "node:path";

/**
 * The OS-level wallet lock. Every zingo-cli process on a wallet is started through a small
 * perl wrapper that takes an exclusive flock(2) on one file in the wallet's state folder
 * and then execs zingo-cli. The lock sits on an open file descriptor that zingo-cli
 * inherits, so it is held by the wallet process itself, for exactly as long as that process
 * (or anything it started) lives. Nothing the parent does can release it early:
 *
 * - a frozen or crashed parent that left its zingo-cli running still holds the lock, so a
 *   new holder's zingo-cli waits for it instead of running beside it;
 * - a parent that wakes late and spawns after a new holder took over waits for the new
 *   holder's zingo-cli to finish, and a send also carries a start deadline, after which the
 *   wrapper refuses to start it at all.
 *
 * The wrapper reports "did not start" in a way zingo-cli cannot imitate: a stderr line with a
 * nonce that only this process and the wrapper know, and a reserved exit code. A caller
 * treats that, and only that, as proof that nothing was started.
 */

export const WRAP_BUSY_CODE = 75;
export const WRAP_LATE_CODE = 76;
export const WRAP_NOLOCK_CODE = 77;
export const WRAP_EXEC_CODE = 78;

/** How long a send waits for the wallet's other zingo-cli process to finish. */
export const SEND_LOCK_WAIT_MS = 30_000;
/** A send must have started within this long of the last fence check, or it is not started. */
export const SEND_START_WINDOW_MS = 45_000;
/** The longest a read or sync waits for the wallet lock. */
export const READ_LOCK_WAIT_MS = 60_000;

export type WalletBusyKind = "busy" | "late" | "unavailable";

/**
 * zingo-cli was not started: the wallet is held by another zingo-cli process, the start
 * deadline passed while waiting, or the lock could not be taken at all. Nothing was sent.
 */
export class WalletBusyError extends Error {
  constructor(
    message: string,
    readonly kind: WalletBusyKind
  ) {
    super(message);
    this.name = "WalletBusyError";
  }
}

const SCRIPT = [
  "use strict; use Fcntl qw(:flock); use Time::HiRes qw(time sleep);",
  "BEGIN { $^F = 1023; }",
  "my ($file, $nonce, $wait, $deadline, @cmd) = @ARGV;",
  "sub stop { my ($code, $why) = @_; print STDERR \"ZSHIELD-WRAP $nonce $why\\n\"; exit $code; }",
  "umask(077);",
  "stop(77, 'symlink') if -l $file;",
  "open(my $fh, '>>', $file) or stop(77, 'open');",
  "my $end = time() + $wait / 1000;",
  "until (flock($fh, LOCK_EX | LOCK_NB)) { stop(75, 'busy') if time() >= $end; sleep(0.05); }",
  "stop(76, 'late') if $deadline > 0 && time() * 1000 >= $deadline;",
  "exec { $cmd[0] } @cmd or stop(78, 'exec');",
].join(" ");

export interface WrapOptions {
  lockFile: string;
  /** How long to wait for the lock, in milliseconds. */
  waitMs: number;
  /** Epoch milliseconds after which the wrapper refuses to start the command. 0 for none. */
  deadlineMs?: number;
}

export interface Wrapped {
  bin: string;
  args: string[];
  nonce: string;
}

/** The command line that runs `bin args` under the wallet lock. Throws WalletBusyError("unavailable") when it cannot. */
export function wrapForWallet(bin: string, args: string[], opts: WrapOptions): Wrapped {
  if (process.platform === "win32") {
    throw new WalletBusyError("Live mode needs an OS wallet lock, which this platform does not support. Nothing was started.", "unavailable");
  }
  try {
    ensurePrivateDir(dirname(opts.lockFile));
  } catch (e) {
    throw new WalletBusyError(`The wallet lock folder is not usable: ${e instanceof Error ? e.message : String(e)}. Nothing was started.`, "unavailable");
  }
  const nonce = randomBytes(12).toString("hex");
  return {
    bin: "perl",
    args: ["-e", SCRIPT, "--", opts.lockFile, nonce, String(Math.max(0, Math.floor(opts.waitMs))), String(Math.floor(opts.deadlineMs ?? 0)), bin, ...args],
    nonce,
  };
}

/**
 * Read the wrapper's own refusal out of what a failed run printed. Only a line carrying
 * this run's nonce counts, so nothing zingo-cli prints can pass for it.
 */
export function wrapperRefusal(nonce: string, stderr: string): WalletBusyError | undefined {
  const m = stderr.match(new RegExp(`^ZSHIELD-WRAP ${nonce} (busy|late|symlink|open|exec)$`, "m"));
  if (!m) return undefined;
  switch (m[1]) {
    case "busy":
      return new WalletBusyError("Another zingo-cli process is using this wallet. Nothing was started. Try again shortly.", "busy");
    case "late":
      return new WalletBusyError("The wallet was busy until the start deadline passed, so the send was not started. Nothing was sent.", "late");
    default:
      return new WalletBusyError(`The wallet lock could not be taken (${m[1]}). Nothing was started.`, "unavailable");
  }
}

/** perl is missing: the wrapper could not run, so nothing was started. */
export function missingPerl(e: NodeJS.ErrnoException): WalletBusyError | undefined {
  if (e.code === "ENOENT") return new WalletBusyError("perl is required for the OS wallet lock and was not found. Nothing was started.", "unavailable");
  return undefined;
}

/** The wait for the lock, kept below the run's own timeout so a refusal always arrives before it. */
export function lockWaitWithin(waitMs: number, timeoutMs: number): number {
  return Math.max(0, Math.min(waitMs, timeoutMs - 1000));
}
