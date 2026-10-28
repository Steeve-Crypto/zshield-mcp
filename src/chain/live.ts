import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { ChainAdapter } from "./types.js";
import type { ChainHealth, OutgoingNote, PaymentReceipt, PaymentRequest, TxSummary, WalletBalance } from "../types.js";
import { assertTestnetAddress, NetworkError } from "./network.js";
import { addNoteFacts, corroborate, extractJson, messageFacts, type TxFacts, type WalletFacts } from "./corroborate.js";
import { ChainUnreachableError, CliTimeoutError, SendOutcomeUnknownError } from "./outcome.js";
import { defaultSyncer, type SyncResult, type WalletSyncer } from "./sync.js";
import { displayUrl, redact, registerServerUrl } from "../redact.js";
import { memoProblem } from "../policy/limits.js";
import { walletStateDir } from "../payments/store.js";
import { READ_LOCK_WAIT_MS, lockWaitWithin, SEND_LOCK_WAIT_MS, SEND_START_WINDOW_MS, WalletBusyError, missingPerl, wrapForWallet, wrapperRefusal, type Wrapped } from "./walletlock.js";

/** Used when a test injects a runner and no syncer: no process is started. */
const skipSync: WalletSyncer = async () => ({ complete: true, elapsedMs: 0 });

export const TESTNET_EXPLORER = "https://blockexplorer.one/zcash/testnet/tx/";

export interface RunOptions {
  /** Stop the CLI after this many milliseconds: SIGTERM, then SIGKILL after killGraceMs. */
  timeoutMs?: number;
  /** How long a CLI that ignores SIGTERM gets before SIGKILL. Default RUNNER_KILL_GRACE_MS. */
  killGraceMs?: number;
  /**
   * Written to the CLI's stdin, which is then closed. Used to drive the interactive prompt
   * so payment details never appear in argv. When set, stderr is appended to the result,
   * because the prompt reports command errors there and still exits 0.
   */
  input?: string;
  /**
   * Run under the OS wallet lock on this file (see walletlock.ts). The wrapper waits up to
   * lockWaitMs for it, and refuses to start after lockDeadlineMs. A refusal rejects with
   * WalletBusyError, which means nothing was started.
   */
  lockFile?: string;
  lockWaitMs?: number;
  lockDeadlineMs?: number;
}

/** Runs a zingo-cli invocation and returns stdout. Injectable for tests. */
export type CliRunner = (bin: string, args: string[], opts?: RunOptions) => Promise<string>;

/** Sends can take a while to build proofs. */
export const SEND_TIMEOUT_MS = 15 * 60_000;
/** Building and signing a transaction broadcasts nothing, so it may be cut off sooner. */
export const STAGE_TIMEOUT_MS = 5 * 60_000;
/** Reads should answer fast or fail. Override with ZINGO_READ_TIMEOUT_MS. */
export const DEFAULT_READ_TIMEOUT_MS = 120_000;

/** Default limit for each zingo-cli run in the pre-send check. */
export const DEFAULT_HEALTH_TIMEOUT_MS = 30_000;
/** Default limit for the bounded sync before a status answer or recovery. */
export const DEFAULT_STATUS_SYNC_TIMEOUT_MS = 90_000;
/** Default limit for the bounded sync before the pre-send funds check. */
export const DEFAULT_HEALTH_SYNC_TIMEOUT_MS = 90_000;

/**
 * Every timeout setting, with its default and allowed range in milliseconds. A value out
 * of range stops the server at startup (validateTimeouts); the getters clamp as well, so
 * no setting can make a wait unbounded.
 */
export const TIMEOUT_SETTINGS = {
  ZINGO_HEALTH_TIMEOUT_MS: { def: DEFAULT_HEALTH_TIMEOUT_MS, min: 1, max: 300_000 },
  ZINGO_READ_TIMEOUT_MS: { def: DEFAULT_READ_TIMEOUT_MS, min: 1, max: 600_000 },
  STATUS_SYNC_TIMEOUT_MS: { def: DEFAULT_STATUS_SYNC_TIMEOUT_MS, min: 0, max: 600_000 },
  HEALTH_SYNC_TIMEOUT_MS: { def: DEFAULT_HEALTH_SYNC_TIMEOUT_MS, min: 0, max: 600_000 },
} as const;
type TimeoutName = keyof typeof TIMEOUT_SETTINGS;

