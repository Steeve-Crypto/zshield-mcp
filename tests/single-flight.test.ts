import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MockChainAdapter } from "../src/chain/mock.ts";
import { LiveChainAdapter } from "../src/chain/live.ts";
import { SendLock, BusyError, parseSendQueueWait, sendLockFor } from "../src/payments/lock.ts";
import { resetPaymentStores as resetPaymentIndexes } from "../src/payments/store.ts";
import { executePay } from "../src/tools/pay.ts";
import type { PaymentReceipt, PaymentRequest } from "../src/types.ts";
import { ALLOWED, readAuditRows, tempConfig } from "./helpers.ts";

/** Mock chain whose sends wait for `gate`, recording how many run at once. */
function slowChain() {
  const chain = new MockChainAdapter();
  const real = chain.pay.bind(chain);
  const stats = { running: 0, maxRunning: 0, sends: 0 };
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  chain.pay = async (req: PaymentRequest): Promise<PaymentReceipt> => {
    stats.running++;
    stats.sends++;
    stats.maxRunning = Math.max(stats.maxRunning, stats.running);
    await gate;
    stats.running--;
    return real(req);
  };
  return { chain, stats, open };
}

beforeEach(() => resetPaymentIndexes());

describe("single-flight sends", () => {
  it("runs one send at a time per wallet; the next one queues", async () => {
    const config = tempConfig({ sendQueueWaitMs: 5_000 });
    const { chain, stats, open } = slowChain();
    const a = executePay({ amount_zec: "0.001", recipient: ALLOWED }, { config, chain });
    const b = executePay({ amount_zec: "0.002", recipient: ALLOWED }, { config, chain });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(stats.sends, 1);
    open();
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra.ok, true);
    assert.equal(rb.ok, true);
    assert.equal(stats.maxRunning, 1);
    // The second pending row comes after the first call's result row.
    assert.deepEqual(readAuditRows(config).map((r) => r.status), ["pending", "ok", "pending", "ok"]);
  });

  it("returns BUSY after the bounded wait and sends nothing", async () => {
    const config = tempConfig({ sendQueueWaitMs: 50 });
    const { chain, stats, open } = slowChain();
    const a = executePay({ amount_zec: "0.001", recipient: ALLOWED }, { config, chain });
    await new Promise((r) => setTimeout(r, 10));
    const b = await executePay({ amount_zec: "0.002", recipient: ALLOWED }, { config, chain });
    assert.equal(b.code, "BUSY");
    assert.equal(JSON.parse(b.text).status, "error");
    assert.equal(stats.sends, 1);
    open();
    assert.equal((await a).ok, true);
    // No pending row for the BUSY call.
    const busyRows = readAuditRows(config).filter((r) => r.code === "BUSY");
    assert.equal(busyRows.length, 1);
    assert.equal(readAuditRows(config).filter((r) => r.call_id === busyRows[0].call_id).length, 1);
  });

  it("refused calls do not wait for the lock", async () => {
    const config = tempConfig({ sendQueueWaitMs: 5_000 });
    const { chain, open } = slowChain();
    const a = executePay({ amount_zec: "0.001", recipient: ALLOWED }, { config, chain });
    const t0 = Date.now();
    const r = await executePay({ amount_zec: "5", recipient: ALLOWED }, { config, chain });
    assert.equal(r.code, "CAP_EXCEEDED");
    assert.ok(Date.now() - t0 < 1_000);
    open();
    await a;
  });

  it("two live adapters on one wallet share the lock", () => {
    const one = new LiveChainAdapter({ network: "testnet", dataDir: "/tmp/w1" });
    const two = new LiveChainAdapter({ network: "testnet", dataDir: "/tmp/w1" });
    const other = new LiveChainAdapter({ network: "testnet", dataDir: "/tmp/w2" });
    assert.equal(sendLockFor(one.stateDir!), sendLockFor(two.stateDir!));
    assert.notEqual(sendLockFor(one.stateDir!), sendLockFor(other.stateDir!));
  });

  it("SendLock hands over in order and frees on release", async () => {
    const lock = new SendLock();
    const order: number[] = [];
    const r1 = await lock.acquire(10);
    const p2 = lock.acquire(1_000).then((r) => (order.push(2), r));
    const p3 = lock.acquire(1_000).then((r) => (order.push(3), r));
    r1();
    r1(); // a second release is ignored
    (await p2)();
    (await p3)();
    assert.deepEqual(order, [2, 3]);
    assert.equal(lock.locked, false);
    await assert.rejects(
      (async () => {
        const held = await lock.acquire(10);
        try {
          await lock.acquire(10);
        } finally {
          held();
        }
      })(),
      BusyError
    );
  });

  it("SEND_QUEUE_WAIT_MS accepts whole milliseconds in range", () => {
    assert.equal(parseSendQueueWait("2500"), 2500);
    assert.equal(parseSendQueueWait(0), 0);
    for (const bad of ["-1", "1.5", "abc", 600_001]) assert.throws(() => parseSendQueueWait(bad), /SEND_QUEUE_WAIT_MS/);
  });
});
