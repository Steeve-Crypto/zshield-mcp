import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Runs `icacls <path>` and returns its output. Injectable for tests. */
export type IcaclsRunner = (path: string) => string;

export const defaultIcacls: IcaclsRunner = (path) =>
  execFileSync("icacls", [path], { encoding: "utf8", timeout: 10_000, windowsHide: true });

/** Runs the icacls command that makes dataDir private to the current account. */
export type AclHardener = (dataDir: string) => void;

export const defaultHardener: AclHardener = (dataDir) => {
  const user = process.env.USERNAME;
  if (!user) throw new AclCheckError("USERNAME is not set");
  execFileSync("icacls", [dataDir, "/inheritance:r", "/grant:r", `${user}:(OI)(CI)F`, "/T", "/Q"], {
    timeout: 30_000,
    windowsHide: true,
  });
};

/** Set to 1 to let startup remove broad access from the wallet directory itself. */
export const WINDOWS_ACL_HARDEN = "ZSHIELD_HARDEN_WINDOWS_ACL";

/** Set to 1 to start live mode on Windows when the wallet ACL cannot be checked. */
export const WINDOWS_ACL_OPT_IN = "ZSHIELD_ALLOW_UNCHECKED_WINDOWS_ACL";

/** Principals that cover every local user or more. Names as icacls prints them, and their SIDs. */
const BROAD_PRINCIPALS = [
  "everyone",
  "builtin\\users",
  "users",
  "nt authority\\authenticated users",
  "authenticated users",
  "builtin\\guests",
  "guests",
  "nt authority\\anonymous logon",
  "anonymous logon",
  "nt authority\\interactive",
  "interactive",
  "nt authority\\network",
  "*s-1-1-0",
  "*s-1-5-32-545",
  "*s-1-5-11",
  "*s-1-5-32-546",
  "*s-1-5-7",
  "*s-1-5-4",
  "*s-1-5-2",
];

/** Rights that include reading data: full, modify, read and execute, read, generic read or all, read data. */
const READ_RIGHTS = new Set(["F", "M", "RX", "R", "GR", "GA", "RD"]);

export interface AclProblem {
  path: string;
  principal: string;
  rights: string;
}

export class AclCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AclCheckError";
  }
}

/**
 * Parse icacls output into ACEs that give a broad principal read access. Deny entries are
 * skipped. Throws AclCheckError when the output has no ACE lines at all, since then the
 * check cannot be trusted.
 */
export function parseIcacls(path: string, out: string): AclProblem[] {
  const problems: AclProblem[] = [];
  let aces = 0;
  for (const raw of out.split(/\r?\n/)) {
    // Each ACE line is "<path or spaces> PRINCIPAL:(flags)(rights)". The path is only on the first line.
    const line = raw.startsWith(path) ? raw.slice(path.length) : raw;
    const m = line.trim().match(/^(.+?):((?:\([^)]*\))+)$/);
    if (!m) continue;
    aces++;
    const principal = m[1].trim();
    const groups = [...m[2].matchAll(/\(([^)]*)\)/g)].map((g) => g[1]);
    if (groups.some((g) => g === "DENY")) continue;
    const rights = groups.flatMap((g) => g.split(","));
    if (!BROAD_PRINCIPALS.includes(principal.toLowerCase())) continue;
    if (rights.some((r) => READ_RIGHTS.has(r))) problems.push({ path, principal, rights: m[2] });
  }
  if (aces === 0) throw new AclCheckError(`icacls printed no access entries for ${path}`);
  return problems;
}

/** Check the wallet directory and every entry directly in it. */
export function findOpenWindowsWalletPaths(dataDir: string, icacls: IcaclsRunner = defaultIcacls): AclProblem[] {
  if (!existsSync(dataDir)) return [];
  const paths = [dataDir, ...readdirSync(dataDir).map((n) => join(dataDir, n))].filter((p) => {
    const st = statSync(p);
    return st.isFile() || st.isDirectory();
  });
  const problems: AclProblem[] = [];
  for (const p of paths) {
    let out: string;
    try {
      out = icacls(p);
    } catch (e) {
      throw new AclCheckError(`icacls could not read the ACL of ${p}: ${e instanceof Error ? e.message : String(e)}`);
    }
    problems.push(...parseIcacls(p, out));
  }
  return problems;
}

export class WindowsAclError extends Error {
  constructor(readonly problems: AclProblem[], dataDir: string) {
    super(
      [
        "zshield-mcp: refusing to start. The wallet holds spending keys and broad groups can read it:",
        ...problems.map((p) => `  ${p.path}: ${p.principal} ${p.rights}`),
        "Fix it so only your account has access, for example:",
        `  icacls "${dataDir}" /inheritance:r /grant:r "%USERNAME%:(OI)(CI)F" /T`,
      ].join("\n")
    );
    this.name = "WindowsAclError";
  }
}

/**
 * Windows live mode: refuse when Everyone, Users, Authenticated Users, or a similar broad
 * group can read the wallet directory or a file in it. The directory's inheritable entries
 * decide what new wallet files get, so a private directory also covers files zingo-cli
 * writes later. When the ACL cannot be read, refuse unless the operator opted in with
 * ZSHIELD_ALLOW_UNCHECKED_WINDOWS_ACL=1; then return a warning instead. With
 * ZSHIELD_HARDEN_WINDOWS_ACL=1, broad access is removed with icacls and checked again.
 */
export function assertWindowsWalletPrivate(
  dataDir: string,
  icacls: IcaclsRunner = defaultIcacls,
  env: NodeJS.ProcessEnv = process.env,
  harden: AclHardener = defaultHardener
): string[] {
  let problems: AclProblem[];
  try {
    problems = findOpenWindowsWalletPaths(dataDir, icacls);
  } catch (e) {
    if (!(e instanceof AclCheckError)) throw e;
    if (env[WINDOWS_ACL_OPT_IN] === "1") {
      return [`zshield-mcp: warning: wallet ACL not checked (${e.message}). Starting because ${WINDOWS_ACL_OPT_IN}=1.`];
    }
    throw new AclCheckError(
      `zshield-mcp: refusing to start. ${e.message}. Fix icacls access, or set ${WINDOWS_ACL_OPT_IN}=1 to start without the check.`
    );
  }
  if (problems.length > 0 && env[WINDOWS_ACL_HARDEN] === "1") {
    // Opted in: strip inherited and broad entries, leave full control for this account, then check again.
    try {
      harden(dataDir);
    } catch {
      throw new WindowsAclError(problems, dataDir);
    }
    const after = findOpenWindowsWalletPaths(dataDir, icacls);
    if (after.length > 0) throw new WindowsAclError(after, dataDir);
    return [`zshield-mcp: removed broad access from ${dataDir} (${WINDOWS_ACL_HARDEN}=1).`];
  }
  if (problems.length > 0) throw new WindowsAclError(problems, dataDir);
  return [];
}