function boundedMs(name: TimeoutName, env: NodeJS.ProcessEnv = process.env): number {
  const { def, min, max } = TIMEOUT_SETTINGS[name];
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return def;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < min) return def;
  return Math.min(Math.floor(v), max);
}

/** Throws when a timeout setting is not a whole number in its range. Called at startup. */
export function validateTimeouts(env: NodeJS.ProcessEnv = process.env): void {
  for (const [name, { min, max }] of Object.entries(TIMEOUT_SETTINGS)) {
    const raw = env[name];
    if (raw === undefined || raw.trim() === "") continue;
    if (!/^\d+$/.test(raw.trim()) || Number(raw) < min || Number(raw) > max) {
      throw new Error(`${name} must be a whole number of milliseconds from ${min} to ${max}.`);
    }
  }
}

export function healthTimeoutMs(): number {
  return boundedMs("ZINGO_HEALTH_TIMEOUT_MS");
}

/** STATUS_SYNC_TIMEOUT_MS: how long zcash_payment_status and recovery sync first. 0 skips it. */
export function statusSyncTimeoutMs(): number {
  return boundedMs("STATUS_SYNC_TIMEOUT_MS");
}

/** HEALTH_SYNC_TIMEOUT_MS: how long a live send syncs before checking funds. 0 skips it. */
export function healthSyncTimeoutMs(): number {
  return boundedMs("HEALTH_SYNC_TIMEOUT_MS");
}

export function readTimeoutMs(): number {
  return boundedMs("ZINGO_READ_TIMEOUT_MS");
}

/**
 * Wrap a runner so nothing that comes back from zingo-cli, output or error, carries a
 * registered secret such as credentials in the server URL. zingo-cli prints the server
 * URI in some messages.
 */
export function redactingRunner(runner: CliRunner): CliRunner {
  return async (bin, args, opts) => {
    try {
      return redact(await runner(bin, args, opts));
    } catch (e) {
      if (e instanceof Error) e.message = redact(e.message);
      throw e;
    }
  };
}

/** A CLI that ignores SIGTERM after its timeout is killed outright after this long. */
export const RUNNER_KILL_GRACE_MS = 5_000;

export const defaultRunner: CliRunner = (bin, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const timeout = opts.timeoutMs ?? SEND_TIMEOUT_MS;
    let wrapped: Wrapped | undefined;
    if (opts.lockFile) {
      try {
        wrapped = wrapForWallet(bin, args, {
          lockFile: opts.lockFile,
          waitMs: lockWaitWithin(opts.lockWaitMs ?? READ_LOCK_WAIT_MS, timeout),
          deadlineMs: opts.lockDeadlineMs,
        });
      } catch (e) {
        reject(e);
        return;
      }
    }
    // execFile's own timeout only sends SIGTERM, and a process can ignore it and keep the
    // call, and the wallet lock above it, waiting forever. This timer makes the bound hard.
    const hardKill = setTimeout(() => child.kill("SIGKILL"), timeout + (opts.killGraceMs ?? RUNNER_KILL_GRACE_MS));
    const child = execFile(wrapped?.bin ?? bin, wrapped?.args ?? args, { maxBuffer: 16 * 1024 * 1024, timeout }, (err, stdout, stderr) => {
      clearTimeout(hardKill);
      if (err && wrapped) {
        const refusal = wrapperRefusal(wrapped.nonce, stderr.toString()) ?? missingPerl(err as NodeJS.ErrnoException);
        if (refusal) {
          reject(refusal);
          return;
        }
      }
      if (err) {
        // With the wrapper, err.message holds the whole wrapper command line, so it is not
        // used: only what the process printed, or its exit status.
        const detail = (stderr || (wrapped ? `exit ${String((err as { code?: unknown }).code ?? err.signal ?? "unknown")}` : err.message)).toString().slice(0, 500);
        // execFile sets killed and signal when the timeout fires or the process is killed.
        if (err.killed || err.signal) {
          reject(new CliTimeoutError(`zingo-cli was stopped (${err.signal ?? "killed"}) after ${timeout} ms: ${detail}`));
        } else {
          reject(new Error(`zingo-cli failed: ${detail}`));
        }
      }
      else resolve(opts.input === undefined ? stdout.toString() : `${stdout}\n${stderr}`);
    });
    if (opts.input !== undefined) {
      child.stdin?.on("error", () => {
        // The CLI exited before reading everything; the exit callback reports it.
      });
      child.stdin?.end(opts.input);
    }
  });

