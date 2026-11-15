import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, it } from "node:test";
import { createToolRunner, IroncladChainAdapter, parseListTx, type ToolRunner } from "../src/chain/ironclad.ts";
import { SendOutcomeUnknownError } from "../src/chain/outcome.ts";
import { loadConfig } from "../src/config.ts";
import { createChain } from "../src/server.ts";
import { startupChecks, stateDirFor } from "../src/startup.ts";
import { storeFor } from "../src/payments/store.ts";
import { recoverPendingPayments } from "../src/payments/recovery.ts";
import { executePay } from "../src/tools/pay.ts";
import type { PaymentRequest } from "../src/types.ts";
import { tempConfig, withEnv } from "./helpers.ts";

// Requirements for CHAIN_MODE=ironclad, a testnet backend on an Ironclad FROST group
// (a 2-of-3 key: this agent holds one share, the owner's policy co-signer another):
// 1. A send is staged: zcash-devtool builds and proves the PCZT, the co-signer round adds
//    both signature shares, `pczt extract` gives the finished transaction's txid with
//    nothing broadcast, req.stage records it durably, and only then does `pczt send`
//    broadcast that same signed PCZT. A failure before the broadcast sends nothing; a
//    failure during it, or an answer without the staged txid, is an unknown outcome
//    carrying the staged txid.
// 2. The co-signer decides: when its policy refuses, the call ends as not sent, with the
//    co-signer's reason, and nothing is extracted or broadcast.
// 3. Before the co-signer is asked, its own checks (`inspect --json`) must find exactly one
//    payment of exactly the requested zatoshis, and a fee; that fee is what req.authorizeFee
//    is given.
// 4. Caller values reach the programs as separate arguments, never through a shell, so a
//    crafted memo or recipient cannot add an argument.
// 5. Testnet only: a mainnet recipient, a wallet without a testnet viewing key or with more
//    than one account, or a light wallet server on another chain is refused.
// 6. Reads come from devtool: an entry is verified only when `list-tx --json` lists the
//    same txid at the same height; a listing that cannot be read throws rather than leave
//    a real send out.
// 7. Every child runs with TERM=dumb: devtool fails with EAGAIN when `tput` finds no
//    terminal, which is the case under an MCP client.
// 8. IRONCLAD_* paths are absolute; startup refuses a missing program or folder and a
//    wallet or share folder other users can open.
// 9. When the co-signer is offline the payment is refused: the signing round waits a bounded
//    time (two minutes, not the five allowed for building), then the call ends as not sent,
//    saying the co-signer did not answer, with nothing extracted or broadcast. It is never an
//    unknown outcome, and the next payment may go ahead once the co-signer is back.
// 10. A program that exits before reading its input never takes the server down: the
//     runner ignores the broken pipe and reports how the program ended.

const DEVTOOL = "/opt/ironclad/zcash-devtool";
const COSIGNER = "/opt/ironclad/ironclad-cosigner";
const ADDR = "utest1" + "a".repeat(100);
const OWN = "utest1" + "o".repeat(100);
const UFVK = "uviewtest1" + "q".repeat(80);
const TXID = "c0".repeat(32);
const PROVEN = Buffer.from("proven pczt");
const SIGNED = Buffer.from("signed pczt");

