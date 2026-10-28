import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { resetPaymentStores } from "../src/payments/store.ts";
import { executePay } from "../src/tools/pay.ts";
import type { ChainAdapter } from "../src/chain/types.ts";
import { readAuditRows, tempConfig, TEST_UFVK } from "./helpers.ts";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Regression tests for run 7. Each uses entry points that exist at f96891d, so the file
// can be run against it to show the new behavior fails there.

const R = "utest1" + "r".repeat(100);

beforeEach(() => resetPaymentStores());

function liveConfig() {
  const dir = mkdtempSync(join(tmpdir(), "zshield-r7-"));
  const allow = join(dir, "allow.json");
  writeFileSync(allow, JSON.stringify({ recipients: [{ address: R }] }));
  return tempConfig({ chainMode: "live", chainNetwork: "testnet", allowlistPath: allow });
}

describe("live sends need an idempotency key", () => {
  it("a live payment without a key is refused before anything is sent", async () => {
    const config = liveConfig();
    let sends = 0;
    const chain = {
      mode: "live",
      async pay() { sends++; return { txid: "a".repeat(64) }; },
      getViewingKey: async () => TEST_UFVK,
    } as unknown as ChainAdapter;
    const r = await executePay({ amount_zec: "0.0001", recipient: R }, { config, chain });
    assert.equal(r.ok, false);
    assert.equal(r.code, "IDEMPOTENCY_KEY_REQUIRED");
    assert.equal(sends, 0);
    assert.deepEqual(readAuditRows(config).map((x) => x.status), ["rejected"]);
  });

  it("a mock payment still works without a key", async () => {
    const { MockChainAdapter } = await import("../src/chain/mock.ts");
    const { ALLOWED } = await import("./helpers.ts");
    const r = await executePay({ amount_zec: "0.001", recipient: ALLOWED }, { config: tempConfig(), chain: new MockChainAdapter() });
    assert.equal(r.ok, true);
  });
});

// A live send is two steps: build and sign (no broadcast), then transmit that txid. The txid
// is bound to the call between them, so recovery never has to guess which transaction it was.
describe("staged live send binds the txid before it is transmitted", () => {
  const STAGED = "7a".repeat(32);
  const LOOKALIKE = "7b".repeat(32);

  async function unknownCall() {
    const { LiveChainAdapter } = await import("../src/chain/live.ts");
    const { CliTimeoutError } = await import("../src/chain/outcome.ts");
    const { storeFor } = await import("../src/payments/store.ts");
    const { withUfvk } = await import("./helpers.ts");
    const config = liveConfig();
    const d = mkdtempSync(join(tmpdir(), "zshield-r7w-"));
    const steps: string[] = [];
    let ownerAtTransmit: string | undefined = "unset";
    // eslint-disable-next-line prefer-const
    let chain: InstanceType<typeof LiveChainAdapter>;
    const runner = async (_b: string, args: string[], opts?: { input?: string }) => {
      const input = opts?.input ?? "";
      if (/^(quicksend|send) /.test(input)) {
        steps.push(input.split(" ")[0]);
        return `{\n  "fee": 10000\n}\n{\n  "txids": [\n    "${STAGED}"\n  ]\n}\n`;
      }
      if (input.startsWith("transmit ")) {
        steps.push("transmit");
        ownerAtTransmit = storeFor(config, chain).txidOwner(STAGED);
        throw new CliTimeoutError("stopped after 900000 ms");
      }
      throw new Error(`unexpected ${args.at(-1)}`);
    };
    chain = new LiveChainAdapter({ network: "testnet", runner: withUfvk(runner as never, {}, false), dataDir: d, stateDir: join(d, ".zshield-state") });
    const r = await executePay({ idempotency_key: "r7-staged-1", amount_zec: "0.0001", recipient: R, memo: "rent" }, { config, chain });
    return { config, chain, r, steps, owner: () => ownerAtTransmit };
  }

  it("the txid is on record, owned by the call, before the transmit step runs", async () => {
    const { r, steps, owner } = await unknownCall();
    const body = JSON.parse(r.text);
    assert.equal(body.code, "SEND_UNCONFIRMED");
    assert.deepEqual(steps, ["send", "transmit"]);
    assert.equal(owner(), body.call_id);
    assert.deepEqual(body.possible_txids, [STAGED]);
  });

  it("a repeat call with the same key returns the unknown outcome and builds nothing new", async () => {
    const { config, chain, steps } = await unknownCall();
    const again = await executePay({ idempotency_key: "r7-staged-1", amount_zec: "0.0001", recipient: R, memo: "rent" }, { config, chain });
    assert.notEqual(again.ok, true);
    assert.deepEqual(steps, ["send", "transmit"]);
  });

  function historyChain(base: ChainAdapter, history: Record<string, unknown>[]) {
    return Object.assign(Object.create(base), {
      getHistory: async () => history,
      checkHealth: async () => ({ walletHeight: 1000, chainTip: 1001, spendableZats: 0n }),
    }) as ChainAdapter;
  }
  const entry = (txid: string, extra: Record<string, unknown> = {}) => ({
    txid,
    time: new Date().toISOString(),
    status: "confirmed",
    blockHeight: 999,
    kind: "sent",
    valueZats: -10000n,
    verified: true,
    outgoing: [{ recipient: R, valueZats: 10000n, memo: "rent" }],
    ...extra,
  });

  it("recovery confirms the bound txid, and a lookalike with another txid is never confirmed", async () => {
    const { recoverPendingPayments } = await import("../src/payments/recovery.ts");
    const { config, chain } = await unknownCall();
    const [row] = await recoverPendingPayments(config, historyChain(chain, [entry(LOOKALIKE)]), { now: Date.now() + 60_000 });
    assert.notEqual(row.status, "confirmed", JSON.stringify(row));
    assert.notEqual(row.txid, LOOKALIKE);
    const [row2] = await recoverPendingPayments(config, historyChain(chain, [entry(LOOKALIKE), entry(STAGED)]), { now: Date.now() + 120_000 });
    assert.equal(row2.status, "confirmed", JSON.stringify(row2));
    assert.equal(row2.txid, STAGED);
  });

  it("an entry the wallet's JSON does not vouch for, or one listed twice, never confirms", async () => {
    const { recoverPendingPayments } = await import("../src/payments/recovery.ts");
    for (const history of [[entry(STAGED, { verified: false })], [entry(STAGED), entry(STAGED)]]) {
      const { config, chain } = await unknownCall();
      const [row] = await recoverPendingPayments(config, historyChain(chain, history), { now: Date.now() + 60_000 });
      assert.notEqual(row.status, "confirmed", JSON.stringify(row));
    }
  });

  it("a calculated entry is a built transaction, not a send", async () => {
    const { recoverPendingPayments } = await import("../src/payments/recovery.ts");
    const { config, chain } = await unknownCall();
    const [row] = await recoverPendingPayments(config, historyChain(chain, [entry(STAGED, { status: "calculated", blockHeight: undefined })]), { now: Date.now() + 60_000 });
    assert.notEqual(row.status, "confirmed", JSON.stringify(row));
    assert.notEqual(row.status, "broadcast", JSON.stringify(row));
  });
});