export class WalletDirError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WalletDirError";
  }
}

/**
 * Where the testnet wallet lives when ZINGO_DATA_DIR is not set: .zshield-testnet/wallet
 * under the OS home directory. Uses os.homedir(), which also works when HOME is unset.
 * Throws WalletDirError rather than return a relative path, so zingo-cli and the
 * permission check never point at a folder under the working directory by accident.
 */
export function defaultWalletDir(home: () => string = homedir): string {
  let dir = "";
  try {
    dir = home();
  } catch {
    dir = "";
  }
  if (!dir || !isAbsolute(dir)) {
    throw new WalletDirError(
      "zshield-mcp: no home directory found for the testnet wallet. Set ZINGO_DATA_DIR to an absolute path."
    );
  }
  return join(dir, ".zshield-testnet", "wallet");
}

/** The wallet directory for live mode: ZINGO_DATA_DIR when set, which must be absolute, else the default. */
export function resolveWalletDir(dataDir: string | undefined, home: () => string = homedir): string {
  if (dataDir === undefined || dataDir === "") return defaultWalletDir(home);
  if (!isAbsolute(dataDir)) {
    throw new WalletDirError("zshield-mcp: ZINGO_DATA_DIR must be an absolute path.");
  }
  return dataDir;
}

export interface LiveOptions {
  network: string | undefined;
  zingoBin?: string;
  dataDir?: string;
  server?: string;
  runner?: CliRunner;
  /**
   * Runs the bounded sync. Defaults to the real zingo-cli prompt, except when a test
   * passes its own runner without a syncer: then sync is skipped and reported complete.
   */
  syncer?: WalletSyncer;
  /**
   * The payment store folder. Defaults to .zshield-state inside the wallet directory, or
   * none for a test adapter built with a runner, which then uses one beside its audit dir.
   */
  stateDir?: string;
  /** Clock for the export_ufvk backoff. Tests pass a fake one. */
  now?: () => number;
}

/** First wait after a failed export_ufvk; doubles on each failure in a row. */
export const VIEWKEY_BACKOFF_BASE_MS = 1_000;
/** Longest wait between export_ufvk attempts. */
export const VIEWKEY_BACKOFF_MAX_MS = 60_000;

/**
 * Testnet adapter backed by zingo-cli and a public lightwalletd.
 * Refuses to construct unless network is exactly "testnet".
 */
export class LiveChainAdapter implements ChainAdapter {
  readonly mode = "live" as const;
  readonly bin: string;
  readonly dataDir: string;
  /** The payment store, inside the wallet directory, shared by every process on the wallet. */
  readonly stateDir?: string;
  readonly server: string;
  private readonly runner: CliRunner;
  private readonly syncer: WalletSyncer;
  /** Cached in memory only, for this process. Never logged or written. */
  private viewingKey?: Promise<string>;
  private viewKeyFailures = 0;
  private viewKeyRetryAt = 0;
  private viewKeyLastError = "";
  private readonly now: () => number;

  constructor(opts: LiveOptions) {
    if (opts.network !== "testnet") {
      throw new NetworkError("Live mode requires CHAIN_MODE=testnet. Mainnet is not supported.", "mode");
    }
    this.bin = opts.zingoBin ?? "zingo-cli";
    this.dataDir = resolveWalletDir(opts.dataDir);
    this.server = opts.server ?? "https://testnet.zec.rocks:443";
    registerServerUrl(this.server);
    this.runner = redactingRunner(opts.runner ?? defaultRunner);
    this.syncer = opts.syncer ?? (opts.runner ? skipSync : defaultSyncer);
    this.stateDir = opts.stateDir ?? (opts.runner ? undefined : walletStateDir(this.dataDir));
    this.now = opts.now ?? Date.now;
    this.lockFile = this.stateDir ? join(this.stateDir, "zingo.flock") : undefined;
  }

  /** The OS lock file every zingo-cli process on this wallet runs under. None for a test adapter without a store. */
  private readonly lockFile?: string;

  /** Runs zingo-cli with the OS wallet lock options added. */
  private exec(args: string[], opts: RunOptions = {}): Promise<string> {
    return this.runner(this.bin, args, this.lockFile ? { lockFile: this.lockFile, ...opts } : opts);
  }