/** Two real entries from the live Ironclad group wallet (testnet), as devtool prints them. */
const LIST_TX = `Transactions:
51c3d6397ecb8d1d45d346450748d110ea09dc0d2e73028f67f29339dd3f9101
     Mined: 4581185 (2026-11-04 6:39:51.0 +00:00:00)
    Amount:   0.30000000 TAZ
  Fee paid: Unknown
  Sent 0 notes, received 1 notes, 0 memos
  Output 0 (Ironwood)
    Value:   0.30000000 TAZ
    Received by account: ab4dbf96-ec1d-4df8-a2ea-a43a36c35245 (ironclad-group)
    To: utest17rlcf2nujuu0yyczsq4vaeur7c6v7tqez3hqru22z3xq6d3ng6dysseqy8dr4d6q2k8re3rzuvewy5jvvcm8a2t0cgszkna3wcmr5hs7
82457796b6d92643d6cfcade47716789a3c1ee72c9ebc77c27ccca592365e26a
     Mined: 4581204 (2026-11-04 6:49:58.0 +00:00:00)
    Amount:   0.01015000 TAZ
  Fee paid:   0.00015000 TAZ
  Sent 1 notes, received 0 notes, 1 memos
  Output 0 (Ironwood)
    Value:   0.01000000 TAZ
    Sent from account: ab4dbf96-ec1d-4df8-a2ea-a43a36c35245 (ironclad-group)
    To: utest1u2gz0d9qzns9j7nlkn8e5skmafsxs22glx4sxtr89mc5cd8v8ycrmtflpnf2t0jx2pu89j4u4ada8adsy4zne9jg5dv07yemv0tn2gth32mwna2nnraaxnc0d3yg9gmt49k9m0x33puzpj8dcuvd09w8g9h2k4lzwn8fel4uqux9q59y
    Memo: Memo::Text("IRON-11112222 test-phone-refill 10 919999999999")
  Output 1 (Ironwood)
    Value:   0.14492500 TAZ (Change)
    Memo: Memo::Empty
  Output 2 (Ironwood)
    Value:   0.14492500 TAZ (Change)
    Memo: Memo::Empty
`;
const LIST_TX_JSON = JSON.stringify([
  { mined_height: 4581185, txid: "51c3d6397ecb8d1d45d346450748d110ea09dc0d2e73028f67f29339dd3f9101" },
  { mined_height: 4581204, txid: "82457796b6d92643d6cfcade47716789a3c1ee72c9ebc77c27ccca592365e26a" },
]);

interface FakeOptions {
  ufvk?: string;
  accounts?: number;
  chain?: string;
  payments?: number[];
  fee?: number;
  refuse?: string;
  /** The co-signer daemon is not running: coordinate waits until it is stopped. */
  offline?: boolean;
  extracted?: string;
  send?: "ok" | "throws" | "other";
  onSend?: () => void;
  listTx?: string;
  listTxJson?: string;
}

interface Call {
  tool: "devtool" | "cosigner";
  args: string[];
  cwd?: string;
  input?: Buffer;
  timeoutMs: number;
}

/** zcash-devtool and ironclad-cosigner stand-ins. Records every call. */
function fakeTools(opts: FakeOptions = {}) {
  const calls: Call[] = [];
  const ok = (stdout: string | Buffer) => ({ status: 0, stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout), stderr: "" });
  const fail = (stderr: string) => ({ status: 1, stdout: Buffer.alloc(0), stderr });
  const runner: ToolRunner = async (cmd, args, o) => {
    const tool = cmd === DEVTOOL ? "devtool" : cmd === COSIGNER ? "cosigner" : (() => { throw new Error(`unexpected program ${cmd}`); })();
    calls.push({ tool, args, cwd: o.cwd, input: o.input, timeoutMs: o.timeoutMs });
    const a = args.join(" ");
    if (tool === "cosigner") {
      if (args[0] === "inspect") {
        return ok(JSON.stringify({ payments: (opts.payments ?? [Number(lastCreateValue(calls))]).map((zat) => ({ address: "utest1single", zat })), fee_zat: opts.fee ?? 15000, spent_zat: 1, change_zat: 1, expiry_height: 1, warnings: [], sighash: "00", spends_to_sign: 1 }));
      }
      if (args[0] === "coordinate") {
        // Nothing answers in the session folder, so coordinate waits until the runner stops it.
        if (opts.offline) return { status: null, stdout: Buffer.from("[device 1] waiting for the co-signer's commitments in session/commitments.json...\n"), stderr: "" };
        if (opts.refuse) return fail(`error: the co-signer refused to sign: policy: ${opts.refuse}`);
        writeFileSync(args[args.indexOf("--out") + 1], SIGNED);
        return ok("[device 1] 1 spend(s) signed");
      }
    }
    if (a.startsWith("wallet")) {
      const sub = args[3];
      if (sub === "list-accounts") {
        const n = opts.accounts ?? 1;
        return ok(Array.from({ length: n }, (_, i) => `Account ${i}\n     Name: ironclad-group\n     UFVK: ${opts.ufvk ?? UFVK}\n`).join(""));
      }
      if (sub === "list-addresses") return ok(`Account AccountUuid(x)\n     Default Address: ${OWN}\n`);
      if (sub === "balance") return ok(JSON.stringify({ chain_tip_height: 1000, ironwood_spendable: 39675000, sapling_spendable: 0, orchard_spendable: 0, total: 113660000, transparent_spendable: 0 }));
      if (sub === "sync") return ok("");
      if (sub === "get-info") return ok(JSON.stringify({ chain_name: opts.chain ?? "test", chain_tip_height: 1001, server_uri: "https://testnet.zec.rocks:443" }));
      if (sub === "list-tx") return ok(args.includes("--json") ? (opts.listTxJson ?? "[]") : (opts.listTx ?? "Transactions:\n"));
    }
    if (args[0] === "pczt") {
      if (args.includes("create")) {
        writeFileSync(args[args.indexOf("--output") + 1], "created pczt");
        return ok("");
      }
      if (args.includes("prove")) return ok(PROVEN);
      if (args[1] === "extract") return ok(`${opts.extracted ?? TXID}\n`);
      if (args.includes("send")) {
        opts.onSend?.();
        assert.deepEqual(readFileSync(args[args.length - 1]), SIGNED, "send gets the signed PCZT");
        if (opts.send === "throws") return fail("Error: transport error");
        return ok(`${opts.send === "other" ? "ee".repeat(32) : TXID}\n`);
      }
    }
    throw new Error(`unexpected call: ${tool} ${a}`);
  };
  return { runner, calls, steps: () => calls.map((c) => (c.tool === "cosigner" ? `cosigner ${c.args[0]}` : c.args[0] === "pczt" ? `pczt ${c.args.find((x) => ["create", "prove", "extract", "send"].includes(x))}` : `wallet ${c.args[3]}`)) };
}

