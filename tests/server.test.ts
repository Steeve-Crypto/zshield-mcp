import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { connect, textOf } from "./helpers.ts";

describe("MCP server", () => {
  it("lists the tools", async () => {
    const { client } = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.ok(names.includes("zcash_pay"));
    assert.ok(names.includes("zcash_balance"));
    assert.ok(names.includes("zcash_receive_address"));
    assert.ok(names.includes("zcash_history"));
  });

  it("answers zcash_balance in mock mode", async () => {
    const { client } = await connect();
    const res = await client.callTool({ name: "zcash_balance", arguments: {} });
    assert.equal(res.isError, false);
    const body = JSON.parse(textOf(res));
    assert.equal(body.spendable_zec, "10");
  });

  it("answers zcash_receive_address in mock mode", async () => {
    const { client } = await connect();
    const res = await client.callTool({ name: "zcash_receive_address", arguments: {} });
    assert.equal(res.isError, false);
    assert.match(JSON.parse(textOf(res)).address, /^u1mockwallet/);
  });

  it("answers zcash_history and rejects a bad limit", async () => {
    const { client } = await connect();
    const ok = await client.callTool({ name: "zcash_history", arguments: { limit: 5 } });
    assert.equal(ok.isError, false);
    assert.equal(JSON.parse(textOf(ok)).count, 1);
    const bad = await client.callTool({ name: "zcash_history", arguments: { limit: 0 } });
    assert.equal(bad.isError, true);
    assert.match(JSON.parse(textOf(bad)).error, /limit must be/);
  });
});
