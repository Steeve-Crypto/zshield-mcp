// Shared helpers for the invariant suite (tests/invariants). Multi-process worlds, in the style
// of tests/race.test.ts, but on the suite's own driver and fake zingo-cli so the existing
// fixtures stay untouched.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
export const DRIVER = here("./fixtures/driver.mts");
export const ZINGO = here("./fixtures/fake-zingo-cli.mjs");
const TSX = import.meta.resolve("tsx");
export const RECIPIENT = "utest1" + "r".repeat(100);

export interface World {
  wallet: string;
  chain: string;
  root: string;
}

export function world(): World {
  const root = mkdtempSync(join(tmpdir(), "zshield-inv-"));
  const wallet = join(root, "wallet");
  const chain = join(root, "chain");
  mkdirSync(wallet, { mode: 0o700 });
  mkdirSync(chain);
  return { wallet, chain, root };
}

export interface Proc {
  child: ChildProcess;
  done: Promise<any>;
  /** Resolves when the process has exited, whatever it printed. */
  exited: Promise<void>;
}

export function proc(w: World, name: string, args: string[], env: Record<string, string> = {}, timeoutMs = 60_000): Proc {
  const cwd = join(w.root, name);
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, "allow.json"), JSON.stringify({ recipients: [{ address: RECIPIENT }] }));
  const child = spawn(process.execPath, ["--import", TSX, DRIVER, ...args], {
    cwd,
    detached: true,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: w.root,
      CHAIN_MODE: "testnet",
      ZINGO_BIN: ZINGO,
      ZINGO_DATA_DIR: w.wallet,
      AUDIT_DIR: "./audits",
      ALLOWLIST_PATH: "./allow.json",
      VIEW_KEY_FINGERPRINT_SALT: "inv",
      SEND_QUEUE_WAIT_MS: "8000",
      FAKE_ZINGO_STATE: w.chain,
      RACE_RECIPIENT: RECIPIENT,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout!.on("data", (d) => (out += d));
  child.stderr!.on("data", (d) => (err += d));
  let exited!: () => void;
  const exitP = new Promise<void>((r) => (exited = r));
  const done = new Promise<any>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${name} timed out: ${err.slice(0, 1500)} OUT:${out.slice(0, 500)}`)), timeoutMs);
    child.on("exit", (code, sig) => {
      clearTimeout(t);
      exited();
      const line = out.trim().split("\n").at(-1);
      try {
        resolve(JSON.parse(line ?? ""));
      } catch {
        reject(new Error(`${name} printed no result (exit ${code} ${sig ?? ""}). stderr: ${err.slice(0, 1500)}`));
      }
    });
  });
  // A killed process is expected in some tests: never leave an unhandled rejection behind.
  done.catch(() => undefined);
  return { child, done, exited: exitP };
}

export const readJsonl = (file: string): any[] =>
  existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
export const sends = (w: World) => readJsonl(join(w.chain, "sends.jsonl"));
export const staged = (w: World) => readJsonl(join(w.chain, "staged.jsonl"));
export const commands = (w: World) => readJsonl(join(w.chain, "commands.jsonl"));
export const overlap = (w: World) => {
  const f = join(w.chain, "overlap.log");
  return existsSync(f) ? readFileSync(f, "utf8") : "";
};

export async function until(check: () => boolean, what: string, ms = 20_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const killGroup = (c: ChildProcess, sig: NodeJS.Signals) => {
  try {
    process.kill(-c.pid!, sig);
  } catch {
    // already gone
  }
};

/** Stop a process right after its fence N returned, wait out the lease, and return a way to wake it. */
export function pauseFile(w: World, name: string) {
  const f = join(w.root, name);
  return {
    f,
    reached: () => existsSync(`${f}.reached`),
    go: () => writeFileSync(`${f}.go`, ""),
  };
}
