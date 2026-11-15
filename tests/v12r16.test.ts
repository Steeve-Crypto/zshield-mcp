import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fingerprintViewKey } from "../src/audit/log.ts";
import { initializeHistoricalBudget } from "../src/payments/budget.ts";
import { acquireWalletLock } from "../src/payments/lock.ts";
import { recoverPendingPayments } from "../src/payments/recovery.ts";
import { paymentParamsHash, storeFor } from "../src/payments/store.ts";
import { executePay } from "../src/tools/pay.ts";
import { LiveChainAdapter } from "../src/chain/live.ts";
import { PolicyError } from "../src/policy/caps.ts";
import { WalletBusyError } from "../src/chain/walletlock.ts";
import { ZkoolChainAdapter, type GraphqlRunner } from "../src/chain/zkool.ts";
import { assertPlannedRecipient, RecipientMismatchError } from "../src/chain/recipient.ts";
import type { ChainAdapter } from "../src/chain/types.ts";
import type { Config, PaymentRequest, TxSummary } from "../src/types.ts";
import { tempConfig, testUnifiedAddress, withUfvk } from "./helpers.ts";

const R = "utest1" + "r".repeat(100), TX = "d6".repeat(32), VF = "uviewtest1" + "q".repeat(80);
const now = () => new Date().toISOString();

let txCounter = 0x16000;
type Hook = "authorizeFee" | "beforeTransmit" | "afterLock";
/**
 * A live testnet chain whose two-step send reports a 10000 zat fee. `between` runs right
 * before the named hook, `busy` fails the backend lock after the pre-lock gate.
 */
function liveChain(opts: { between?: { hook: Hook; run: () => void }; busy?: boolean } = {}) {
  const sent = { count: 0 };
  const call = (hook: Hook, fn: () => void) => { if (opts.between?.hook === hook) opts.between.run(); fn(); };
  const chain = {
    mode: "live", stagesBeforeBroadcast: true, tracksTransmitAuthorization: true,
    getViewingKey: async () => VF,
    getHistory: async () => [], getTransaction: async () => [],
    checkHealth: async () => ({ walletHeight: 1000, chainTip: 1000, spendableZats: 10_000_000n }),
    syncWallet: async () => ({ complete: true, elapsedMs: 0 }), walletHeight: async () => 1000,
    pay: async (req: PaymentRequest) => {
      const txid = (++txCounter).toString(16).padStart(64, "0");
      req.fence?.();
      req.stage?.(txid);
      call("authorizeFee", () => req.authorizeFee?.(10_000n));
      req.fence?.();
      call("beforeTransmit", () => req.beforeTransmit?.());
      if (opts.busy) throw new WalletBusyError("another zingo-cli holds the wallet", "busy");
      call("afterLock", () => req.afterLock?.());
      sent.count++;
      return { txid, amountZats: req.amountZats, recipient: req.recipient, memo: req.memo, mode: "live" as const };
    },
  } as unknown as ChainAdapter;
  return { chain, sent };
}

function liveConfig(overrides: Partial<Config> = {}): Config {
  const config = tempConfig({ chainMode: "live", chainNetwork: "testnet", ...overrides });
  fs.writeFileSync(config.allowlistPath, JSON.stringify({ recipients: [{ address: R }] }));
  return config;
}

function ledgerTotal(config: Config, chain: ChainAdapter): bigint {
  const file = join(storeFor(config, chain).dir, "spending-budget", "ledger.json");
  return fs.existsSync(file) ? BigInt(JSON.parse(fs.readFileSync(file, "utf8")).total) : 0n;
}

const revoke = (config: Config) => fs.writeFileSync(config.allowlistPath, JSON.stringify({ recipients: [] }));

