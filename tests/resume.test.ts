import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { describe, it, mock } from "node:test";
import { fingerprintViewKey } from "../src/audit/log.ts";
import { storeFor, paymentParamsHash } from "../src/payments/store.ts";
import { recoverPendingPayments } from "../src/payments/recovery.ts";
import { executePay } from "../src/tools/pay.ts";
import { paymentStatus } from "../src/tools/status.ts";
import { LiveChainAdapter, transmitted } from "../src/chain/live.ts";
import { SendOutcomeUnknownError } from "../src/chain/outcome.ts";
import type { ChainAdapter } from "../src/chain/types.ts";
import type { TxSummary } from "../src/types.ts";
import { tempConfig } from "./helpers.ts";
import { proc, world, sends, staged, commands, overlap, killGroup } from "./invariants/helpers.ts";

const TX = "ac".repeat(32), R = "utest1" + "r".repeat(100), VF = "uviewtest1" + "q".repeat(80);
const input = { amount_zec: "0.0001", recipient: R, idempotency_key: "original", memo: "exact memo" };
function setup(authorized = true) {
  const config = tempConfig({ chainMode: "live", chainNetwork: "testnet" });
  fs.writeFileSync(config.allowlistPath, JSON.stringify({ recipients: [{ address: R }] }));
  let entry: TxSummary = { txid: TX, status: "calculated", kind: "sent", valueZats: 10000n, verified: true,
    outgoing: [{ recipient: R, valueZats: 10000n, memo: input.memo }] };
  let entries: TxSummary[] | undefined, attempts = 0, lostReply = false, vf = VF;
  const accepted = new Set<string>();
  const chain = { mode: "live", stagesBeforeBroadcast: true, tracksTransmitAuthorization: true,
    getViewingKey: async () => vf,
    getTransaction: async () => entries ?? [entry], getHistory: async () => entries ?? [entry],
    checkHealth: async () => ({ walletHeight: 1000, chainTip: 1000, spendableZats: 100000n }),
    syncWallet: async () => ({ complete: true, elapsedMs: 0 }), walletHeight: async () => 1000,
    pay: async () => { assert.fail("recovery must NEVER build a new transaction"); },
    resumeSigned: async (txid: string, opts: { fence: () => void }) => {
      opts.fence(); attempts++; assert.equal(txid, TX); accepted.add(txid);
      entry = { ...entry, status: "confirmed", blockHeight: 999 };
      if (lostReply) throw new SendOutcomeUnknownError("reply lost", TX);
    },
  } as unknown as ChainAdapter;
  const store = storeFor(config, chain);
  const hash = paymentParamsHash(input);
  store.writeIntent({ call_id: "original-call", ts: new Date().toISOString(), ...input,
    amount_zats: "10000", allowlist_hit: true, cap_zec: "0.1",
    view_key_fingerprint: fingerprintViewKey(VF, config.viewKeyFingerprintSalt),
    two_step: true, ...(authorized ? { transmit_tracked: true } : {}), params_sha256: hash });
  store.bindKey(input.idempotency_key, "original-call", hash);
  store.stageTxid("original-call", TX, new Date().toISOString());
  if (authorized) store.authorizeTransmit("original-call", new Date().toISOString());
  return { config, chain, store, attempts: () => attempts, accepted,
    entry: (patch: Partial<TxSummary>) => { entry = { ...entry, ...patch }; },
    entries: (value: TxSummary[]) => { entries = value; },
    loseReply: () => { lostReply = true; }, fingerprint: (value: string) => { vf = value; } };
}

