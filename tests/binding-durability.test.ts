import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it, mock } from "node:test";
import { MockChainAdapter } from "../src/chain/mock.ts";
import { storeFor } from "../src/payments/store.ts";
import { executePay } from "../src/tools/pay.ts";
import { tempConfig, ALLOWED } from "./helpers.ts";

describe("binding durability", () => {
  it("F-37 published but unsynced binding never permits send and same key retries safely", async () => {
    const config = tempConfig(), chain = new MockChainAdapter(), store = storeFor(config, chain);
    const pay = mock.method(chain, "pay");
    const real = fs.fsyncSync;
    const injected = mock.method(fs, "fsyncSync", (fd: number) => {
      if (fs.fstatSync(fd).isDirectory() && fs.realpathSync(`/proc/self/fd/${fd}`).endsWith("/keys")) {
        throw Object.assign(new Error("directory sync failed"), { code: "EIO" });
      }
      return real(fd);
    });
    const input = { amount_zec: "0.001", recipient: ALLOWED, idempotency_key: "durable" };
    try {
      const result = await executePay(input, { config, chain, store });
      assert.equal(result.code, "STATE_WRITE_FAILED", result.text);
      assert.equal(pay.mock.callCount(), 0);
      const binding = store.readKey("durable")!;
      assert.ok(binding, "publication must not be rolled back unsafely");
      assert.equal(store.bindingRetryable(binding), true);
    } finally { injected.mock.restore(); }
    const retried = await executePay(input, { config, chain, store });
    assert.equal(retried.ok, true, retried.text);
    assert.equal(pay.mock.callCount(), 1);
    assert.equal((await executePay(input, { config, chain, store })).ok, true);
    assert.equal(pay.mock.callCount(), 1);
  });
});
