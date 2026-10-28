import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import { appendAuditEntry } from "../src/audit/log.ts";
import { MockChainAdapter } from "../src/chain/mock.ts";
import { fallbackAuditPath } from "../src/audit/log.ts";
import { paymentParamsHash, resetPaymentStores, storeFor, walletStateDir } from "../src/payments/store.ts";
import { executePay } from "../src/tools/pay.ts";
import type { PaymentReceipt, PaymentRequest } from "../src/types.ts";
import { startupChecks } from "../src/startup.ts";
import { ALLOWED, tempConfig } from "./helpers.ts";

// V12 run 6 decision tests (F-24 to F-25, F-29 to F-33, F-35, F-36).

beforeEach(() => resetPaymentStores());

/** A mock chain bound to a wallet dir, counting sends. */
function walletChain(walletDir: string) {
  const chain = new MockChainAdapter({ stateDir: walletStateDir(walletDir) });
  const real = chain.pay.bind(chain);
  const sent: PaymentRequest[] = [];
  chain.pay = async (req: PaymentRequest): Promise<PaymentReceipt> => {
    sent.push(req);
    return real(req);
  };
  return { chain, sent };
}
const wallet = () => mkdtempSync(join(tmpdir(), "zshield-wallet-"));

describe("F-25, F-29, F-36: audit rows never seed the payment store", () => {
  const KEY = "forged-key-1";
  const input = { amount_zec: "0.001", recipient: ALLOWED, idempotency_key: KEY };
  const rows = (callId: string) => {
    const base = { tool: "zcash_pay" as const, call_id: callId, amount_zec: "0.001", amount_zats: "100000", recipient: ALLOWED, allowlist_hit: true, cap_zec: 0.1, view_key_fingerprint: "f", idempotency_key: KEY, params_sha256: paymentParamsHash(input) };
    return [
      { ...base, ts: new Date().toISOString(), status: "pending" as const },
      { ...base, ts: new Date().toISOString(), status: "ok" as const, mock_txid: "cd".repeat(32) },
    ];
  };

  it("a forged audit row does not bind a key or replay a payment", async () => {
    const config = tempConfig();
    for (const r of rows("forged-1")) appendAuditEntry(config.auditDir, r);
    const { chain, sent } = walletChain(wallet());
    const r = JSON.parse((await executePay(input, { config, chain })).text);
    assert.equal(sent.length, 1);
    assert.notEqual(r.idempotent_replay, true);
    assert.notEqual(r.call_id, "forged-1");
  });

  it("a forged fallback row creates no intent and no key binding", () => {
    const config = tempConfig();
    const fb = fallbackAuditPath(config.auditDir, config.auditFallbackPath);
    mkdirSync(join(fb, ".."), { recursive: true });
    writeFileSync(fb, rows("forged-2").map((r) => JSON.stringify(r)).join("\n") + "\n");
    const store = storeFor(config, { stateDir: walletStateDir(wallet()) });
    assert.equal(store.readKey(KEY), undefined);
    assert.equal(store.readCall("forged-2"), undefined);
    assert.deepEqual(readdirSync(join(store.dir, "calls")), []);
    assert.deepEqual(readdirSync(join(store.dir, "keys")), []);
  });

  it("a big audit corpus does no work at startup", () => {
    const config = tempConfig();
    mkdirSync(config.auditDir, { recursive: true });
    for (let d = 0; d < 40; d++) {
      const lines: string[] = [];
      for (let i = 0; i < 50; i++) lines.push(...rows(`bulk-${d}-${i}`).map((r) => JSON.stringify({ ...r, idempotency_key: `k-${d}-${i}` })));
      writeFileSync(join(config.auditDir, `2026-01-${String(d + 1).padStart(2, "0")}.jsonl`), lines.join("\n") + "\n");
    }
    const store = storeFor(config, { stateDir: walletStateDir(wallet()) });
    assert.deepEqual(readdirSync(join(store.dir, "calls")), []);
    assert.deepEqual(readdirSync(join(store.dir, "keys")), []);
    assert.equal(existsSync(join(store.dir, "imports")), false);
  });

  it("calls an older version imported stay in the store and still replay", async () => {
    const w = wallet();
    const config = tempConfig();
    const { chain, sent } = walletChain(w);
    const store = storeFor(config, chain);
    store.writeIntent({
      call_id: "old-import-1", ts: new Date().toISOString(), amount_zec: "0.001", amount_zats: "100000", recipient: ALLOWED,
      allowlist_hit: true, cap_zec: 0.1, view_key_fingerprint: "f", idempotency_key: KEY, params_sha256: paymentParamsHash(input), imported: true,
    });
    store.bindKey(KEY, "old-import-1", paymentParamsHash(input));
    store.appendEvent({ ts: new Date().toISOString(), call_id: "old-import-1", state: "sent", txid: "cd".repeat(32), by: "import" });
    resetPaymentStores();
    const r = JSON.parse((await executePay(input, { config, chain })).text);
    assert.equal(sent.length, 0);
    assert.equal(r.idempotent_replay, true);
    assert.equal(r.call_id, "old-import-1");
  });
});

describe("F-32, F-33: no live mode on Windows, and no ACL code", () => {
  const live = () => tempConfig({ chainMode: "live", chainNetwork: "testnet", zingoDataDir: mkdtempSync(join(tmpdir(), "zshield-winwallet-")) });

  it("live mode refuses to start on win32 with a clear error", () => {
    assert.throws(() => startupChecks(live(), "win32"), /testnet mode is not supported on Windows/);
  });

  it("mock mode still starts on win32, with no ACL check", () => {
    assert.deepEqual(startupChecks(tempConfig(), "win32"), []);
  });

  it("the ACL parser is gone", () => {
    assert.equal(existsSync(new URL("../src/chain/winacl.ts", import.meta.url)), false);
  });

  it("wrapForWallet still refuses on win32 and nothing is built", async () => {
    const { wrapForWallet, WalletBusyError } = await import("../src/chain/walletlock.ts");
    const real = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      assert.throws(
        () => wrapForWallet("zingo-cli", ["info"], { lockFile: join(tmpdir(), "x", "zingo.flock"), waitMs: 1000 }),
        (e: unknown) => e instanceof WalletBusyError && e.kind === "unavailable"
      );
    } finally {
      Object.defineProperty(process, "platform", real);
    }
  });
});