  baseArgs(): string[] {
    // --waitsync can block past the runner timeout (background sync never reports done),
    // so it is opt-in via ZINGO_WAITSYNC=1. One-shot commands still sync at startup.
    const args = ["--chain", "testnet", "--server", this.server, "--data-dir", this.dataDir];
    if (process.env.ZINGO_WAITSYNC === "1") args.push("--waitsync");
    return args;
  }

  async run(cmd: string[], opts: RunOptions = {}): Promise<string> {
    return this.exec([...this.baseArgs(), ...cmd], opts);
  }

  /**
   * Read-only: runs `balance` and `spendable_balance`. Never sends. With `offline`, reads
   * the wallet file as last synced and starts no sync of its own.
   */
  async getBalance(opts: { offline?: boolean } = {}): Promise<WalletBalance> {
    const timeoutMs = readTimeoutMs();
    const args = (cmd: string) => (opts.offline ? this.offline(cmd) : [...this.baseArgs(), cmd]);
    const pools = parseBalance(await this.exec(args("balance"), { timeoutMs }));
    const spendableZats = parseSpendable(await this.exec(args("spendable_balance"), { timeoutMs }));
    return { ...pools, spendableZats };
  }

  /**
   * Sync the wallet to the chain tip, for at most `timeoutMs`, through zingo-cli's prompt.
   * Read-only on the chain: it scans blocks and saves the wallet, and never sends. The
   * caller must hold the wallet lock, since it writes the wallet file. Never throws.
   */
  async syncWallet(timeoutMs: number): Promise<SyncResult> {
    if (timeoutMs <= 0) return { complete: false, elapsedMs: 0, detail: "sync skipped (timeout is 0)" };
    const args = ["--chain", "testnet", "--server", this.server, "--data-dir", this.dataDir];
    try {
      const r = await this.syncer(this.bin, args, { timeoutMs, ...(this.lockFile ? { lockFile: this.lockFile } : {}) });
      return r.detail ? { ...r, detail: redact(r.detail) } : r;
    } catch (e) {
      return { complete: false, elapsedMs: 0, detail: redact(e instanceof Error ? e.message : String(e)) };
    }
  }

  /**
   * Read-only pre-send check. First a bounded sync (HEALTH_SYNC_TIMEOUT_MS), because a
   * wallet that has not finished scanning reports a spendable balance of 0. Then `info`
   * asks the server for the chain tip without syncing, and `height` and
   * `spendable_balance` read the wallet file in offline sessions. Every run has a timeout.
   * `synced` tells the caller whether the sync finished.
   */
  async checkHealth(opts: { sync?: boolean } = {}): Promise<ChainHealth> {
    let synced: boolean | undefined;
    let syncDetail: string | undefined;
    const syncMs = healthSyncTimeoutMs();
    if (opts.sync !== false && syncMs > 0) {
      const r = await this.syncWallet(syncMs);
      synced = r.complete;
      syncDetail = r.detail;
    }
    const timeoutMs = healthTimeoutMs();
    let chainTip: number;
    try {
      // --nosync: a sync cut short by this one-shot run leaves new blocks marked unscanned,
      // and zingo-cli then reports a spendable balance of 0 until the next full sync.
      const args = ["--chain", "testnet", "--server", this.server, "--data-dir", this.dataDir, "--nosync", "info"];
      chainTip = parseLatestBlockHeight(await this.exec(args, { timeoutMs }));
    } catch (e) {
      if (e instanceof WalletBusyError) throw e;
      throw new ChainUnreachableError(
        `lightwalletd at ${displayUrl(this.server)} did not report the chain tip: ${redact(e instanceof Error ? e.message : String(e))}`
      );
    }
    const walletHeight = parseWalletHeight(await this.exec(this.offline("height"), { timeoutMs }));
    const spendableZats = parseSpendable(await this.exec(this.offline("spendable_balance"), { timeoutMs }));
    return { walletHeight, chainTip, spendableZats, ...(synced === undefined ? {} : { synced }), ...(syncDetail ? { syncDetail } : {}) };
  }

  private offline(cmd: string): string[] {
    return ["--chain", "testnet", "--data-dir", this.dataDir, "--offline", cmd];
  }

  /** Read-only, offline: the height the wallet has synced to. */
  async walletHeight(): Promise<number> {
    const args = ["--chain", "testnet", "--data-dir", this.dataDir, "--offline", "height"];
    return parseWalletHeight(await this.exec(args, { timeoutMs: healthTimeoutMs() }));
  }