describe("exact transaction recovery", () => {
  it("operator pause blocks automatic and explicit resume", async () => {
    const w = setup();
    fs.writeFileSync(join(w.store.dir, "payments.pause"), "incident");
    await recoverPendingPayments(w.config, w.chain);
    await executePay({ ...input, resume: true }, w);
    assert.equal(w.attempts(), 0);
    assert.ok(w.store.unresolvedSend());
    fs.unlinkSync(join(w.store.dir, "payments.pause"));
    assert.equal((await executePay({ ...input, resume: true }, w)).ok, true);
    assert.equal(w.attempts(), 1);
  });
  it("recovery cannot bypass cumulative spending policy", async () => {
    const w = setup();
    w.config.totalSpendingCapZec = "0.0001";
    await recoverPendingPayments(w.config, w.chain);
    await executePay({ ...input, resume: true }, w);
    assert.equal(w.attempts(), 0);
    assert.ok(w.store.unresolvedSend());
  });
  it("recovery cannot bypass signed approval policy", async () => {
    const w = setup();
    w.config.approvalPublicKeys = ["invalid key"];
    await recoverPendingPayments(w.config, w.chain);
    await executePay({ ...input, resume: true }, w);
    assert.equal(w.attempts(), 0);
    assert.ok(w.store.unresolvedSend());
  });
  it("startup closes the authorization-before-transmit crash window with the original txid", async () => {
    const w = setup();
    assert.ok(w.store.unresolvedSend());
    const rows = await recoverPendingPayments(w.config, w.chain);
    assert.equal(rows[0].status, "broadcast");
    assert.equal(w.attempts(), 1); assert.equal(w.accepted.size, 1);
    assert.equal(w.store.unresolvedSend(), undefined);
    assert.equal(w.store.readCall("original-call")?.txid, TX);
    await recoverPendingPayments(w.config, w.chain);
    await executePay(input, w);
    assert.equal(w.attempts(), 1);
  });
  it("status and ordinary idempotency replays never transmit", async () => {
    const w = setup();
    await paymentStatus(w.config, w.chain, { idempotency_key: "original" });
    await executePay(input, w);
    assert.equal(w.attempts(), 0);
  });
  it("an explicit resume resolves older staged records without resetting their key", async () => {
    const w = setup(false);
    await recoverPendingPayments(w.config, w.chain);
    assert.equal(w.attempts(), 0);
    const result = await executePay({ ...input, resume: true }, w);
    assert.equal(result.ok, true); assert.equal(JSON.parse(result.text).call_id, "original-call");
    assert.equal(w.store.readKey("original")?.call_id, "original-call");
    assert.equal(w.attempts(), 1);
  });
  it("a lost resume reply remains unknown, then resolves by the SAME transaction", async () => {
    const w = setup(); w.loseReply();
    const first = await executePay({ ...input, resume: true }, w);
    assert.equal(first.ok, false); assert.ok(w.store.unresolvedSend());
    assert.equal((await executePay({ ...input, resume: true }, w)).ok, true);
    assert.equal(w.attempts(), 1); assert.equal(w.accepted.size, 1);
  });
  it("a failed result write preserves the accepted txid in the response and the pending outbox", async () => {
    const w = setup();
    const hook = mock.method(w.store, "advance", () => { throw new Error("disk write failed"); });
    try {
      const result = await executePay({ ...input, resume: true }, w);
      const body = JSON.parse(result.text);
      assert.equal(result.ok, true); assert.equal(body.txid, TX);
      assert.match(body.audit_warning, /could not be persisted/);
      assert.ok(w.store.pendingCalls().includes("original-call"));
    } finally { hook.mock.restore(); }
    assert.equal(w.attempts(), 1);
    assert.equal((await recoverPendingPayments(w.config, w.chain))[0].status, "confirmed");
    assert.equal(w.attempts(), 1);
  });
  it("a resume infrastructure failure reports the ORIGINAL call as unknown, never as not sent", async () => {
    const w = setup();
    const originalRead = w.store.readKey.bind(w.store);
    let reads = 0;
    const hook = mock.method(w.store, "readKey", (key: string) => {
      if (++reads > 1) throw new Error("storage unavailable");
      return originalRead(key);
    });
    try {
      const body = JSON.parse((await executePay({ ...input, resume: true }, w)).text);
      assert.equal(body.status, "unknown"); assert.equal(body.call_id, "original-call");
      assert.equal(body.idempotency_key, "original"); assert.equal(w.attempts(), 0);
    } finally { hook.mock.restore(); }
  });
  it("a refusal of a retry never proves the FIRST attempt was not sent", async () => {
    const w = setup();
    w.chain.resumeSigned = async () => { throw new Error("wrapper refused to start"); };
    const result = await executePay({ ...input, resume: true }, w);
    assert.equal(result.ok, false);
    assert.notEqual(w.store.readCall("original-call")?.state, "not_sent");
    assert.ok(w.store.unresolvedSend());
  });
  it("unknown keys and conflicting parameters cannot authorize a replacement", async () => {
    const w = setup();
    assert.equal((await executePay({ ...input, idempotency_key: "new-key", resume: true }, w)).ok, false);
    assert.equal((await executePay({ ...input, amount_zec: "0.0002", resume: true }, w)).code, "IDEMPOTENCY_CONFLICT");
    assert.equal(w.attempts(), 0);
  });
  for (const [label, alter] of [
    ["wallet identity", (w: ReturnType<typeof setup>) => w.fingerprint("different-wallet")],
    ["current cap", (w: ReturnType<typeof setup>) => { w.config.spendingCapZec = "0.00001"; }],
    ["current allow-list", (w: ReturnType<typeof setup>) => fs.writeFileSync(w.config.allowlistPath, '{"recipients":[]}')],
    ["output amount", (w: ReturnType<typeof setup>) => w.entry({ valueZats: 9999n })],
    ["memo", (w: ReturnType<typeof setup>) => w.entry({ outgoing: [{ recipient: R, valueZats: 10000n, memo: "other" }] })],
    ["duplicate txid", (w: ReturnType<typeof setup>) => w.entries([ { txid: TX } as TxSummary, { txid: TX } as TxSummary ])],
    ["missing txid", (w: ReturnType<typeof setup>) => w.entries([])],
    ["uncorroborated output", (w: ReturnType<typeof setup>) => w.entry({ verified: false })],
    ["failed wallet observation", (w: ReturnType<typeof setup>) => w.entry({ status: "failed" })],
    ["unsupported status", (w: ReturnType<typeof setup>) => w.entry({ status: "invented" })],
  ] as const) {
    it(`refuses to resume when ${label} disagrees, keeping the original unresolved`, async () => {
      const w = setup(); alter(w);
      assert.equal((await executePay({ ...input, resume: true }, w)).ok, false);
      assert.equal(w.attempts(), 0); assert.ok(w.store.unresolvedSend());
    });
  }
  it("rejected resume diagnostics cannot drain the protected financial audit pool", async () => {
    const w = setup(); w.config.auditMaxBytes = 2 * 8193;
    w.entry({ verified: false });
    for (let i = 0; i < 20; i++) assert.equal((await executePay({ ...input, resume: true }, w)).ok, false);
    assert.equal(fs.existsSync(join(`${w.config.auditDir}.budget`, "payment.counter")), false);
    w.entry({ verified: true });
    assert.equal((await executePay({ ...input, resume: true }, w)).ok, true);
    assert.equal(w.attempts(), 1);
    assert.equal(fs.statSync(join(`${w.config.auditDir}.budget`, "payment.counter")).size, 2);
  });
  it("audit exhaustion prevents any resume, without erasing the pending call", async () => {
    const w = setup(); w.config.auditMaxBytes = 8193;
    await executePay({ ...input, resume: true }, w); // first permitted financial row
    // Start a separate unresolved call after filling its financial pool.
    const w2 = setup(); w2.config.auditMaxBytes = 8193;
    const { writeAuditRow } = await import("../src/audit/log.ts");
    writeAuditRow(w2.config, { ts: new Date().toISOString(), tool: "zcash_pay_recovery", call_id: "fill", status: "unknown", note: "fill" });
    // Fallback is an independent financial pool and must also be full.
    const fallback = (await import("../src/audit/log.ts")).fallbackAuditPath(w2.config.auditDir);
    const { reserveAudit } = await import("../src/audit/budget.ts");
    reserveAudit(fallback, true, w2.config, false);
    await executePay({ ...input, resume: true }, w2);
    assert.equal(w2.attempts(), 0); assert.ok(w2.store.unresolvedSend());
  });
  it("transmit acknowledgement must contain exactly one report for exactly the original txid", () => {
    const report = JSON.stringify({ txids: [TX] });
    assert.equal(transmitted(report, TX), true);
    for (const reply of [report + report, JSON.stringify({ txids: [TX, "ab".repeat(32)] }),
      JSON.stringify({ txids: ["ab".repeat(32)] }), report + '\n{"txids":[]}', '{"txids":[']) {
      assert.equal(transmitted(reply, TX), false);
    }
  });
  it("live adapter retry contains only transmit of one validated txid, never send/calculate", async () => {
    const seen: string[] = [];
    const adapter = new LiveChainAdapter({ network: "testnet", runner: async (_b, _a, opts) => {
      seen.push(opts?.input ?? ""); return JSON.stringify({ txids: [TX] });
    } });
    await adapter.resumeSigned(TX, { fence: () => {}, timeoutMs: 500 });
    assert.deepEqual(seen, [`transmit ${TX}\nquit\n`]);
    for (const bad of ["", "../", `${TX}\ntransmit`, TX.toUpperCase()]) {
      await assert.rejects(adapter.resumeSigned(bad, { fence: () => {}, timeoutMs: 500 }));
    }
    assert.equal(seen.length, 1);
  });
  it("concurrent explicit resumers serialize on the wallet and transmit the original once", async () => {
    const w = world();
    const fast = { STATUS_SYNC_TIMEOUT_MS: "0", HEALTH_SYNC_TIMEOUT_MS: "0" };
    await proc(w, "crash", ["pay", "key", "0.001"], { ...fast, CRASH_AFTER_AUTHORIZE: "1" }).exited;
    const results = await Promise.all([
      proc(w, "resume-a", ["resume", "key", "0.001"], fast).done,
      proc(w, "resume-b", ["resume", "key", "0.001"], fast).done,
    ]);
    for (const result of results) assert.equal(result.txid, staged(w)[0].txid, JSON.stringify(result));
    assert.equal(sends(w).length, 1); assert.equal(overlap(w), "");
  });
  it("every durable resume crash point recovers the original without another calculation", { timeout: 300000 }, async () => {
    const fast = { STATUS_SYNC_TIMEOUT_MS: "0", HEALTH_SYNC_TIMEOUT_MS: "0" };
    const baseline = world();
    await proc(baseline, "initial", ["pay", "key", "0.001"], { ...fast, CRASH_AFTER_AUTHORIZE: "1" }).exited;
    const probe = await proc(baseline, "probe", ["resume", "key", "0.001"], { ...fast, CRASH_AT: "0" }).done;
    assert.ok(probe.durable_calls > 0);
    for (let point = 1; point <= probe.durable_calls; point++) {
      const w = world();
      await proc(w, "initial", ["pay", "key", "0.001"], { ...fast, CRASH_AFTER_AUTHORIZE: "1" }).exited;
      assert.equal(staged(w).length, 1);
      const original = staged(w)[0].txid;
      const crashed = proc(w, "resume", ["resume", "key", "0.001"], { ...fast, CRASH_AT: String(point), CRASH_DIR: w.root });
      await crashed.exited;
      killGroup(crashed.child, "SIGKILL");
      await proc(w, "recovery", ["recover"], fast).done;
      const result = await proc(w, "retry", ["resume", "key", "0.001"], fast).done;
      assert.equal(result.txid, original, `crash point ${point}: ${JSON.stringify(result)}`);
      assert.equal(sends(w).length, 1, `crash point ${point} accepted more than once`);
      assert.equal(commands(w).filter(c => c.cmd === "calculate").length, 1, `crash point ${point} built again`);
      assert.equal(overlap(w), "", `crash point ${point} overlapped wallet processes`);
    }
    console.log(`Verified ${probe.durable_calls} durable resume crash points`);
  });
  it("SIGKILL after durable authorization recovers across actual server processes, without another calculation", async () => {
    const w = world();
    const crashed = proc(w, "crash", ["pay", "same-key", "0.001"], { CRASH_AFTER_AUTHORIZE: "1" });
    await crashed.exited;
    assert.equal(sends(w).length, 0); assert.equal(staged(w).length, 1);
    const txid = staged(w)[0].txid;
    const recovery = await proc(w, "recover", ["recover"]).done;
    assert.equal(recovery[0].status, "broadcast", JSON.stringify(recovery));
    assert.equal(sends(w).length, 1); assert.equal(sends(w)[0].txid, txid);
    assert.equal(commands(w).filter(c => c.cmd === "calculate").length, 1);
    const result = await proc(w, "replay", ["pay", "same-key", "0.001"]).done;
    assert.equal(result.txid, txid); assert.equal(sends(w).length, 1);
    assert.equal(overlap(w), "");
  });
});
