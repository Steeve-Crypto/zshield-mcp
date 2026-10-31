import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertWalletPrivate, findOpenWalletPaths, WalletPermissionError } from "../src/chain/perms.ts";
import { restrictUmask, startupChecks } from "../src/startup.ts";
import { tempConfig } from "./helpers.ts";

function wallet(dirMode: number, fileMode: number): string {
  const dir = join(mkdtempSync(join(tmpdir(), "zshield-perms-")), "wallet");
  mkdirSync(dir);
  writeFileSync(join(dir, "zingo-wallet.dat"), "x");
  chmodSync(join(dir, "zingo-wallet.dat"), fileMode);
  chmodSync(dir, dirMode);
  return dir;
}

describe("findOpenWalletPaths", () => {
  it("accepts 700 and 600", () => {
    assert.deepEqual(findOpenWalletPaths(wallet(0o700, 0o600)), []);
  });
  it("accepts stricter modes", () => {
    assert.deepEqual(findOpenWalletPaths(wallet(0o700, 0o400)), []);
  });
  it("flags a world-readable file and a group-readable directory", () => {
    const dir = wallet(0o750, 0o644);
    const p = findOpenWalletPaths(dir);
    assert.deepEqual(
      p.map((x) => [x.path, x.mode, x.want]),
      [
        [dir, "750", "700"],
        [join(dir, "zingo-wallet.dat"), "644", "600"],
      ]
    );
  });
  it("flags group write even without read", () => {
    assert.equal(findOpenWalletPaths(wallet(0o700, 0o620)).length, 1);
  });
  it("skips a missing directory and Windows", () => {
    assert.deepEqual(findOpenWalletPaths("/nonexistent/zshield/wallet"), []);
    assert.deepEqual(findOpenWalletPaths(wallet(0o755, 0o644), "win32"), []);
  });
});

describe("assertWalletPrivate", () => {
  it("throws a fixable message naming each path when the directory is open", () => {
    const dir = wallet(0o755, 0o644);
    assert.throws(
      () => assertWalletPrivate(dir),
      (e: unknown) =>
        e instanceof WalletPermissionError &&
        e.message.includes("refusing to start") &&
        e.message.includes(`${dir} is 755, want 700`) &&
        e.message.includes("zingo-wallet.dat is 644, want 600") &&
        e.message.includes(`chmod 700 '${dir}'`)
    );
  });
  it("only warns about a loose file inside a private directory", () => {
    const dir = wallet(0o700, 0o644);
    const warnings = assertWalletPrivate(dir);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /zingo-wallet\.dat is 644, want 600/);
    assert.match(warnings[0], /chmod 600/);
  });
  it("returns no warnings for 700 and 600", () => {
    assert.deepEqual(assertWalletPrivate(wallet(0o700, 0o600)), []);
  });
});

describe("startupChecks", () => {
  it("refuses testnet mode when the wallet directory is open to other users", () => {
    const config = tempConfig({ chainMode: "live", chainNetwork: "testnet", zingoDataDir: wallet(0o755, 0o600) });
    assert.throws(() => startupChecks(config), WalletPermissionError);
  });
  it("starts in testnet mode with a private wallet", () => {
    const config = tempConfig({ chainMode: "live", chainNetwork: "testnet", zingoDataDir: wallet(0o700, 0o600) });
    assert.deepEqual(startupChecks(config), []);
  });
  it("starts with a warning when only the file is loose", () => {
    const config = tempConfig({ chainMode: "live", chainNetwork: "testnet", zingoDataDir: wallet(0o700, 0o644) });
    assert.equal(startupChecks(config).length, 1);
  });
  it("still refuses live mode without testnet", () => {
    const config = tempConfig({ chainMode: "live", zingoDataDir: wallet(0o700, 0o600) });
    assert.throws(() => startupChecks(config), /Mainnet is refused/);
  });
  it("does not check anything in mock mode", () => {
    const config = tempConfig({ zingoDataDir: wallet(0o700, 0o666) });
    assert.deepEqual(startupChecks(config), []);
  });
});

describe("restrictUmask", () => {
  it("sets umask 077 in testnet mode so new files are private", () => {
    const config = tempConfig({ chainMode: "live", chainNetwork: "testnet" });
    const before = restrictUmask(config);
    try {
      assert.notEqual(before, undefined);
      const f = join(mkdtempSync(join(tmpdir(), "zshield-umask-")), "new.dat");
      writeFileSync(f, "x");
      assert.equal(statSync(f).mode & 0o777, 0o600);
    } finally {
      if (before !== undefined) process.umask(before);
    }
  });
  it("leaves the umask alone in mock mode and on Windows", () => {
    assert.equal(restrictUmask(tempConfig()), undefined);
    assert.equal(restrictUmask(tempConfig({ chainMode: "live", chainNetwork: "testnet" }), "win32"), undefined);
  });
});

describe("server entry point", () => {
  it("exits 1 before serving when the testnet wallet directory is open to other users", async () => {
    const { spawnSync } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const { dirname } = await import("node:path");
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const dir = wallet(0o755, 0o644);
    const r = spawnSync(process.execPath, ["--import", "tsx", join(root, "src/index.ts")], {
      cwd: root,
      env: { ...process.env, CHAIN_MODE: "testnet", ZINGO_DATA_DIR: dir, AUDIT_DIR: join(dir, "..", "audits") },
      input: "",
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /refusing to start/);
    assert.match(r.stderr, /want 600/);
  });
});