function lastCreateValue(calls: Call[]): string {
  const create = [...calls].reverse().find((c) => c.args.includes("create"))!;
  return create.args[create.args.indexOf("--value") + 1];
}

const adapter = (fake: ReturnType<typeof fakeTools>, stateDir?: string) =>
  new IroncladChainAdapter({
    network: "testnet",
    devtool: DEVTOOL,
    walletDir: "/var/ironclad/group",
    cosigner: COSIGNER,
    frostDir: "/var/ironclad/frost",
    sessionDir: "/var/ironclad/frost/session",
    share: "1",
    connection: "direct",
    stateDir,
    runner: fake.runner,
  });

describe("ironclad adapter: staged send", () => {
  it("builds, proves, checks, co-signs, records the txid, then broadcasts the signed PCZT", async () => {
    const order: string[] = [];
    const fake = fakeTools({ onSend: () => order.push("broadcast") });
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
    assert.deepEqual(order, [`stage ${TXID}`, "fee 15000", "beforeTransmit", "afterLock", "broadcast"]);
    const steps = fake.steps().filter((s) => !s.startsWith("wallet"));
    assert.deepEqual(steps, ["pczt create", "pczt prove", "cosigner inspect", "cosigner coordinate", "pczt extract", "pczt send"]);
    assert.deepEqual(fake.calls.find((c) => c.args[1] === "extract")!.input, SIGNED);
    const coordinate = fake.calls.find((c) => c.args[0] === "coordinate")!;
    assert.equal(coordinate.cwd, "/var/ironclad/frost");
    assert.deepEqual(coordinate.args.slice(0, 4), ["coordinate", "--as", "1", "--dir"]);
  });

  it("passes the recipient, amount and memo as separate arguments", async () => {
    const fake = fakeTools();
    const sly = "x' --address utest1evil --value 9\n; rm -rf ~";
    await adapter(fake).pay({ amountZats: 5000n, recipient: ADDR, memo: sly });
    const create = fake.calls.find((c) => c.args.includes("create"))!.args;
    assert.equal(create[create.indexOf("--address") + 1], ADDR);
    assert.equal(create[create.indexOf("--value") + 1], "5000");
    assert.equal(create[create.indexOf("--memo") + 1], sly);
    assert.equal(create.filter((x) => x === "--address").length, 1);
  });

  it("ends as not sent with the co-signer's reason when its policy refuses", async () => {
    const fake = fakeTools({ refuse: "recipient utest1m0z…4cxmldnl is not on the allow-list" });
    await assert.rejects(adapter(fake).pay({ amountZats: 5000n, recipient: ADDR }), (e: Error) => {
      assert.ok(!(e instanceof SendOutcomeUnknownError));
      assert.match(e.message, /co-signer refused to sign \(policy: recipient .* allow-list\)\. Nothing was sent\./);
      return true;
    });
    assert.ok(!fake.steps().includes("pczt extract") && !fake.steps().includes("pczt send"));
  });

  it("refuses the payment when the co-signer is offline, after a bounded wait, with nothing broadcast", async () => {
    const fake = fakeTools({ offline: true });
    let staged = false;
    await assert.rejects(adapter(fake).pay({ amountZats: 5000n, recipient: ADDR, stage: () => { staged = true; } }), (e: Error) => {
      assert.ok(!(e instanceof SendOutcomeUnknownError));
      assert.match(e.message, /co-signer did not answer within 120 s.*Nothing was sent\./);
      return true;
    });
    assert.ok(!staged && !fake.steps().includes("pczt extract") && !fake.steps().includes("pczt send"));
    assert.equal(fake.calls.find((c) => c.args[0] === "coordinate")!.timeoutMs, 120_000);
  });

  it("refuses a PCZT that does not pay exactly the requested amount once, before the co-signer", async () => {
    for (const payments of [[4999], [5000, 1], []]) {
      const fake = fakeTools({ payments });
      await assert.rejects(adapter(fake).pay({ amountZats: 5000n, recipient: ADDR }), /exactly the requested amount/, JSON.stringify(payments));
      assert.ok(!fake.steps().includes("cosigner coordinate"), JSON.stringify(payments));
    }
  });

  it("refuses a missing fee and a txid that is not a transaction id, before broadcasting", async () => {
    await assert.rejects(adapter(fakeTools({ fee: 0 })).pay({ amountZats: 5000n, recipient: ADDR }), /no fee/);
    for (const extracted of ["", "xyz", "c0".repeat(31), `${TXID}ff`]) {
      const fake = fakeTools({ extracted });
      let staged = false;
      await assert.rejects(adapter(fake).pay({ amountZats: 5000n, recipient: ADDR, stage: () => { staged = true; } }), /no txid/, extracted);
      assert.ok(!staged && !fake.steps().includes("pczt send"), extracted);
    }
  });

  it("broadcasts nothing when the txid cannot be recorded or the transmit fence refuses", async () => {
    const fake = fakeTools();
    await assert.rejects(adapter(fake).pay({ amountZats: 5000n, recipient: ADDR, stage: () => { throw new Error("disk full"); } }), /disk full/);
    assert.ok(!fake.steps().includes("pczt send"));
    const fenced = fakeTools();
    await assert.rejects(adapter(fenced).pay({ amountZats: 5000n, recipient: ADDR, afterLock: () => { throw new Error("policy changed"); } }), /policy changed/);
    assert.ok(!fenced.steps().includes("pczt send"));
  });

  it("reports an unknown outcome with the staged txid when the broadcast fails or disagrees", async () => {
    for (const send of ["throws", "other"] as const) {
      await assert.rejects(adapter(fakeTools({ send })).pay({ amountZats: 5000n, recipient: ADDR }), (e: unknown) => {
        assert.ok(e instanceof SendOutcomeUnknownError, send);
        assert.equal((e as SendOutcomeUnknownError).txid, TXID);
        return true;
      });
    }
  });

  it("refuses mainnet, a wallet without one testnet account, and a memo over 512 bytes, before building", async () => {
    const cases: [FakeOptions, PaymentRequest, RegExp][] = [
      [{}, { amountZats: 5000n, recipient: "u1" + "a".repeat(100) }, /testnet/i],
      [{ ufvk: "uview1" + "q".repeat(80) }, { amountZats: 5000n, recipient: ADDR }, /testnet viewing key/],
      [{ accounts: 2 }, { amountZats: 5000n, recipient: ADDR }, /exactly one account/],
      [{}, { amountZats: 5000n, recipient: ADDR, memo: "m".repeat(513) }, /512 bytes/],
      [{}, { amountZats: 0n, recipient: ADDR }, /positive integer/],
    ];
    for (const [opts, req, why] of cases) {
      const fake = fakeTools(opts);
      await assert.rejects(adapter(fake).pay(req), why);
      assert.ok(!fake.steps().includes("pczt create"), String(why));
    }
  });
});

