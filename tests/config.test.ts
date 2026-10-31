import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";

const KEYS = ["CHAIN_MODE", "SPENDING_CAP_ZEC"];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const emptyDir = () => mkdtempSync(join(tmpdir(), "zshield-cfg-"));

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("loadConfig", () => {
  it("defaults to mock mode with a 0.1 ZEC cap", () => {
    for (const k of KEYS) delete process.env[k];
    const c = loadConfig(emptyDir());
    assert.equal(c.chainMode, "mock");
    assert.equal(c.spendingCapZec, 0.1);
    assert.equal(c.chainNetwork, undefined);
  });
  it("maps testnet to the live adapter on testnet", () => {
    process.env.CHAIN_MODE = "testnet";
    const c = loadConfig(emptyDir());
    assert.equal(c.chainMode, "live");
    assert.equal(c.chainNetwork, "testnet");
  });
  it("rejects unknown chain modes such as mainnet", () => {
    process.env.CHAIN_MODE = "mainnet";
    assert.throws(() => loadConfig(emptyDir()), /Unknown CHAIN_MODE/);
  });
  it("rejects a non-numeric spending cap", () => {
    delete process.env.CHAIN_MODE;
    process.env.SPENDING_CAP_ZEC = "abc";
    assert.throws(() => loadConfig(emptyDir()), /SPENDING_CAP_ZEC/);
  });
  it("keeps an env spending cap as an exact decimal string", () => {
    delete process.env.CHAIN_MODE;
    process.env.SPENDING_CAP_ZEC = "0.25";
    assert.equal(loadConfig(emptyDir()).spendingCapZec, "0.25");
  });
  it("rejects a spending cap with more than 8 decimals", () => {
    delete process.env.CHAIN_MODE;
    process.env.SPENDING_CAP_ZEC = "0.123456789";
    assert.throws(() => loadConfig(emptyDir()), /more than 8 decimal places/);
  });
  it("rejects zero, negative, and non-finite spending caps", () => {
    delete process.env.CHAIN_MODE;
    for (const v of ["0", "-0.1", "Infinity", "NaN"]) {
      process.env.SPENDING_CAP_ZEC = v;
      assert.throws(() => loadConfig(emptyDir()), /SPENDING_CAP_ZEC/, v);
    }
  });
});
