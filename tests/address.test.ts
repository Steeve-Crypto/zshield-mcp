import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MockChainAdapter, MOCK_RECEIVE_ADDRESS } from "../src/chain/mock.ts";
import { LiveChainAdapter, parseReceiveAddress, type CliRunner } from "../src/chain/live.ts";
import { executeReceiveAddress } from "../src/tools/address.ts";
import { readAuditRows, tempConfig } from "./helpers.ts";

const UA0 = "utest14dsty0x36sl2sq7aaq0drj7sgz2ep4clm9ervl3hqvqg428zzy0hn5k35jg3ra6u299ykqq7drjh4femrq2jn92t0ckkpl54mvkl5wdw";
const UA1 = "utest1" + "x".repeat(100);

// Shape captured from zingo-cli on testnet.
const addressesOut = (list: unknown[]) =>
  `Launching save task...\n${JSON.stringify(list, null, 2)}\nSave task shutdown successfully.`;
const ONE = addressesOut([
  { account: 0, address_index: 0, has_orchard: true, has_sapling: false, has_transparent: false, encoded_address: UA0 },
]);

const runnerFor = (out: string, calls: string[][] = []): CliRunner => async (_b, args) => {
  calls.push(args);
  return out;
};

describe("zingo-cli addresses parsing", () => {
  it("returns the only address", () => {
    assert.equal(parseReceiveAddress(ONE), UA0);
  });
  it("returns the newest address on account 0", () => {
    const out = addressesOut([
      { account: 0, address_index: 0, encoded_address: UA0 },
      { account: 0, address_index: 1, encoded_address: UA1 },
      { account: 1, address_index: 5, encoded_address: "utest1other" },
    ]);
    assert.equal(parseReceiveAddress(out), UA1);
  });
  it("throws on empty or broken output", () => {
    assert.throws(() => parseReceiveAddress("Error: no wallet"), /no address list/);
    assert.throws(() => parseReceiveAddress("[]"), /no unified address/);
    assert.throws(() => parseReceiveAddress("[ {not json} ]"), /unreadable/);
  });
});

describe("LiveChainAdapter.getReceiveAddress", () => {
  it("runs only the addresses command on testnet", async () => {
    const calls: string[][] = [];
    const a = new LiveChainAdapter({ network: "testnet", runner: runnerFor(ONE, calls) });
    assert.equal(await a.getReceiveAddress(), UA0);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].slice(0, 2), ["--chain", "testnet"]);
    assert.equal(calls[0].at(-1), "addresses");
  });
  it("refuses a mainnet address", async () => {
    const out = addressesOut([{ account: 0, address_index: 0, encoded_address: "u1mainnetaddress" }]);
    const a = new LiveChainAdapter({ network: "testnet", runner: runnerFor(out) });
    await assert.rejects(a.getReceiveAddress(), /Mainnet/);
  });
});

describe("executeReceiveAddress", () => {
  it("returns the mock address and audits the call without the address", async () => {
    const config = tempConfig();
    const r = await executeReceiveAddress({ config, chain: new MockChainAdapter() });
    assert.equal(r.ok, true);
    const body = JSON.parse(r.text);
    assert.equal(body.address, MOCK_RECEIVE_ADDRESS);
    assert.equal(body.network, "mock");
    const rows = readAuditRows(config);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].tool, "zcash_receive_address");
    assert.equal(rows[0].status, "ok");
    assert.ok(!JSON.stringify(rows[0]).includes(MOCK_RECEIVE_ADDRESS));
  });

  it("returns the testnet address in live mode", async () => {
    const config = tempConfig({ chainMode: "live", chainNetwork: "testnet" });
    const chain = new LiveChainAdapter({ network: "testnet", runner: runnerFor(ONE) });
    const body = JSON.parse((await executeReceiveAddress({ config, chain })).text);
    assert.equal(body.address, UA0);
    assert.equal(body.network, "testnet");
  });

  it("returns an error and audits it when the wallet answers with a mainnet address", async () => {
    const config = tempConfig({ chainMode: "live", chainNetwork: "testnet" });
    const out = addressesOut([{ account: 0, address_index: 0, encoded_address: "u1mainnetaddress" }]);
    const chain = new LiveChainAdapter({ network: "testnet", runner: runnerFor(out) });
    const r = await executeReceiveAddress({ config, chain });
    assert.equal(r.ok, false);
    assert.equal(readAuditRows(config)[0].status, "error");
  });
});