describe("ironclad adapter: reads", () => {
  it("lists devtool's transactions newest first, verified only where the JSON agrees", async () => {
    const txs = await adapter(fakeTools({ listTx: LIST_TX, listTxJson: LIST_TX_JSON })).getHistory(10);
    assert.deepEqual(
      txs.map((t) => [t.txid.slice(0, 8), t.kind, t.valueZats, t.feeZats, t.blockHeight, t.status, t.time, t.verified]),
      [
        ["82457796", "sent", 1_000_000n, 15_000n, 4581204, "confirmed", "2026-11-04T06:49:58.000Z", true],
        ["51c3d639", "received", 30_000_000n, undefined, 4581185, "confirmed", "2026-11-04T06:39:51.000Z", true],
      ]
    );
    assert.ok(txs.every((t) => t.outgoing === undefined));
    const otherHeight = LIST_TX_JSON.replace("4581204", "4581999");
    const mismatched = await adapter(fakeTools({ listTx: LIST_TX, listTxJson: otherHeight })).getHistory(10);
    assert.equal(mismatched.find((t) => t.txid.startsWith("82457796"))!.verified, false);
    assert.equal((await adapter(fakeTools({ listTx: LIST_TX, listTxJson: "[]" })).getHistory(10, { verifiedOnly: true })).length, 0);
  });

  it("throws on a listing it cannot read rather than leave a send out", () => {
    assert.throws(() => parseListTx(LIST_TX.replace("Value:   0.01000000 TAZ", "Value:   a lot")), /unreadable amount/);
    assert.throws(() => parseListTx(LIST_TX.replace("    Value:   0.30000000 TAZ\n", "")), /no value/);
  });

  it("reports health from a testnet server tip, the wallet height and its shielded spendable balance", async () => {
    const health = await withEnv("HEALTH_SYNC_TIMEOUT_MS", "1000", () => adapter(fakeTools()).checkHealth());
    assert.deepEqual(health, { walletHeight: 1000, chainTip: 1001, spendableZats: 39_675_000n, synced: true });
    await assert.rejects(adapter(fakeTools({ chain: "main" })).checkHealth({ sync: false }), /not testnet/);
    assert.deepEqual(await adapter(fakeTools()).getBalance(), { confirmedZats: 113_660_000n, spendableZats: 39_675_000n, unconfirmedZats: 0n });
  });
});

