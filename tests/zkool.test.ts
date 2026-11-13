import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createGraphqlRunner, formatZec, ZkoolChainAdapter, zecToZats, type GraphqlRunner } from "../src/chain/zkool.ts";
import { SendOutcomeUnknownError } from "../src/chain/outcome.ts";
import type { PaymentRequest } from "../src/types.ts";
import { withEnv } from "./helpers.ts";

// Requirements for CHAIN_MODE=zkool, a testnet backend on a zkool_graphql server:
// 1. Every caller value (recipient, amount, memo) travels in GraphQL variables, never in
//    the query text, so a crafted recipient cannot add fields past the policy cap.
// 2. A send is staged like the zingo adapter's: the transaction is built and signed with
//    nothing broadcast, its txid is recorded durably through req.stage, and only then are
//    exactly those signed bytes broadcast. A failure before the broadcast sends nothing;
//    a failure during it is an unknown outcome carrying the staged txid.
// 3. A zkool server that cannot report the signed transaction's txid before broadcast is
//    refused: the payment is not sent rather than sent unstaged.
// 4. Amounts are whole zatoshis end to end, never rounded, and the planned transaction must
//    carry an output of exactly the requested amount before anything is signed.
// 5. Testnet only: a mainnet database or mainnet recipient is refused before any build.

const ADDR = "utest1" + "a".repeat(100);
const OWN = "utest1" + "o".repeat(100);
const UFVK = "uviewtest1" + "q".repeat(80);
const TXID = "c0".repeat(32);
const PCZT = "ab".repeat(40);
const SIGNED = "cd".repeat(60);

interface FakeOptions {
  ownAddress?: string;
  noTxidQuery?: boolean;
  txidAnswer?: unknown;
  plannedValue?: string;
  broadcast?: "ok" | "throws" | "other";
  onBroadcast?: () => void;
  history?: { txid: string; height: number; value: string; fee: string; time?: string }[];
  unconfirmed?: { txid: string; value: string }[];
}