  /**
   * Read-only: runs `transactions` and returns the newest `limit` entries. zingo-cli
   * prints the whole wallet history, so `Infinity` returns all of it. With `offline`,
   * reads the wallet file as last synced and starts no sync of its own.
   */
  async getHistory(limit: number, opts: { offline?: boolean } = {}): Promise<TxSummary[]> {
    const run = (...cmd: string[]) => this.exec(opts.offline ? [...this.offline(cmd[0]), ...cmd.slice(1)] : [...this.baseArgs(), ...cmd], { timeoutMs: readTimeoutMs() });
    // The JSON commands first, then the listing: an entry that appeared in between is not
    // in the JSON and so stays unverified, never the other way round.
    let wallet: WalletFacts | undefined;
    try {
      const byTxid = new Map<string, TxFacts>();
      addNoteFacts(extractJson(await run("notes", "all")), byTxid);
      addNoteFacts(extractJson(await run("coins", "all")), byTxid);
      wallet = { byTxid, messages: messageFacts(extractJson(await run("messages"))) };
    } catch {
      // No second source: every sent entry stays unverified and confirms nothing.
      wallet = undefined;
    }
    const all = parseTransactions(await run("transactions"));
    const times = new Map<string, number>();
    for (const t of all) times.set(t.txid, (times.get(t.txid) ?? 0) + 1);
    return all.slice(0, limit).map((t) => ({ ...t, verified: corroborate(t, wallet, times.get(t.txid) ?? 0) }));
  }

  /** Read-only: runs `addresses` and returns the newest unified address. Refuses a mainnet one. */
  async getReceiveAddress(opts: { offline?: boolean } = {}): Promise<string> {
    const args = opts.offline ? this.offline("addresses") : [...this.baseArgs(), "addresses"];
    const address = parseReceiveAddress(await this.exec(args, { timeoutMs: readTimeoutMs() }));
    assertTestnetAddress(address);
    return address;
  }

  /**
   * Read-only: runs `export_ufvk` in an offline session, so it is fast and touches no
   * network. Cached for the life of the process. The key never leaves this adapter
   * except to be hashed by the caller. After a failure, calls fail fast until the backoff
   * passes (VIEWKEY_BACKOFF_BASE_MS doubling up to VIEWKEY_BACKOFF_MAX_MS).
   */
  async getViewingKey(): Promise<string> {
    if (!this.viewingKey) {
      const wait = this.viewKeyRetryAt - this.now();
      if (wait > 0) {
        // Negative cache: a failing export is not re-run on every call.
        throw new Error(
          `export_ufvk failed ${this.viewKeyFailures} time(s) in a row (${this.viewKeyLastError}); next try in ${Math.ceil(wait / 1000)}s`
        );
      }
      const args = ["--chain", "testnet", "--data-dir", this.dataDir, "--offline", "export_ufvk"];
      const p = this.exec(args, { timeoutMs: readTimeoutMs() }).then(parseUfvk);
      // Do not cache a failure. Back off instead: 1s, 2s, 4s, and so on, up to 60s.
      p.then(
        () => {
          this.viewKeyFailures = 0;
          this.viewKeyRetryAt = 0;
        },
        (e: unknown) => {
          if (this.viewingKey === p) this.viewingKey = undefined;
          // A wallet that is merely busy is not a failing export: no backoff.
          if (e instanceof WalletBusyError) return;
          this.viewKeyFailures++;
          this.viewKeyLastError = e instanceof Error ? e.message : String(e);
          const delay = Math.min(VIEWKEY_BACKOFF_MAX_MS, VIEWKEY_BACKOFF_BASE_MS * 2 ** (this.viewKeyFailures - 1));
          this.viewKeyRetryAt = this.now() + delay;
        }
      );
      this.viewingKey = p;
    }
    return this.viewingKey;
  }

