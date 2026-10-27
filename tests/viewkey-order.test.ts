import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { writeFileSync } from "node:fs";
import { LiveChainAdapter, type CliRunner } from "../src/chain/live.ts";
import { executePay } from "../src/tools/pay.ts";
import { tempConfig, TEST_UFVK } from "./helpers.ts";

const UTEST = "utest1" + "q".repeat(100);

/** Live adapter that counts export_ufvk runs. Sends fail so nothing pretends to pay. */
function counting(exportFails = false, now?: () => number) {
  const calls = { exports: 0, other: 0 };
  const runner: CliRunner = async (_bin, args) => {
    if (args.includes("export_ufvk")) {
      calls.exports++;
      if (exportFails) throw new Error("wallet locked");
      return JSON.stringify({ ufvk: TEST_UFVK, birthday: 1 });
    }
    calls.other++;
    throw new Error("not in this test");
  };
  const opts = { network: "testnet", runner, ...(now ? { now } : {}) };
  return { calls, chain: new LiveChainAdapter(opts as ConstructorParameters<typeof LiveChainAdapter>[0]) };
}

function liveConfig() {
  const config = tempConfig({ chainMode: "live", chainNetwork: "testnet", spendingCapZec: "0.01" });
  writeFileSync(config.allowlistPath, JSON.stringify({ recipients: [{ address: UTEST }] }));
  return config;
}

describe("viewing key read order (V12 F-10)", () => {
  it("does not run export_ufvk for calls refused by cheap checks", async () => {
    const config = liveConfig();
    const { calls, chain } = counting();
    const refused = [
      { amount_zec: "0.001", recipient: "utest1" + "x".repeat(100) }, // not allow-listed
      { amount_zec: "5", recipient: UTEST }, // over the cap
      { amount_zec: "abc", recipient: UTEST }, // bad amount
      { amount_zec: "0.001", recipient: "u1" + "m".repeat(100) }, // mainnet address
      { amount_zec: "0.001", recipient: UTEST, memo: "x".repeat(600) }, // memo too long
    ];
    for (const input of refused) {
      const r = await executePay(input, { config, chain });
      assert.equal(r.ok, false, JSON.stringify(input));
    }
    assert.equal(calls.exports, 0);
  });

  it("backs off after export_ufvk fails instead of running it on every call", async () => {
    let t = 1_000_000;
    const { calls, chain } = counting(true, () => t);
    const config = liveConfig();
    const pay = () => executePay({ amount_zec: "0.001", recipient: UTEST }, { config, chain });
    for (let i = 0; i < 5; i++) assert.equal((await pay()).code, "VIEWKEY_UNAVAILABLE");
    assert.equal(calls.exports, 1);
    t += 1_000;
    await pay();
    assert.equal(calls.exports, 2);
    t += 1_000; // the second wait is 2s
    await pay();
    assert.equal(calls.exports, 2);
  });

  it("caps the backoff at about a minute", async () => {
    let t = 0;
    const { calls, chain } = counting(true, () => t);
    for (let i = 0; i < 12; i++) {
      await chain.getViewingKey().catch(() => undefined);
      t += 61_000;
    }
    assert.equal(calls.exports, 12);
  });
});
