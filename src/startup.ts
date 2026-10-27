import { defaultWalletDir } from "./chain/live.js";
import { assertWalletPrivate } from "./chain/perms.js";
import type { Config } from "./types.js";

/**
 * Checks that must pass before the server accepts any call. Throws with a message meant
 * for the operator. In testnet mode: the network must be testnet, and the wallet directory
 * must not be open to group or other users. Returns warnings to print, such as a loose
 * file mode inside a private wallet directory. Mock mode has no wallet to check.
 */
export function startupChecks(config: Config, platform: string = process.platform): string[] {
  if (config.chainMode !== "live") return [];
  if (config.chainNetwork !== "testnet") {
    throw new Error("zshield-mcp: live mode requires CHAIN_MODE=testnet. Mainnet is refused.");
  }
  return assertWalletPrivate(config.zingoDataDir ?? defaultWalletDir(), platform);
}

/**
 * In testnet mode, make every file this process and its zingo-cli children create private
 * (umask 077). zingo-cli rewrites the wallet file on each save, so this keeps it at 600
 * when the server is the one running zingo-cli. Audit files become 600 as well.
 * Returns the previous umask, or undefined when nothing changed.
 */
export function restrictUmask(config: Config, platform: string = process.platform): number | undefined {
  if (config.chainMode !== "live" || platform === "win32") return undefined;
  return process.umask(0o077);
}
