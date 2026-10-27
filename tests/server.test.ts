import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.ts";
import type { Config } from "../src/types.ts";
import { tempConfig } from "./helpers.ts";

export async function connect(config: Config = tempConfig()) {
  const server = createServer(config);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientT);
  return { client, config };
}

export function textOf(res: unknown): string {
  const content = (res as { content: { type: string; text: string }[] }).content;
  return content[0].text;
}

describe("MCP server", () => {
  it("lists the tools", async () => {
    const { client } = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.ok(names.includes("zcash_pay"));
    assert.ok(names.includes("zcash_balance"));
    assert.ok(names.includes("zcash_receive_address"));
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
});