describe("ironclad tool runner", () => {
  it("runs a program without a shell, with TERM=dumb, and returns its stdout", { skip: process.platform === "win32" }, async () => {
    const r = await withEnv("TERM", "xterm-256color", () => createToolRunner()("/usr/bin/env", [], { timeoutMs: 10_000 }));
    assert.equal(r.status, 0);
    assert.match(r.stdout.toString(), /^TERM=dumb$/m);
    const echoed = await createToolRunner()("/bin/echo", ["a b", "$(x)"], { timeoutMs: 10_000 });
    assert.equal(echoed.stdout.toString(), "a b $(x)\n");
  });
  it("survives a program that exits without reading its input", { skip: process.platform === "win32" }, async () => {
    const r = await createToolRunner()(process.execPath, ["-e", "process.exit(0)"], { timeoutMs: 10_000, input: Buffer.alloc(8 * 1024 * 1024, 0x61) });
    assert.equal(r.status, 0);
  });

});

describe("CHAIN_MODE=ironclad config", () => {
  const keys = ["CHAIN_MODE", "IRONCLAD_DEVTOOL", "IRONCLAD_WALLET_DIR", "IRONCLAD_COSIGNER", "IRONCLAD_FROST_DIR", "IRONCLAD_SESSION_DIR", "IRONCLAD_SHARE", "IRONCLAD_CONNECTION", "VIEW_KEY_FINGERPRINT_SALT", "FINANCIAL_CONTROLS_REQUIRED"];
  const env = (vars: Record<string, string | undefined>, fn: () => void) => {
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    for (const k of keys) delete process.env[k];
    Object.assign(process.env, Object.fromEntries(Object.entries(vars).filter(([, v]) => v !== undefined)));
    try {
      fn();
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  };
  const good = {
    CHAIN_MODE: "ironclad",
    IRONCLAD_DEVTOOL: DEVTOOL,
    IRONCLAD_WALLET_DIR: "/var/ironclad/group",
    IRONCLAD_COSIGNER: COSIGNER,
    IRONCLAD_FROST_DIR: "/var/ironclad/frost",
    IRONCLAD_SESSION_DIR: "/var/ironclad/frost/session",
    VIEW_KEY_FINGERPRINT_SALT: "independent-test-deployment",
  };

  it("maps ironclad to a live testnet chain on the Ironclad adapter", () => {
    env(good, () => {
      const c = loadConfig(mkdtempSync(join(tmpdir(), "zshield-cfg-")));
      assert.equal(c.chainMode, "live");
      assert.equal(c.chainNetwork, "testnet");
      assert.equal(c.chainBackend, "ironclad");
      assert.equal(c.ironclad?.share, "1");
      assert.equal(c.ironclad?.connection, "tor");
      assert.equal(c.zingoDataDir, undefined);
      assert.ok(createChain(c) instanceof IroncladChainAdapter);
    });
  });

  it("refuses a relative or missing path, a bad share or connection, and FINANCIAL_CONTROLS_REQUIRED", () => {
    const cwd = mkdtempSync(join(tmpdir(), "zshield-cfg-"));
    for (const k of ["IRONCLAD_DEVTOOL", "IRONCLAD_WALLET_DIR", "IRONCLAD_COSIGNER", "IRONCLAD_FROST_DIR", "IRONCLAD_SESSION_DIR"]) {
      env({ ...good, [k]: undefined }, () => assert.throws(() => loadConfig(cwd), new RegExp(k)));
      env({ ...good, [k]: "relative/path" }, () => assert.throws(() => loadConfig(cwd), new RegExp(k)));
    }
    for (const share of ["0", "-1", "a", "1 2"]) env({ ...good, IRONCLAD_SHARE: share }, () => assert.throws(() => loadConfig(cwd), /IRONCLAD_SHARE/, share));
    for (const connection of ["socks5://", "http://proxy", "tor --x"]) env({ ...good, IRONCLAD_CONNECTION: connection }, () => assert.throws(() => loadConfig(cwd), /IRONCLAD_CONNECTION/, connection));
    env({ ...good, FINANCIAL_CONTROLS_REQUIRED: "1" }, () => assert.throws(() => loadConfig(cwd), /zingo-cli backend only/));
  });
});

describe("zcash_pay through the ironclad adapter", () => {
  function setup(fakeOpts: FakeOptions = {}) {
    const config = tempConfig({ chainMode: "live", chainNetwork: "testnet" });
    writeFileSync(config.allowlistPath, JSON.stringify({ recipients: [{ address: ADDR }] }));
    chmodSync(config.allowlistPath, 0o600);
    const state = mkdtempSync(join(tmpdir(), "zshield-ironclad-state-"));
    const fake = fakeTools(fakeOpts);
    const chain = adapter(fake, state);
    return { config, chain, fake, state, store: storeFor(config, chain) };
  }
  const input = { amount_zec: "0.0005", recipient: ADDR, memo: "IRON-0000000a", idempotency_key: "ic-1" };

  it("pays, with the txid on disk before the broadcast", async () => {
    let stagedAtBroadcast: string | undefined;
    const s = setup({ onSend: () => { stagedAtBroadcast = s.store.readCall(s.store.readKey("ic-1")!.call_id)?.stagedTxid; } });
    const r = await withEnv("HEALTH_SYNC_TIMEOUT_MS", "1000", () => executePay(input, { config: s.config, chain: s.chain }));
    assert.equal(r.audit.status, "ok", r.text);
    assert.equal(stagedAtBroadcast, TXID);
    const create = s.fake.calls.find((c) => c.args.includes("create"))!.args;
    assert.equal(create[create.indexOf("--value") + 1], "50000");
  });

  it("records a co-signer refusal as not sent, so the next call may pay", async () => {
    const s = setup({ refuse: "50000 zat to counter is above the per-payment cap of 20000 zat" });
    const r = await withEnv("HEALTH_SYNC_TIMEOUT_MS", "1000", () => executePay(input, { config: s.config, chain: s.chain }));
    assert.notEqual(r.audit.status, "ok", r.text);
    assert.notEqual(r.audit.status, "unknown", r.text);
    assert.match(r.text, /co-signer refused/);
  });

  it("records an offline co-signer as not sent, and pays once the co-signer is back", async () => {
    const offline = setup({ offline: true });
    const r = await withEnv("HEALTH_SYNC_TIMEOUT_MS", "1000", () => executePay(input, { config: offline.config, chain: offline.chain }));
    assert.notEqual(r.audit.status, "ok", r.text);
    assert.notEqual(r.audit.status, "unknown", r.text);
    assert.match(r.text, /co-signer did not answer/);
    assert.ok(!offline.fake.steps().includes("pczt send"));
    const back = adapter(fakeTools(), offline.state);
    const again = await withEnv("HEALTH_SYNC_TIMEOUT_MS", "1000", () => executePay({ ...input, idempotency_key: "ic-back" }, { config: offline.config, chain: back }));
    assert.equal(again.audit.status, "ok", again.text);
  });

  it("leaves a failed broadcast unresolved, then recovery confirms it by txid once mined", async () => {
    const s = setup({ send: "throws" });
    const r = await withEnv("HEALTH_SYNC_TIMEOUT_MS", "1000", () => executePay(input, { config: s.config, chain: s.chain }));
    assert.equal(r.audit.status, "unknown", r.text);
    const again = await withEnv("HEALTH_SYNC_TIMEOUT_MS", "1000", () => executePay({ ...input, idempotency_key: "ic-2" }, { config: s.config, chain: s.chain }));
    assert.equal(again.code, "UNRESOLVED_PAYMENT", again.text);
    const minedText = `Transactions:\n${TXID}\n     Mined: 1001 (2026-11-14 9:00:00.0 +00:00:00)\n    Amount:   0.00065000 TAZ\n  Fee paid:   0.00015000 TAZ\n  Output 0 (Ironwood)\n    Value:   0.00050000 TAZ\n    Sent from account: x (ironclad-group)\n    To: ${ADDR}\n    Memo: Memo::Text("IRON-0000000a")\n`;
    const mined = adapter(fakeTools({ listTx: minedText, listTxJson: JSON.stringify([{ mined_height: 1001, txid: TXID }]) }), s.state);
    const rows = await withEnv("HEALTH_SYNC_TIMEOUT_MS", "1000", () => recoverPendingPayments(s.config, mined));
    assert.equal(rows.find((row) => row.txid === TXID)?.status, "confirmed", JSON.stringify(rows));
  });
});

describe("CHAIN_MODE=ironclad startup", () => {
  function dirs(mode = 0o700) {
    const root = mkdtempSync(join(tmpdir(), "zshield-ironclad-home-"));
    const wallet = join(root, "group");
    const frost = join(root, "frost");
    const session = join(frost, "session");
    mkdirSync(wallet, { mode });
    mkdirSync(frost, { mode: 0o700 });
    mkdirSync(session, { mode: 0o700 });
    const devtool = join(root, "zcash-devtool");
    const cosigner = join(root, "ironclad-cosigner");
    writeFileSync(devtool, "");
    writeFileSync(cosigner, "");
    return { root, ironclad: { devtool, walletDir: wallet, cosigner, frostDir: frost, sessionDir: session, share: "1", connection: "direct" } };
  }
  const config = (ironclad: ReturnType<typeof dirs>["ironclad"]) =>
    tempConfig({ chainMode: "live", chainNetwork: "testnet", chainBackend: "ironclad", ironclad, viewKeyFingerprintSalt: "independent-test-deployment" });

  it("keeps the payment store beside the group wallet", () => {
    const d = dirs();
    assert.ok(stateDirFor(config(d.ironclad)).includes(basename(d.root)));
  });

  it("refuses a missing program or folder and a wallet or share folder others can open", { skip: process.platform === "win32" }, () => {
    const d = dirs();
    assert.ok(Array.isArray(startupChecks(config(d.ironclad), "linux")));
    assert.throws(() => startupChecks(config({ ...d.ironclad, cosigner: join(d.root, "missing") }), "linux"), /IRONCLAD_COSIGNER does not exist/);
    assert.throws(() => startupChecks(config({ ...d.ironclad, walletDir: join(d.root, "missing") }), "linux"), /IRONCLAD_WALLET_DIR does not exist/);
    const open = dirs(0o755);
    chmodSync(open.ironclad.walletDir, 0o755);
    assert.throws(() => startupChecks(config(open.ironclad), "linux"));
    const share = dirs();
    chmodSync(share.ironclad.frostDir, 0o755);
    assert.throws(() => startupChecks(config(share.ironclad), "linux"));
  });
});