  async pay(req: PaymentRequest): Promise<PaymentReceipt> {
    assertTestnetAddress(req.recipient);
    if (typeof req.amountZats !== "bigint" || req.amountZats <= 0n) {
      throw new Error("Amount must be a positive integer number of zatoshis");
    }
    // The memo goes out exactly as given, so one that could not be matched back from the
    // listing is refused here too, whatever called the adapter.
    const memoIssue = memoProblem(req.memo);
    if (memoIssue) throw new Error(`Memo refused: ${memoIssue}`);
    // The recipient, amount, and memo go over stdin to zingo-cli's prompt, never in argv,
    // so they do not show up in the process list. argv holds only the fixed base options.
    //
    // Two steps, so the transaction id is known and recorded before anything is broadcast:
    // `send` and `calculate` build and sign it, `transmit <txid>` broadcasts exactly that.
    // Nothing is broadcast in step one, so every failure there is a clean "not sent".
    let txid: string;
    try {
      // The last check, with nothing between it and the start of the wallet process.
      req.fence?.();
      // The wallet lock is taken by the wrapper in front of zingo-cli: if another zingo-cli
      // holds it past the wait, or the start deadline passes, nothing starts.
      const built = await this.exec(this.baseArgs(), {
        timeoutMs: STAGE_TIMEOUT_MS,
        input: buildStageInput(req),
        lockWaitMs: SEND_LOCK_WAIT_MS,
        lockDeadlineMs: this.now() + SEND_START_WINDOW_MS,
      });
      txid = parseStaged(built);
    } catch (e) {
      if (e instanceof CliTimeoutError) throw new Error(`zingo-cli did not finish building the transaction (${e.message}). Nothing was sent.`);
      throw e;
    }
    // Bind the txid durably. If that fails the transaction is never transmitted.
    req.stage?.(txid);
    // A lost lease stops here, before the wallet process starts: not sent.
    req.fence?.();
    let sent: string;
    try {
      sent = await this.exec(this.baseArgs(), {
        timeoutMs: SEND_TIMEOUT_MS,
        input: `transmit ${txid}\nquit\n`,
        lockWaitMs: SEND_LOCK_WAIT_MS,
        lockDeadlineMs: this.now() + SEND_START_WINDOW_MS,
      });
    } catch (e) {
      // The wallet process never started: nothing was transmitted.
      if (e instanceof WalletBusyError) throw e;
      // Anything else may have happened after the broadcast.
      throw new SendOutcomeUnknownError(e instanceof Error ? e.message : String(e), txid);
    }
    if (!transmitted(sent, txid)) {
      throw new SendOutcomeUnknownError(`zingo-cli did not report the transmit of ${txid}: ${sent.trim().slice(0, 300)}`, txid);
    }
    return {
      txid,
      amountZats: req.amountZats,
      recipient: req.recipient,
      memo: req.memo,
      mode: "live",
    };
  }
}

/**
 * Build the stdin script for step one of a send: a `send` line in zingo-cli's JSON form
 * (it proposes the transfer), `calculate` (it signs the proposal without transmitting),
 * then `quit`. The prompt splits the line like a shell, so the JSON goes inside single
 * quotes. JSON.stringify already escapes newlines and control characters; single quotes
 * become \u0027, which is still valid JSON. The result has one line per command and no
 * single quote inside the JSON.
 */