/** A zkool_graphql stand-in. Records every operation and its variables. */
function fakeZkool(opts: FakeOptions = {}) {
  const calls: { op: string; query: string; variables: Record<string, unknown> }[] = [];
  const runner: GraphqlRunner = async (_url, query, variables) => {
    const op = /\{\s*(\w+)/.exec(query)?.[1] ?? "?";
    calls.push({ op, query, variables });
    switch (op) {
      case "addressByAccount":
        return { addressByAccount: { ua: opts.ownAddress ?? OWN } };
      case "unifiedFullViewingKey":
        return { unifiedFullViewingKey: UFVK };
      case "currentHeight":
        return { currentHeight: 1000 };
      case "accounts":
        return { accounts: [{ id: variables.account, height: 1000 }] };
      case "synchronize":
        return { synchronize: 1000 };
      case "balanceByAccount":
        return { balanceByAccount: { total: "1.00000000" }, unconfirmedByAccount: [] };
      case "prepareSend":
        return { prepareSend: PCZT };
      case "decodePczt": {
        const asked = (variables.pczt === PCZT && (calls.find((c) => c.op === "prepareSend")?.variables.payment as { recipients: { amount: string }[] }).recipients[0].amount) || "0";
        return { decodePczt: { fee: "0.00010000", recipients: [{ value: opts.plannedValue ?? asked }, { value: "0.50000000" }] } };
      }
      case "signTx":
        return { signTx: SIGNED };
      case "txid":
        if (opts.noTxidQuery) throw new Error('zkool_graphql: Unknown field "txid" on type "Query"');
        if ("txidAnswer" in opts) return { txid: opts.txidAnswer };
        return { txid: variables.txBytes === SIGNED ? TXID : "ff".repeat(32) };
      case "broadcastTx":
        opts.onBroadcast?.();
        if (opts.broadcast === "throws") throw new Error("The operation was aborted due to timeout");
        return { broadcastTx: opts.broadcast === "other" ? "ee".repeat(32) : TXID };
      case "transactionsByAccount":
        return { transactionsByAccount: opts.history ?? [], unconfirmedByAccount: opts.unconfirmed ?? [] };
      default:
        throw new Error(`unexpected operation ${op}`);
    }
  };
  return { runner, calls, ops: () => calls.map((c) => c.op) };
}

const adapter = (fake: ReturnType<typeof fakeZkool>) => new ZkoolChainAdapter({ network: "testnet", account: 3, runner: fake.runner });

describe("zkool adapter: staged send", () => {
  it("builds and signs, records the txid, then broadcasts exactly the signed bytes", async () => {
    const order: string[] = [];
    const fake = fakeZkool({ onBroadcast: () => order.push("broadcast") });
    const req: PaymentRequest = {
      amountZats: 123_456n,
      recipient: ADDR,
      memo: "order 7",
      stage: (txid) => order.push(`stage ${txid}`),
      authorizeFee: (fee) => order.push(`fee ${fee}`),
      beforeTransmit: () => order.push("beforeTransmit"),
      afterLock: () => order.push("afterLock"),
    };
    const receipt = await adapter(fake).pay(req);
    assert.equal(receipt.txid, TXID);
    assert.deepEqual(order, [`stage ${TXID}`, "fee 10000", "beforeTransmit", "afterLock", "broadcast"]);
    const broadcast = fake.calls.find((c) => c.op === "broadcastTx")!;
    assert.deepEqual(broadcast.variables, { txBytes: SIGNED, account: 3 });
    assert.ok(fake.ops().indexOf("signTx") < fake.ops().indexOf("txid"));
  });

  it("keeps the recipient, amount and memo out of the query text", async () => {
    const fake = fakeZkool();
    const sly = 'x" }, { address: "utest1evil", amount: "9';
    await adapter(fake).pay({ amountZats: 5000n, recipient: ADDR, memo: sly });
    const prepare = fake.calls.find((c) => c.op === "prepareSend")!;
    assert.ok(!prepare.query.includes(ADDR) && !prepare.query.includes("evil") && !prepare.query.includes("0.00005"));
    assert.deepEqual(prepare.variables.payment, { recipients: [{ address: ADDR, amount: "0.00005000", memo: sly }], confirmations: 1 });
    for (const c of fake.calls) assert.ok(!c.query.includes(ADDR), `${c.op} query text holds the recipient`);
  });

  it("broadcasts nothing when the txid cannot be recorded", async () => {
    const fake = fakeZkool();
    await assert.rejects(
      adapter(fake).pay({ amountZats: 5000n, recipient: ADDR, stage: () => { throw new Error("disk full"); } }),
      /disk full/
    );
    assert.ok(!fake.ops().includes("broadcastTx"));
  });

  it("broadcasts nothing when policy refuses at the transmit fence", async () => {
    const fake = fakeZkool();
    await assert.rejects(adapter(fake).pay({ amountZats: 5000n, recipient: ADDR, beforeTransmit: () => { throw new Error("paused"); } }), /paused/);
    assert.ok(!fake.ops().includes("broadcastTx"));
  });

  it("refuses a zkool without the txid query, before any broadcast", async () => {
    const fake = fakeZkool({ noTxidQuery: true });
    let staged = false;
    await assert.rejects(adapter(fake).pay({ amountZats: 5000n, recipient: ADDR, stage: () => { staged = true; } }), /txid/);
    assert.equal(staged, false);
    assert.ok(!fake.ops().includes("broadcastTx"));
  });

  it("refuses a txid answer that is not a transaction id, before any broadcast", async () => {
    for (const txidAnswer of [null, "", "xyz", "c0".repeat(31), 42]) {
      const fake = fakeZkool({ txidAnswer });
      let staged = false;
      await assert.rejects(adapter(fake).pay({ amountZats: 5000n, recipient: ADDR, stage: () => { staged = true; } }), /txid/, String(txidAnswer));
      assert.equal(staged, false);
      assert.ok(!fake.ops().includes("broadcastTx"));
    }
  });

  it("reports an unknown outcome with the staged txid when the broadcast fails or disagrees", async () => {
    for (const broadcast of ["throws", "other"] as const) {
      const err = await adapter(fakeZkool({ broadcast })).pay({ amountZats: 5000n, recipient: ADDR }).then(
        () => assert.fail("expected an unknown outcome"),
        (e: unknown) => e
      );
      assert.ok(err instanceof SendOutcomeUnknownError, broadcast);
      assert.equal((err as SendOutcomeUnknownError).txid, TXID);
    }
  });

  it("refuses a plan without an output of exactly the requested amount, before signing", async () => {
    const fake = fakeZkool({ plannedValue: "0.00005001" });
    await assert.rejects(adapter(fake).pay({ amountZats: 5000n, recipient: ADDR }), /requested amount/);
    assert.ok(!fake.ops().includes("signTx"));
  });

  it("refuses a mainnet database or recipient before building anything", async () => {
    const mainnetDb = fakeZkool({ ownAddress: "u1" + "m".repeat(100) });
    await assert.rejects(adapter(mainnetDb).pay({ amountZats: 5000n, recipient: ADDR }));
    assert.ok(!mainnetDb.ops().includes("prepareSend"));
    const fake = fakeZkool();
    await assert.rejects(adapter(fake).pay({ amountZats: 5000n, recipient: "u1" + "m".repeat(100) }), /Mainnet/);
    assert.deepEqual(fake.ops(), []);
    assert.throws(() => new ZkoolChainAdapter({ network: "mainnet", runner: fake.runner }), /testnet only/);
  });

  it("refuses an amount that is not a positive number of zatoshis, or a memo over 512 bytes", async () => {
    const a = adapter(fakeZkool());
    await assert.rejects(a.pay({ amountZats: 0n, recipient: ADDR }), /zatoshis/);
    await assert.rejects(a.pay({ amountZats: 21_000_000n * 100_000_000n + 1n, recipient: ADDR }), /zatoshis/);
    await assert.rejects(a.pay({ amountZats: 1n, recipient: ADDR, memo: "é".repeat(257) }), /512 bytes/);
  });
});

describe("zkool adapter: reads", () => {
  it("lists mined and mempool transactions, newest first, all verified, without outgoing notes", async () => {
    const fake = fakeZkool({
      history: [
        { txid: "11".repeat(32), height: 900, value: "0.50000000", fee: "0", time: "2026-11-12T10:00:00" },
        { txid: TXID, height: 950, value: "-0.00015000", fee: "0.00010000" },
      ],
      unconfirmed: [{ txid: "22".repeat(32), value: "-0.00020000" }],
    });
    const h = await adapter(fake).getHistory(Infinity);
    assert.deepEqual(h.map((t) => [t.txid.slice(0, 2), t.status, t.kind, t.valueZats]), [
      ["22", "mempool", "sent", 20000n],
      ["c0", "confirmed", "sent", 5000n],
      ["11", "confirmed", "received", 50000000n],
    ]);
    assert.ok(h.every((t) => t.verified === true && t.outgoing === undefined));
    assert.equal(h[2].time, "2026-11-12T10:00:00.000Z");
    assert.equal(h[1].blockHeight, 950);
  });

  it("reports health from the server tip, the account height and its balance", async () => {
    const h = await withEnv("HEALTH_SYNC_TIMEOUT_MS", "1000", () => adapter(fakeZkool()).checkHealth());
    assert.deepEqual(h, { walletHeight: 1000, chainTip: 1000, spendableZats: 100_000_000n, synced: true });
  });

  it("reads exact zatoshis and writes 8-decimal ZEC, never rounding", () => {
    assert.equal(zecToZats("0.00000001", "x"), 1n);
    assert.equal(zecToZats("-1.13090000", "x"), -113_090_000n);
    assert.equal(zecToZats("2", "x"), 200_000_000n);
    assert.throws(() => zecToZats("0.123456789", "x"));
    assert.throws(() => zecToZats("1e-8", "x"));
    assert.equal(formatZec(1n), "0.00000001");
    assert.equal(formatZec(123_456_789n), "1.23456789");
  });
});

describe("zkool GraphQL runner", () => {
  it("sends the operation as JSON with its variables, and fails on a bad status or GraphQL errors", async () => {
    let body: unknown;
    let signal: AbortSignal | undefined;
    const ok = createGraphqlRunner((async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      signal = init.signal ?? undefined;
      return new Response(JSON.stringify({ data: { currentHeight: 7 } }), { status: 200 });
    }) as typeof fetch);
    assert.deepEqual(await ok("http://127.0.0.1:8000/", "query { currentHeight }", { a: 1 }, 5000), { currentHeight: 7 });
    assert.deepEqual(body, { query: "query { currentHeight }", variables: { a: 1 } });
    assert.ok(signal, "every request has a timeout");
    const down = createGraphqlRunner((async () => new Response("bad gateway", { status: 502, statusText: "Bad Gateway" })) as typeof fetch);
    await assert.rejects(down("http://x", "query { a }", {}, 5000), /502/);
    const refused = createGraphqlRunner((async () => new Response(JSON.stringify({ errors: [{ message: "No Signing Key" }] }), { status: 200 })) as typeof fetch);
    await assert.rejects(refused("http://x", "query { a }", {}, 5000), /No Signing Key/);
  });
});