// The memo checked by policy, logged, recorded in the intent, and handed to the wallet is
// one string. Nothing trims, normalizes, or re-encodes it on the way.
describe("the memo sent is exactly the memo checked and logged", () => {
  it("inner spacing, quotes, and non-ASCII reach zingo-cli, the audit rows, and the intent unchanged", async () => {
    const { LiveChainAdapter } = await import("../src/chain/live.ts");
    const { storeFor } = await import("../src/payments/store.ts");
    const { withUfvk } = await import("./helpers.ts");
    const memo = 'inv  42: "caf\u00e9" \\ \u{1F600} \u4e2d';
    const config = liveConfig();
    const d = mkdtempSync(join(tmpdir(), "zshield-r7m-"));
    const TX = "5c".repeat(32);
    let sentLine = "";
    const runner = async (_b: string, _a: string[], opts?: { input?: string }) => {
      const input = opts?.input ?? "";
      if (/^(quicksend|send) /.test(input)) {
        sentLine = input;
        return `{\n  "fee": 10000\n}\n{\n  "txids": [\n    "${TX}"\n  ]\n}\n`;
      }
      return "";
    };
    const chain = new LiveChainAdapter({ network: "testnet", runner: withUfvk(runner as never, {}, false), dataDir: d, stateDir: join(d, ".zshield-state") });
    const r = await executePay({ idempotency_key: "r7-memo-exact", amount_zec: "0.0001", recipient: R, memo }, { config, chain });
    const body = JSON.parse(r.text);
    assert.ok(sentLine.length > 0, "a send line was built");
    const m = /^send '(.*)'$/s.exec(sentLine.split("\n")[0]);
    assert.ok(m, sentLine);
    const outputs = JSON.parse(m![1]);
    assert.equal(outputs.length, 1);
    assert.equal(outputs[0].memo, memo);
    for (const row of readAuditRows(config).filter((x) => x.tool === "zcash_pay")) assert.equal(row.memo, memo);
    assert.equal(storeFor(config, chain).readCall(body.call_id)?.intent?.memo, memo);
  });
});
