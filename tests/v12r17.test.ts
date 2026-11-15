import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { describe, it, mock } from "node:test";
import { fallbackAuditPath, fingerprintViewKey } from "../src/audit/log.ts";
import { paymentReservationUsage } from "../src/audit/reservation.ts";
import * as budget from "../src/payments/budget.ts";
import { acquireWalletLock } from "../src/payments/lock.ts";
import { recoverPendingPayments } from "../src/payments/recovery.ts";
import { paymentParamsHash, storeFor, type PaymentStore } from "../src/payments/store.ts";
import { executePay } from "../src/tools/pay.ts";
import { ZkoolChainAdapter, type GraphqlRunner } from "../src/chain/zkool.ts";
import { assertPlannedRecipient, RecipientMismatchError } from "../src/chain/recipient.ts";
import type { ChainAdapter } from "../src/chain/types.ts";
import type { Config, PaymentRequest, TxSummary } from "../src/types.ts";
import { tempConfig, testUnifiedAddress } from "./helpers.ts";

const R = "utest1" + "r".repeat(100), TX = "e7".repeat(32), VF = "uviewtest1" + "q".repeat(80);
const now = () => new Date().toISOString();

let txCounter = 0x17000;
/** A live testnet chain whose two-step send reports a 10000 zat fee and counts transmissions. */
function liveChain() {
  const sent = { count: 0 };
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
      req.authorizeFee?.(10_000n);
      req.fence?.();
      req.beforeTransmit?.();
      req.afterLock?.();
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

/** The cumulative spending the allowance counts, however this version stores it. */
function spent(store: PaymentStore): bigint {
  const derived = (budget as { spentZats?: (s: PaymentStore) => bigint | undefined }).spentZats;
  if (derived) return derived(store) ?? 0n;
  const file = join(store.dir, "spending-budget", "ledger.json");
  return fs.existsSync(file) ? BigInt(JSON.parse(fs.readFileSync(file, "utf8")).total) : 0n;
}

/** What durable transmit authorizations account for: principal plus the recorded fee of each. */
function authorized(store: PaymentStore): bigint {
  let total = 0n;
  for (const id of fs.readdirSync(join(store.dir, "calls"))) {
    const r = store.readCall(id);
    if (!r?.events.some((e) => e.transmit_authorized)) continue;
    const fee = r.events.find((e) => e.calculated_fee_zats !== undefined)?.calculated_fee_zats ?? "0";
    total += BigInt(r.intent!.amount_zats) + BigInt(fee);
  }
  return total;
}

const protectedSlots = (config: Config) =>
  paymentReservationUsage(join(config.auditDir, "2000-01-01.jsonl"), true)
  + paymentReservationUsage(fallbackAuditPath(config.auditDir, config.auditFallbackPath), false);

describe("V12 run 17 regressions", () => {
  it("F-72 a failed transmit authorization leaves no spending charge", async () => {
    const config = liveConfig({ totalSpendingCapZec: "0.001" });
    const { chain, sent } = liveChain();
    const store = storeFor(config, chain);
    const real = store.authorizeTransmit.bind(store);
    store.authorizeTransmit = () => { throw new Error("simulated crash before the authorization is durable"); };
    for (const key of ["k", "k", "k2"]) {
      const out = await executePay({ amount_zec: "0.0001", recipient: R, idempotency_key: key }, { config, chain });
      assert.equal(out.ok, false, out.text);
    }
    store.authorizeTransmit = real;
    assert.equal(sent.count, 0);
    assert.equal(authorized(store), 0n);
    assert.equal(spent(store), 0n, "a charge exists without any durable transmit authorization");
    // Recovery proves the calls not sent; the allowance must agree with that proof.
    await recoverPendingPayments(config, chain);
    assert.equal(spent(store), 0n);
  });

  it("F-72 a failure between the principal and fee charge never splits the payment", async () => {
    const config = liveConfig({ totalSpendingCapZec: "0.001" });
    const { chain } = liveChain();
    const store = storeFor(config, chain);
    const realLink = fs.linkSync;
    let receipts = 0;
    const hook = mock.method(fs, "linkSync", (from: fs.PathLike, to: fs.PathLike) => {
      if (String(to).includes(`${join("spending-budget", "receipts")}`) && ++receipts === 2) throw new Error("simulated crash after the principal charge");
      return realLink(from, to);
    });
    try {
      await executePay({ amount_zec: "0.0001", recipient: R, idempotency_key: "split" }, { config, chain });
    } finally { hook.mock.restore(); }
    assert.equal(spent(store), authorized(store), "every charge is exactly one durable authorization");
  });

  it("F-72 a successful payment's charge is exactly its authorization", async () => {
    const config = liveConfig({ totalSpendingCapZec: "0.001" });
    const { chain, sent } = liveChain();
    const store = storeFor(config, chain);
    const out = await executePay({ amount_zec: "0.0001", recipient: R, idempotency_key: "ok" }, { config, chain });
    assert.equal(out.ok, true, out.text);
    assert.equal(sent.count, 1);
    assert.equal(spent(store), 20_000n);
    assert.equal(authorized(store), 20_000n);
    const replay = await executePay({ amount_zec: "0.0001", recipient: R, idempotency_key: "ok" }, { config, chain });
    assert.equal(replay.ok, true, replay.text);
    assert.equal(spent(store), 20_000n);
  });

  const input = { amount_zec: "0.0001", recipient: R, idempotency_key: "legacy-staged", memo: "m" };
  /** A staged legacy send (no transmit tracking) with its fee recorded, after an empty ledger existed. */
  async function legacyStaged() {
    const config = liveConfig({ totalSpendingCapZec: "0.001", auditMaxBytes: 64 * 8193, auditRefusalMaxBytes: 64 * 8193 });
    let entry: TxSummary = { txid: TX, status: "calculated", kind: "sent", valueZats: 10000n, feeZats: 10000n, verified: true,
      outgoing: [{ recipient: R, valueZats: 10000n, memo: input.memo }] };
    const resumed = { count: 0 };
    const chain = {
      mode: "live", stagesBeforeBroadcast: true,
      getViewingKey: async () => VF, getTransaction: async () => [entry], getHistory: async () => [entry],
      checkHealth: async () => ({ walletHeight: 1000, chainTip: 1000, spendableZats: 100000n }),
      syncWallet: async () => ({ complete: true, elapsedMs: 0 }), walletHeight: async () => 1000,
      pay: async () => { assert.fail("never build a new transaction"); },
      resumeSigned: async (_txid: string, o: { fence: () => void }) => {
        o.fence();
        resumed.count++;
        entry = { ...entry, status: "confirmed", blockHeight: 999 };
      },
    } as unknown as ChainAdapter;
    const store = storeFor(config, chain);
    const lock = await acquireWalletLock(store, 1000, "migration");
    try { budget.initializeHistoricalBudget(store, lock); } finally { await lock.release(); }
    const hash = paymentParamsHash(input);
    store.writeIntent({ call_id: "legacy-call", ts: now(), amount_zats: "10000", allowlist_hit: true, cap_zec: "0.1", ...input,
      view_key_fingerprint: fingerprintViewKey(VF, config.viewKeyFingerprintSalt), two_step: true, params_sha256: hash } as never);
    store.bindKey(input.idempotency_key, "legacy-call", hash);
    store.stageTxid("legacy-call", TX, now());
    store.appendEvent({ ts: now(), call_id: "legacy-call", state: "pending", calculated_fee_zats: "10000", by: "send" });
    return { config, chain, store, resumed };
  }

  for (const fault of ["authorization", "sync"] as const) {
    it(`F-59 a resume whose ${fault} write fails uses no protected audit capacity and attempts nothing`, async () => {
      const h = await legacyStaged();
      const before = protectedSlots(h.config);
      const real = { authorizeTransmit: h.store.authorizeTransmit.bind(h.store), syncCall: h.store.syncCall.bind(h.store) };
      if (fault === "authorization") h.store.authorizeTransmit = () => { throw new Error("simulated authorization write failure"); };
      else h.store.syncCall = () => { throw new Error("simulated directory sync failure"); };
      try {
        for (let i = 0; i < 3; i++) {
          const out = await executePay({ ...input, resume: true }, { config: h.config, chain: h.chain });
          const body = JSON.parse(out.text);
          assert.notEqual(body.transmission_attempted, true, out.text);
        }
      } finally { Object.assign(h.store, real); }
      assert.equal(h.resumed.count, 0);
      assert.equal(protectedSlots(h.config), before, "a resume that sent nothing consumed protected payment capacity");
      assert.equal(spent(h.store), authorized(h.store), "a charge without an authorization, or the reverse");
      // Once storage is healthy the same resume transmits, charged once.
      const ok = await executePay({ ...input, resume: true }, { config: h.config, chain: h.chain });
      assert.equal(JSON.parse(ok.text).transmission_attempted, true, ok.text);
      assert.equal(h.resumed.count, 1);
      assert.equal(spent(h.store), 20_000n);
    });
  }

  it("F-59 a spending ledger fault inside the resume fence uses no protected audit capacity", async () => {
    const h = await legacyStaged();
    const before = protectedSlots(h.config);
    const realLink = fs.linkSync;
    const hook = mock.method(fs, "linkSync", (from: fs.PathLike, to: fs.PathLike) => {
      if (String(to).includes(`${join("spending-budget", "receipts")}`)) throw new Error("simulated ledger fault");
      return realLink(from, to);
    });
    try {
      await executePay({ ...input, resume: true }, { config: h.config, chain: h.chain });
    } finally { hook.mock.restore(); }
    if (h.resumed.count === 0) assert.equal(protectedSlots(h.config), before, "a refused resume consumed protected payment capacity");
    assert.equal(spent(h.store), authorized(h.store));
  });

  it("F-90 migration charges only calls that were authorized or may have broadcast", async () => {
    const config = liveConfig({ totalSpendingCapZec: "1" });
    const { chain } = liveChain();
    const store = storeFor(config, chain);
    const intent = (id: string, extra: Record<string, unknown>) => store.writeIntent({ call_id: id, ts: now(), amount_zec: "0.0001", amount_zats: "10000",
      recipient: R, allowlist_hit: true, cap_zec: "0.1", view_key_fingerprint: null, idempotency_key: id, params_sha256: "a".repeat(64), ...extra } as never);
    const fee = (id: string) => store.appendEvent({ ts: now(), call_id: id, state: "pending", calculated_fee_zats: "10000", by: "send" });
    // Tracked, staged, refused at the final gate before authorization: proven not sent.
    intent("refused", { two_step: true, transmit_tracked: true });
    store.stageTxid("refused", "a1".repeat(32), now()); fee("refused");
    store.advance({ ts: now(), call_id: "refused", state: "not_sent", code: "BUSY", by: "send" });
    // Tracked, staged and authorized: it may have reached the network.
    intent("authorized", { two_step: true, transmit_tracked: true });
    store.stageTxid("authorized", "a2".repeat(32), now()); fee("authorized");
    store.authorizeTransmit("authorized", now());
    const lock = await acquireWalletLock(store, 1000, "migration");
    try { budget.initializeHistoricalBudget(store, lock); } finally { await lock.release(); }
    assert.equal(spent(store), 20_000n, "only the authorized call is charged");
  });

  it("F-90 a call that never staged a transaction needs no fee evidence to migrate", async () => {
    const config = liveConfig({ totalSpendingCapZec: "1" });
    const { chain } = liveChain();
    const store = storeFor(config, chain);
    store.writeIntent({ call_id: "unstaged", ts: now(), amount_zec: "0.0001", amount_zats: "10000", recipient: R, allowlist_hit: true, cap_zec: "0.1",
      view_key_fingerprint: null, idempotency_key: "unstaged", params_sha256: "a".repeat(64), two_step: true, transmit_tracked: true } as never);
    store.advance({ ts: now(), call_id: "unstaged", state: "not_sent", code: "CHAIN_ERROR", by: "send" });
    const lock = await acquireWalletLock(store, 1000, "migration");
    try { budget.initializeHistoricalBudget(store, lock); } finally { await lock.release(); }
    assert.equal(spent(store), 0n);
  });

  const TO = testUnifiedAddress(0xa1), OWN = testUnifiedAddress(0x0f), STRANGER = testUnifiedAddress(0x66);
  function zkool(alias: Record<string, string | null>, change: string) {
    const ops: string[] = [];
    const runner: GraphqlRunner = async (_url, query, variables) => {
      const op = /\{\s*(\w+)/.exec(query)?.[1] ?? "?";
      ops.push(op);
      switch (op) {
        case "addressByAccount": return { addressByAccount: { ua: OWN.ua, transparent: null, sapling: null, orchard: null, ...alias } };
        case "prepareSend": return { prepareSend: "ab".repeat(40) };
        case "decodePczt": return { decodePczt: { fee: "0.00010000", txid: TX, recipients: [
          { value: "0.00010000", address: TO.orchardOnly }, { value: "0.50000000", address: change }] } };
        case "signTx": return { signTx: "cd".repeat(60) };
        case "broadcastTx": return { broadcastTx: TX };
        default: throw new Error(`unexpected ${op} ${JSON.stringify(variables)}`);
      }
    };
    return { adapter: new ZkoolChainAdapter({ network: "testnet", account: 3, runner }), ops };
  }

  for (const [label, alias, change] of [
    ["Sapling", { sapling: STRANGER.sapling }, STRANGER.sapling],
    ["Orchard", { orchard: STRANGER.orchardOnly }, STRANGER.orchardOnly],
  ] as const) {
    it(`F-88 zkool refuses change to an unrelated ${label} alias the backend reports`, async () => {
      const z = zkool(alias, change);
      await assert.rejects(() => z.adapter.pay({ amountZats: 10_000n, recipient: TO.ua }), (e: Error) => e instanceof RecipientMismatchError);
      assert.ok(!z.ops.includes("signTx"), "nothing is signed");
      assert.ok(!z.ops.includes("broadcastTx"), "nothing is broadcast");
    });
  }

  it("F-88 only receivers inside the wallet's unified address count as its own", () => {
    const pay = { address: TO.orchardOnly, valueZats: 5000n };
    assert.throws(() => assertPlannedRecipient([pay, { address: STRANGER.sapling, valueZats: 900n }], TO.ua, 5000n, [OWN.ua, STRANGER.sapling]),
      (e: unknown) => e instanceof RecipientMismatchError && e.code === "RECIPIENT_MISMATCH");
    assertPlannedRecipient([pay, { address: OWN.orchardOnly, valueZats: 900n }, { address: OWN.sapling, valueZats: 1n }], TO.ua, 5000n, [OWN.ua]);
  });

  it("F-88 zkool still accepts change to receivers of its own unified address", async () => {
    for (const change of [OWN.orchardOnly, OWN.sapling]) {
      const z = zkool({ sapling: OWN.sapling, orchard: OWN.orchardOnly }, change);
      const receipt = await z.adapter.pay({ amountZats: 10_000n, recipient: TO.ua });
      assert.equal(receipt.txid, TX);
    }
  });
});
