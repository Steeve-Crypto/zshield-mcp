import { resolveWalletDir } from "./chain/live.js";
import { assertWalletPrivate } from "./chain/perms.js";
import type { Config } from "./types.js";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fallbackAuditPath } from "./audit/log.js";
import { assertSafeAncestors, checkPrivateFile, ensurePrivateDir } from "./fsafe.js";
import { pinDir } from "./chain/pin.js";
import { assertAllowlistFileSafe } from "./policy/allowlist.js";
import { resolveStateDir, walletStateDir } from "./payments/store.js";

export interface StartupDeps {
  /** The payment store folder; defaults to the one createChain gives the chain. */
  stateDir?: string;
}

/** The payment store folder the server will use for this config. */
export function stateDirFor(config: Config): string {
  if (config.chainMode === "live") return walletStateDir(resolveWalletDir(config.zingoDataDir));
  return resolveStateDir(config, { stateDir: config.zingoDataDir ? walletStateDir(config.zingoDataDir) : undefined });
}

/**
 * The audit dir, the audit fallback file, and the payment store hold recipients, memos,
 * and payment state. On POSIX: create them private, refuse a symlink or another owner
 * (for the dirs and every file in them), and repair loose modes, returning a note for each
 * repair. Windows has no modes and no check: mock state there has no ACL protection.
 */
export function checkRecordPaths(config: Config, stateDir: string, platform: string = process.platform): string[] {
  if (platform === "win32") return [];
  const notes: string[] = [];
  const note = (n: string | undefined) => {
    if (n) notes.push(`zshield-mcp: repaired permissions: ${n}`);
  };
  // No directory above these paths may let another user swap them. The allow-list file
  // itself must not be a symlink, another user's, or writable by group or other.
  for (const p of [config.auditDir, stateDir, config.allowlistPath]) assertSafeAncestors(p);
  assertAllowlistFileSafe(config.allowlistPath);
  for (const dir of [config.auditDir, stateDir]) {
    note(ensurePrivateDir(dir));
  }
  for (const name of readdirSync(config.auditDir)) {
    if (name.endsWith(".jsonl")) note(checkPrivateFile(join(config.auditDir, name)));
  }
  note(checkPrivateFile(fallbackAuditPath(config.auditDir, config.auditFallbackPath)));
  for (const sub of ["keys", "calls", "pending", "txids"]) note(ensurePrivateDir(join(stateDir, sub)));
  note(checkPrivateFile(join(stateDir, "wallet.lock")));
  note(checkPrivateFile(join(stateDir, "meta.json")));
  return notes;
}

/**
 * Checks that must pass before the server accepts any call. Throws with a message meant
 * for the operator. In testnet mode: the network must be testnet, and the wallet directory
 * must not be open to group or other users. Returns warnings to print, such as a loose
 * file mode inside a private wallet directory. Live mode is refused on Windows. Mock mode
 * has no wallet to check.
 */
export function startupChecks(config: Config, platform: string = process.platform, deps: StartupDeps = {}): string[] {
  if (config.chainMode !== "live") {
    return checkRecordPaths(config, deps.stateDir ?? stateDirFor(config), platform);
  }
  if (config.chainNetwork !== "testnet") {
    throw new Error("zshield-mcp: live mode requires CHAIN_MODE=testnet. Mainnet is refused.");
  }
  if (platform === "win32") {
    throw new Error("zshield-mcp: testnet mode is not supported on Windows. Use mock mode there, or run testnet mode on Linux or macOS.");
  }
  const dataDir = resolveWalletDir(config.zingoDataDir);
  // The wallet must already exist: a missing path could be planted before it is created.
  if (!existsSync(dataDir)) {
    throw new Error("zshield-mcp: the wallet directory does not exist. Create the wallet with zingo-cli first, then start the server.");
  }
  // Pin its real path, and judge the directories above that path, not above a symlink to it.
  const pin = pinDir(dataDir);
  assertSafeAncestors(pin.path);
  const stateDir = deps.stateDir ?? walletStateDir(pin.path);
  const warnings = assertWalletPrivate(pin.path, platform);
  warnings.push(...checkRecordPaths(config, stateDir, platform));
  return warnings;
}

/**
 * Everything that runs before the server takes a call: the checks above, then the umask.
 * index.ts calls this; a throw stops the process.
 */
export function runStartup(config: Config, platform: string = process.platform, deps: StartupDeps = {}): string[] {
  const warnings = startupChecks(config, platform, deps);
  restrictUmask(config, platform);
  return warnings;
}

/**
 * In testnet mode, make every file this process and its zingo-cli children create private
 * (umask 077). zingo-cli rewrites the wallet file on each save, so this keeps it at 600
 * when the server is the one running zingo-cli. Audit files become 600 as well.
 * Returns the previous umask, or undefined when nothing changed. Windows has no umask
 * and no live mode.
 */
export function restrictUmask(config: Config, platform: string = process.platform): number | undefined {
  if (config.chainMode !== "live" || platform === "win32") return undefined;
  return process.umask(0o077);
}
