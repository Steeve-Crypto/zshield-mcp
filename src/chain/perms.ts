import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Group and other permission bits. Any of them set means another local user may get in. */
const OPEN_BITS = 0o077;

export interface PermissionProblem {
  path: string;
  /** Octal mode, for example "755" */
  mode: string;
  /** What the mode should be */
  want: "700" | "600";
}

/**
 * Find wallet paths that a group or other users can read, write, or enter: the data
 * directory itself (want 700) and every file directly inside it (want 600). Returns an
 * empty list on Windows, where POSIX modes do not apply, and when the directory is missing.
 */
export function findOpenWalletPaths(dataDir: string, platform: string = process.platform): PermissionProblem[] {
  if (platform === "win32" || !existsSync(dataDir)) return [];
  const problems: PermissionProblem[] = [];
  const check = (path: string, want: "700" | "600") => {
    const mode = statSync(path).mode & 0o777;
    if (mode & OPEN_BITS) problems.push({ path, mode: mode.toString(8).padStart(3, "0"), want });
  };
  check(dataDir, "700");
  for (const name of readdirSync(dataDir)) {
    const path = join(dataDir, name);
    const st = statSync(path);
    if (st.isFile()) check(path, "600");
    else if (st.isDirectory()) check(path, "700");
  }
  return problems;
}

export class WalletPermissionError extends Error {
  constructor(readonly problems: PermissionProblem[], dataDir: string) {
    super(
      [
        "zshield-mcp: refusing to start. The wallet holds spending keys and other local users can reach it:",
        ...problems.map((p) => `  ${p.path} is ${p.mode}, want ${p.want}`),
        `Fix it with: chmod 700 '${dataDir}' && chmod 600 '${dataDir}'/*`,
      ].join("\n")
    );
    this.name = "WalletPermissionError";
  }
}

/**
 * Throws WalletPermissionError when the wallet directory (or a folder in it) is open to
 * group or other users, since then they can read the keys. Loose file modes inside a
 * private directory only produce warnings: nobody else can reach those files, and
 * zingo-cli recreates the wallet file with the default umask every time it saves, so
 * refusing on them would block startup after every manual zingo-cli run.
 * Returns the warnings, if any.
 */
export function assertWalletPrivate(dataDir: string, platform: string = process.platform): string[] {
  const problems = findOpenWalletPaths(dataDir, platform);
  if (problems.some((p) => p.want === "700")) throw new WalletPermissionError(problems, dataDir);
  return problems.map(
    (p) =>
      `zshield-mcp: warning: ${p.path} is ${p.mode}, want ${p.want}. Its directory is private, so other users cannot reach it. Fix with: chmod 600 '${p.path}'`
  );
}
