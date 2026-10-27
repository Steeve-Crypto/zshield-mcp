import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { defaultWalletDir, LiveChainAdapter } from "../src/chain/live.ts";
import * as live from "../src/chain/live.ts";
import { startupChecks } from "../src/startup.ts";
import { tempConfig, withEnv } from "./helpers.ts";

describe("wallet directory (V12 F-9)", () => {
  it("is absolute even when HOME is unset", async () => {
    await withEnv("HOME", undefined, async () => {
      const dir = defaultWalletDir();
      assert.ok(isAbsolute(dir), dir);
      assert.ok(!dir.includes("undefined"), dir);
      const adapter = new LiveChainAdapter({ network: "testnet" });
      assert.ok(isAbsolute(adapter.dataDir), adapter.dataDir);
    });
  });

  it("uses the OS home directory", () => {
    assert.equal(defaultWalletDir(), join(homedir(), ".zshield-testnet", "wallet"));
  });

  it("refuses when no home directory resolves", () => {
    const resolveWalletDir = (live as Record<string, unknown>).resolveWalletDir as
      | ((d: string | undefined, h: () => string) => string)
      | undefined;
    assert.ok(resolveWalletDir, "resolveWalletDir must exist");
    for (const home of [() => "", () => "relative/home", () => { throw new Error("no passwd entry"); }]) {
      assert.throws(() => resolveWalletDir(undefined, home), /Set ZINGO_DATA_DIR to an absolute path/);
    }
  });

  it("refuses a relative ZINGO_DATA_DIR in live mode", () => {
    const config = tempConfig({ chainMode: "live", chainNetwork: "testnet", zingoDataDir: "wallet" });
    assert.throws(() => startupChecks(config, "linux"), /must be an absolute path/);
    assert.throws(() => new LiveChainAdapter({ network: "testnet", dataDir: "wallet" }), /must be an absolute path/);
  });
});