export function buildStageInput(req: PaymentRequest): string {
  const entry: Record<string, string | number> = {
    address: req.recipient,
    amount: Number(req.amountZats),
  };
  if (!Number.isSafeInteger(entry.amount)) throw new Error("Amount is too large to send");
  // The memo goes out exactly as given: no trimming, no change.
  if (req.memo) entry.memo = req.memo;
  const json = JSON.stringify([entry]).replace(/'/g, "\\u0027");
  if (/[\r\n']/.test(json)) throw new Error("Send line could not be encoded safely");
  return `send '${json}'\ncalculate\nquit\n`;
}

/**
 * The txid of the one transaction step one built. `send` prints `{ "fee": N }` and
 * `calculate` prints `{ "txids": [...] }`; both must be there, in that order, with no error
 * text, and exactly one txid. Anything else is a refusal. Nothing was broadcast.
 */
export function parseStaged(out: string): string {
  if (/error/i.test(out)) throw new Error(`zingo-cli send error: ${out.trim().slice(0, 500)}`);
  const fee = out.search(/"fee"\s*:\s*\d+/);
  const m = out.match(/"txids"\s*:\s*\[\s*"([0-9a-f]{64})"\s*\]/i);
  if (fee < 0 || !m || m.index === undefined || m.index < fee) {
    throw new Error(`zingo-cli did not build exactly one transaction: ${out.trim().slice(0, 300)}`);
  }
  return m[1].toLowerCase();
}

/** Whether `transmit <txid>` reported exactly that txid and nothing else. */
export function transmitted(out: string, txid: string): boolean {
  if (/error/i.test(out)) return false;
  const m = out.match(/"txids"\s*:\s*\[\s*"([0-9a-f]{64})"\s*\]/i);
  return m !== null && m[1].toLowerCase() === txid;
}

/**
 * Parse `zingo-cli export_ufvk`, which prints `{ "ufvk": "uviewtest1...", "birthday": N }`.
 * Only a testnet key is accepted. Error messages never echo the output, since it holds the key.
 */
export function parseUfvk(out: string): string {
  const m = out.match(/"ufvk"\s*:\s*"(uview[a-z0-9]*1[02-9ac-hj-np-z]+)"/);
  if (!m) throw new Error("zingo-cli export_ufvk returned no unified full viewing key");
  if (!m[1].startsWith("uviewtest1")) {
    throw new NetworkError("zingo-cli export_ufvk returned a key that is not for testnet", "mainnet");
  }
  return m[1];
}

/** Parse an integer that zingo-cli may print with underscores, like 12_390_000. */
function parseZatsToken(token: string): bigint {
  return BigInt(token.replace(/_/g, ""));
}

/**
 * Parse `zingo-cli balance`. It prints lines such as `confirmed_orchard_balance: 12_390_000`
 * for each pool. Confirmed and unconfirmed are summed across every pool it reports.
 */
export function parseBalance(out: string): { confirmedZats: bigint; unconfirmedZats: bigint } {
  let confirmedZats = 0n;
  let unconfirmedZats = 0n;
  let seen = 0;
  for (const m of out.matchAll(/^\s*"?(confirmed|unconfirmed)_[a-z]+_balance"?\s*:\s*([\d_]+)/gim)) {
    seen++;
    const v = parseZatsToken(m[2]);
    if (m[1].toLowerCase() === "confirmed") confirmedZats += v;
    else unconfirmedZats += v;
  }
  if (seen === 0) {
    throw new Error(`zingo-cli balance returned no balance lines: ${out.trim().slice(0, 300)}`);
  }
  return { confirmedZats, unconfirmedZats };
}

/** Parse `zingo-cli spendable_balance`, which prints `{ "spendable_balance": 0 }`. */
/** `info` prints JSON with "latest_block_height". */
export function parseLatestBlockHeight(out: string): number {
  const m = out.match(/"latest_block_height"\s*:\s*(\d+)/);
  if (!m) throw new Error("zingo-cli info printed no latest_block_height");
  return Number(m[1]);
}

/** `height` prints JSON with "height": the wallet's scanned height. */
export function parseWalletHeight(out: string): number {
  const m = out.match(/"height"\s*:\s*(\d+)/);
  if (!m) throw new Error("zingo-cli height printed no height");
  return Number(m[1]);
}

export function parseSpendable(out: string): bigint {
  const m = out.match(/"?spendable_balance"?\s*:\s*([\d_]+)/i);
  if (!m) throw new Error(`zingo-cli spendable_balance returned no value: ${out.trim().slice(0, 300)}`);
  return parseZatsToken(m[1]);
}

/**
 * Parse `zingo-cli addresses`, a JSON array of `{ account, address_index, encoded_address }`.
 * Returns the address with the highest index on account 0, which is the newest one.
 */
export function parseReceiveAddress(out: string): string {
  const start = out.indexOf("[");
  const end = out.lastIndexOf("]");
  if (start < 0 || end < start) {
    throw new Error(`zingo-cli addresses returned no address list: ${out.trim().slice(0, 300)}`);
  }
  let list: unknown;
  try {
    list = JSON.parse(out.slice(start, end + 1));
  } catch {
    throw new Error(`zingo-cli addresses returned unreadable output: ${out.trim().slice(0, 300)}`);
  }
  if (!Array.isArray(list)) throw new Error("zingo-cli addresses did not return a list");
  const entries = list
    .filter((e): e is { account?: number; address_index?: number; encoded_address: string } =>
      typeof e?.encoded_address === "string" && e.encoded_address.length > 0
    )
    .filter((e) => (e.account ?? 0) === 0)
    .sort((a, b) => (b.address_index ?? 0) - (a.address_index ?? 0));
  if (entries.length === 0) throw new Error("zingo-cli addresses returned no unified address");
  return entries[0].encoded_address;
}

/**
 * Parse `zingo-cli transactions`. It prints one `{ ... }` block per transaction with
 * top-level fields indented by four spaces (txid, datetime, status, blockheight, kind,
 * value, fee) and nested note lists indented deeper, which are ignored here.
 * Returns newest first: entries that are not confirmed, then confirmed ones by mined
 * height descending.
 */
export function parseTransactions(out: string): TxSummary[] {
  const txs: TxSummary[] = [];
  for (const block of out.matchAll(/^\{\s*$([\s\S]*?)^\}\s*$/gm)) {
    const fields = new Map<string, string>();
    for (const line of block[1].matchAll(/^ {4}([a-z][a-z _]*?):[ \t]*(.*?)\s*$/gm)) {
      if (!fields.has(line[1])) fields.set(line[1], line[2]);
    }
    const txid = fields.get("txid");
    if (!txid || !/^[0-9a-f]{64}$/i.test(txid)) continue;
    const value = fields.get("value");
    if (!value || !/^[\d_]+$/.test(value)) continue;
    const heightText = fields.get("blockheight");
    const height = heightText && /^\d+$/.test(heightText) ? Number(heightText) : undefined;
    const status = fields.get("status") || "unknown";
    // zingo-cli prints a height for every status. Only a confirmed one is a mined height;
    // for the rest it is the target height the transaction was built for.
    const confirmed = status === "confirmed";
    const fee = fields.get("fee") ?? fields.get("transaction fee");
    const outgoing = parseOutgoingNotes(block[1]);
    txs.push({
      txid: txid.toLowerCase(),
      time: toIso(fields.get("datetime")),
      status,
      blockHeight: confirmed ? height : undefined,
      targetHeight: confirmed ? undefined : height,
      kind: fields.get("kind") || "unknown",
      valueZats: BigInt(value.replace(/_/g, "")),
      feeZats: fee && /^[\d_]+$/.test(fee) ? BigInt(fee.replace(/_/g, "")) : undefined,
      ...(outgoing.length > 0 ? { outgoing } : {}),
    });
  }
  const height = (t: TxSummary) => t.blockHeight ?? Number.MAX_SAFE_INTEGER;
  const time = (t: TxSummary) => (t.time ? Date.parse(t.time) || 0 : 0);
  return txs.sort((a, b) => height(b) - height(a) || time(b) - time(a));
}

/**
 * The notes listed under "outgoing ... notes:" in one transaction block. Each is a nested
 * `{ ... }` group indented deeper than the transaction fields, with value, memo and
 * recipient lines. Groups without a recipient (received notes) are skipped.
 */
export function parseOutgoingNotes(body: string): OutgoingNote[] {
  const notes: OutgoingNote[] = [];
  for (const section of body.matchAll(/^ {4}outgoing [a-z ]*notes:[^\n]*\n([\s\S]*?)(?=^ {4}[a-z]|(?![\s\S]))/gm)) {
    for (const group of section[1].matchAll(/^\s+\{\s*$([\s\S]*?)^\s+\}\s*$/gm)) {
      const f = new Map<string, string>();
      for (const line of group[1].matchAll(/^\s+([a-z][a-z _]*?):[ \t]?(.*?)\s*$/gm)) {
        // The address lines come after the memo, so the last one wins: a memo that carried
        // a line of its own (a send made before memos were limited to one line) cannot
        // stand in for the real recipient. Other fields come before the memo, first wins.
        if (line[1] === "recipient" || line[1] === "recipient unified address" || !f.has(line[1])) f.set(line[1], line[2]);
      }
      const recipient = f.get("recipient");
      const value = f.get("value");
      if (!recipient || !value || !/^[\d_]+$/.test(value)) continue;
      const unified = f.get("recipient unified address");
      notes.push({
        recipient,
        valueZats: BigInt(value.replace(/_/g, "")),
        memo: f.get("memo") ?? "",
        ...(unified && unified !== recipient ? { unifiedAddress: unified } : {}),
      });
    }
  }
  return notes;
}

/** "2026-10-12 14:23:01 UTC" becomes "2026-10-12T14:23:01.000Z". */
function toIso(dt: string | undefined): string | undefined {
  if (!dt) return undefined;
  const m = dt.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s*UTC$/);
  if (!m) return dt;
  const d = new Date(`${m[1]}T${m[2]}Z`);
  return Number.isNaN(d.getTime()) ? dt : d.toISOString();
}
