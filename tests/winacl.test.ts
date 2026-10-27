import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startupChecks } from "../src/startup.ts";
import { tempConfig } from "./helpers.ts";

/** Real icacls layout: the path on the first ACE line, later lines indented to match. */
function icaclsOut(path: string, aces: string[]): string {
  const pad = " ".repeat(path.length + 1);
  return aces.map((a, i) => (i === 0 ? `${path} ${a}` : `${pad}${a}`)).join("\r\n") + "\r\n\r\nSuccessfully processed 1 files; Failed processing 0 files\r\n";
}

const PRIVATE = ["DESKTOP-1\\alice:(OI)(CI)(F)", "NT AUTHORITY\\SYSTEM:(OI)(CI)(F)", "BUILTIN\\Administrators:(OI)(CI)(F)"];

function walletDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "zshield-winacl-"));
  writeFileSync(join(dir, "zingo-wallet.dat"), "x");
  return dir;
}

function run(aclFor: (p: string) => string[], env: NodeJS.ProcessEnv = {}, harden?: (d: string) => void) {
  const dir = walletDir();
  const config = tempConfig({ chainMode: "live", chainNetwork: "testnet", zingoDataDir: dir });
  const calls: string[] = [];
  const icacls = (p: string) => {
    calls.push(p);
    return icaclsOut(p, aclFor(p));
  };
  const deps = { icacls, env, harden } as Parameters<typeof startupChecks>[2];
  return { dir, calls, config, check: () => startupChecks(config, "win32", deps) };
}

describe("Windows wallet ACL check (V12 F-11)", () => {
  it("refuses when Everyone can read the wallet directory", () => {
    const { check } = run(() => [...PRIVATE, "Everyone:(OI)(CI)(RX)"]);
    assert.throws(check, /Everyone/);
  });

  it("refuses when Users or Authenticated Users can read the wallet file", () => {
    for (const broad of ["BUILTIN\\Users:(I)(RX)", "NT AUTHORITY\\Authenticated Users:(I)(M)", "*S-1-1-0:(R)"]) {
      const { check } = run((p) => (p.endsWith(".dat") ? [...PRIVATE, broad] : PRIVATE));
      assert.throws(check, /refusing to start/, broad);
    }
  });

  it("checks the wallet directory and its files, the audit dir, and the payment store", () => {
    const { check, calls, dir, config } = run(() => PRIVATE);
    assert.deepEqual(check(), []);
    const state = join(dir, ".zshield-state");
    assert.deepEqual([...new Set(calls)].sort(), [dir, join(dir, "zingo-wallet.dat"), state, config.auditDir].sort());
  });

  it("ignores deny entries and write-only grants", () => {
    const { check } = run(() => [...PRIVATE, "Everyone:(DENY)(R)", "BUILTIN\\Users:(AD)"]);
    assert.deepEqual(check(), []);
  });

  it("refuses when the ACL cannot be read, unless opted in", () => {
    const failing = run(() => []);
    assert.throws(failing.check, /ZSHIELD_ALLOW_UNCHECKED_WINDOWS_ACL/);
    const optedIn = run(() => [], { ZSHIELD_ALLOW_UNCHECKED_WINDOWS_ACL: "1" });
    const warnings = optedIn.check();
    assert.equal(warnings.length, 3); // the wallet, the audit dir, the payment store
    for (const w of warnings) assert.match(w, /not checked/);
  });

  it("hardens the directory when asked, then checks again", () => {
    let hardened = false;
    const { check } = run(
      () => (hardened ? PRIVATE : [...PRIVATE, "Everyone:(OI)(CI)(RX)"]),
      { ZSHIELD_HARDEN_WINDOWS_ACL: "1" },
      () => {
        hardened = true;
      }
    );
    const warnings = check();
    assert.equal(hardened, true);
    assert.match(warnings[0], /removed broad access/);
  });

  it("still refuses when hardening did not help", () => {
    const { check } = run(() => [...PRIVATE, "Everyone:(OI)(CI)(RX)"], { ZSHIELD_HARDEN_WINDOWS_ACL: "1" }, () => {});
    assert.throws(check, /Everyone/);
  });
});