describe("V12 run 16 regressions", () => {
  for (const hook of ["beforeTransmit", "afterLock"] as const) {
    it(`F-72 an allow-list revocation at ${hook} after the fee charges nothing`, async () => {
      const config = liveConfig({ totalSpendingCapZec: "0.001" });
      const { chain, sent } = liveChain({ between: { hook, run: () => revoke(config) } });
      for (const key of ["a", "a", "b"]) {
        fs.writeFileSync(config.allowlistPath, JSON.stringify({ recipients: [{ address: R }] }));
        const out = await executePay({ amount_zec: "0.0001", recipient: R, idempotency_key: key }, { config, chain });
        assert.equal(out.ok, false, out.text);
      }
      assert.equal(sent.count, 0);
      assert.equal(ledgerTotal(config, chain), 0n);
    });
  }

  it("F-72 a pause written during signing charges nothing", async () => {
    const config = liveConfig({ totalSpendingCapZec: "0.001" });
    let store: ReturnType<typeof storeFor> | undefined;
    const { chain, sent } = liveChain({ between: { hook: "beforeTransmit", run: () => fs.writeFileSync(join(store!.dir, "payments.pause"), "incident") } });
    store = storeFor(config, chain);
    const out = await executePay({ amount_zec: "0.0001", recipient: R, idempotency_key: "paused" }, { config, chain });
    assert.equal(out.ok, false, out.text);
    assert.equal(sent.count, 0);
    assert.equal(ledgerTotal(config, chain), 0n);
  });

  it("F-72 a backend lock failure after the fee charges nothing", async () => {
    const config = liveConfig({ totalSpendingCapZec: "0.001" });
    const { chain, sent } = liveChain({ busy: true });
    for (const key of ["busy", "busy", "busy-2"]) {
      const out = await executePay({ amount_zec: "0.0001", recipient: R, idempotency_key: key }, { config, chain });
      assert.equal(out.ok, false, out.text);
    }
    assert.equal(sent.count, 0);
    assert.equal(ledgerTotal(config, chain), 0n);
  });

  it("F-72 a successful payment is charged once at transmit authorization, by its key", async () => {
    const config = liveConfig({ totalSpendingCapZec: "0.001" });
    let atAuthorization: bigint | undefined;
    const { chain } = liveChain();
    const base = chain.pay.bind(chain);
    (chain as { pay: ChainAdapter["pay"] }).pay = (req) => base({ ...req,
      authorizeFee: (fee) => { req.authorizeFee?.(fee); assert.equal(ledgerTotal(config, chain), 0n, "nothing charged when the fee is known"); },
      beforeTransmit: () => { req.beforeTransmit?.(); assert.equal(ledgerTotal(config, chain), 0n, "nothing charged before the backend lock"); },
      afterLock: () => { req.afterLock?.(); atAuthorization = ledgerTotal(config, chain); } });
    const out = await executePay({ amount_zec: "0.0001", recipient: R, idempotency_key: "paid" }, { config, chain });
    assert.equal(out.ok, true, out.text);
    assert.equal(atAuthorization, 20_000n);
    // A replay of the same key is the same payment: no second charge.
    const replay = await executePay({ amount_zec: "0.0001", recipient: R, idempotency_key: "paid" }, { config, chain });
    assert.equal(replay.ok, true, replay.text);
    assert.equal(ledgerTotal(config, chain), 20_000n);
  });

  it("F-72 zingo keeps a gate refusal after the backend lock as not sent", async () => {
    const inputs: string[] = [];
    const inner = withUfvk(async () => JSON.stringify({ txids: [TX] }));
    const chain = new LiveChainAdapter({ network: "testnet", runner: async (bin, args, opts) => {
      inputs.push(String(opts?.input ?? ""));
      return inner(bin, args, opts);
    } });
    const refusal = new PolicyError("PAYMENTS_PAUSED", "paused while waiting for the wallet lock");
    const result = await chain.pay({ amountZats: 10_000n, recipient: R, afterLock: () => { throw refusal; } }).catch((e) => e);
    assert.equal(result, refusal, "the exact refusal, not an unknown outcome");
    assert.equal(inputs.filter((i) => i.startsWith("transmit")).length, 0);
  });

  const TO = testUnifiedAddress(0xa1), OWN = testUnifiedAddress(0x0f), STRANGER = testUnifiedAddress(0x66);
  function zkool(change: string, extra?: { value: string; address: string }) {
    const ops: string[] = [];
    const runner: GraphqlRunner = async (_url, query, variables) => {
      const op = /\{\s*(\w+)/.exec(query)?.[1] ?? "?";
      ops.push(op);
      switch (op) {
        case "addressByAccount": return { addressByAccount: { ua: OWN.ua, orchard: OWN.orchardOnly, sapling: OWN.sapling, transparent: null } };
        case "prepareSend": return { prepareSend: "ab".repeat(40) };
        case "decodePczt": return { decodePczt: { fee: "0.00010000", txid: TX, recipients: [
          { value: "0.00010000", address: TO.orchardOnly }, { value: "0.50000000", address: change }, ...(extra ? [extra] : [])] } };
        case "signTx": return { signTx: "cd".repeat(60) };
        case "broadcastTx": return { broadcastTx: TX };
        default: throw new Error(`unexpected ${op} ${JSON.stringify(variables)}`);
      }
    };
    return { adapter: new ZkoolChainAdapter({ network: "testnet", account: 3, runner }), ops };
  }

  for (const [label, change, extra] of [
    ["a third party output beside the payment", OWN.orchardOnly, { value: "0.00020000", address: STRANGER.orchardOnly }],
    ["change sent to an address that is not the wallet's", STRANGER.sapling, undefined],
  ] as const) {
    it(`F-88 zkool refuses ${label}`, async () => {
      const z = zkool(change, extra);
      await assert.rejects(() => z.adapter.pay({ amountZats: 10_000n, recipient: TO.ua }), (e: Error) => e instanceof RecipientMismatchError);
      assert.ok(!z.ops.includes("signTx"), "nothing is signed");
      assert.ok(!z.ops.includes("broadcastTx"), "nothing is broadcast");
    });
  }

  it("F-88 an output that is neither the recipient nor the wallet's own is a mismatch", () => {
    const pay = { address: TO.orchardOnly, valueZats: 5000n };
    assert.throws(() => assertPlannedRecipient([pay, { address: STRANGER.orchardOnly, valueZats: 900n }], TO.ua, 5000n, [OWN.ua]),
      (e: unknown) => e instanceof RecipientMismatchError && e.code === "RECIPIENT_MISMATCH" && /neither the requested recipient/.test(e.message));
    // With no own address reported, nothing but the recipient may be paid.
    assert.throws(() => assertPlannedRecipient([pay, { address: OWN.orchardOnly, valueZats: 900n }], TO.ua, 5000n, []), RecipientMismatchError);
    assert.throws(() => assertPlannedRecipient([pay, { address: OWN.orchardOnly, valueZats: 900n }], TO.ua, 5000n, ["not-an-address"]), RecipientMismatchError);
    assertPlannedRecipient([pay, { address: OWN.orchardOnly, valueZats: 900n }, { address: OWN.sapling, valueZats: 1n }], TO.ua, 5000n, [OWN.ua]);
    assertPlannedRecipient([pay], TO.ua, 5000n, []);
  });

  it("F-88 zkool accepts change to the wallet's own reported receivers", async () => {
    for (const change of [OWN.orchardOnly, OWN.sapling]) {
      const z = zkool(change);
      const receipt = await z.adapter.pay({ amountZats: 10_000n, recipient: TO.ua });
      assert.equal(receipt.txid, TX);
    }
  });

  const input = { amount_zec: "0.0001", recipient: R, idempotency_key: "historic", memo: "m" };
  /** A staged, authorized send from before the allowance existed, with its fee recorded. */
  async function historical(opts: { migrate: "before" | "after"; refuseInFence?: boolean }) {
    const config = liveConfig({ totalSpendingCapZec: "0.0003" });
    let entry: TxSummary = { txid: TX, status: "calculated", kind: "sent", valueZats: 10000n, feeZats: 10000n, verified: true,
      outgoing: [{ recipient: R, valueZats: 10000n, memo: input.memo }] };
    const resumed = { count: 0 };
    const chain = {
      mode: "live", stagesBeforeBroadcast: true, tracksTransmitAuthorization: true,
      getViewingKey: async () => VF, getTransaction: async () => [entry], getHistory: async () => [entry],
      checkHealth: async () => ({ walletHeight: 1000, chainTip: 1000, spendableZats: 100000n }),
      syncWallet: async () => ({ complete: true, elapsedMs: 0 }), walletHeight: async () => 1000,
      pay: async () => { assert.fail("never build a new transaction"); },
      resumeSigned: async (_txid: string, o: { fence: () => void }) => {
        if (opts.refuseInFence) revoke(config);
        o.fence();
        resumed.count++;
        entry = { ...entry, status: "confirmed", blockHeight: 999 };
      },
    } as unknown as ChainAdapter;
    const store = storeFor(config, chain);
    const migrate = async () => {
      const lock = await acquireWalletLock(store, 1000, "migration");
      try { initializeHistoricalBudget(store, lock); } finally { await lock.release(); }
    };
    if (opts.migrate === "before") await migrate();
    const hash = paymentParamsHash(input);
    store.writeIntent({ call_id: "historic-call", ts: now(), amount_zats: "10000", allowlist_hit: true, cap_zec: "0.1", ...input,
      view_key_fingerprint: fingerprintViewKey(VF, config.viewKeyFingerprintSalt), two_step: true, transmit_tracked: true, params_sha256: hash } as never);
    store.bindKey(input.idempotency_key, "historic-call", hash);
    store.stageTxid("historic-call", TX, now());
    store.appendEvent({ ts: now(), call_id: "historic-call", state: "pending", calculated_fee_zats: "10000", by: "send" });
    store.authorizeTransmit("historic-call", now());
    if (opts.migrate === "after") await migrate();
    return { config, chain, resumed };
  }

  it("F-89 explicit resume of a migrated historical payment is not charged twice", async () => {
    const h = await historical({ migrate: "after" });
    assert.equal(ledgerTotal(h.config, h.chain), 20_000n);
    const out = await executePay({ ...input, resume: true }, { config: h.config, chain: h.chain });
    assert.equal(JSON.parse(out.text).transmission_attempted, true, out.text);
    assert.equal(h.resumed.count, 1);
    assert.equal(ledgerTotal(h.config, h.chain), 20_000n);
  });

  it("F-89 automatic recovery of a migrated historical payment is not charged twice", async () => {
    const h = await historical({ migrate: "after" });
    await recoverPendingPayments(h.config, h.chain);
    assert.equal(h.resumed.count, 1);
    assert.equal(ledgerTotal(h.config, h.chain), 20_000n);
  });

  it("F-89 a resume refused at the final fence charges nothing", async () => {
    const h = await historical({ migrate: "before", refuseInFence: true });
    assert.equal(ledgerTotal(h.config, h.chain), 0n);
    const out = await executePay({ ...input, resume: true }, { config: h.config, chain: h.chain });
    assert.equal(out.ok, false, out.text);
    await recoverPendingPayments(h.config, h.chain);
    assert.equal(h.resumed.count, 0);
    assert.equal(ledgerTotal(h.config, h.chain), 0n);
  });

  it("F-89 a resume that transmits is charged once, inside the fence", async () => {
    const h = await historical({ migrate: "before" });
    const out = await executePay({ ...input, resume: true }, { config: h.config, chain: h.chain });
    assert.equal(JSON.parse(out.text).transmission_attempted, true, out.text);
    assert.equal(ledgerTotal(h.config, h.chain), 20_000n);
  });
});
