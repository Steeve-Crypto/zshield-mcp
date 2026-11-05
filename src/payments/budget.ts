import fs from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createExclusive, ensurePrivateDir, readPrivate, replaceAtomic } from "../fsafe.js";
import { parseZecToZats } from "../policy/amount.js";
import { PolicyError } from "../policy/caps.js";
import type { Config } from "../types.js";
import type { PaymentStore } from "./store.js";
import type { WalletLock } from "./lock.js";

type Charge = { id: string; amount: string; identity: string };
type Ledger = { version: 2; total: string; pending?: Charge };
const digits = /^(0|[1-9][0-9]{0,30})$/;
const hex = /^[a-f0-9]{64}$/;
function validCharge(c: Charge): boolean { return !!c && hex.test(c.id) && digits.test(c.amount) && BigInt(c.amount) > 0n && hex.test(c.identity); }
function readLedger(dir: string): Ledger {
  const raw = readPrivate(join(dir, "ledger.json"), 4096);
  if (raw === undefined) throw new Error("Missing spending ledger");
  const l = JSON.parse(raw) as Ledger;
  if (!l || l.version !== 2 || typeof l.total !== "string" || !digits.test(l.total) || (l.pending && (!validCharge(l.pending) || BigInt(l.pending.amount) > BigInt(l.total)))) throw new Error("Invalid spending ledger");
  return l;
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/** No refunds or time-based resets. Caller holds the wallet lock throughout. */
export function reserveSpending(config: Config, store: PaymentStore, lock: WalletLock,
  callId: string, amount: bigint, paramsHash: string, key: string): void {
  lock.assertHeld();
  const dir = join(store.dir, "spending-budget");
  try {
    if (config.totalSpendingCapZec === undefined) {
      if (fs.existsSync(dir)) throw new Error("An existing spending ledger cannot be disabled by removing configuration");
      return;
    }
    const cap = parseZecToZats(config.totalSpendingCapZec, "Total spending cap");
    if (amount <= 0n || !hex.test(paramsHash) || !key) throw new Error("Invalid spending reservation");
    if (!fs.existsSync(dir)) {
      // Existing wallets need explicit accounting of historical intent before enabling
      // the allowance. Never silently start a zero counter over old payment records.
      if (fs.readdirSync(join(store.dir, "calls")).length) throw new Error("Historical payments require operator budget initialization");
      ensurePrivateDir(dir);
      createExclusive(dir, "ledger.json", JSON.stringify({ version: 2, total: "0" }));
    }
    ensurePrivateDir(dir);
    const receipts = join(dir, "receipts");
    ensurePrivateDir(receipts);
    let ledger = readLedger(dir);
    // The total and pending receipt are one atomic durable update. Complete a crashed
    // reservation before charging anyone else. Each receipt is immutable.
    if (ledger.pending) {
      const pending = ledger.pending;
      const encoded = JSON.stringify(pending);
      if (!createExclusive(receipts, pending.id, encoded) && readPrivate(join(receipts, pending.id), 4096) !== encoded) throw new Error("Conflicting spending receipt");
      ledger = { version: 2, total: ledger.total };
      replaceAtomic(dir, "ledger.json", JSON.stringify(ledger));
    }
    // Receipt id follows payment identity (key + params + role), not the ephemeral call id.
    // Retries that never sent must not permanently consume the allowance again (F-72).
    // Fee reservations use callId prefix "fee:" so they stay distinct from the principal.
    const role = callId.startsWith("fee:") ? "fee" : "principal";
    const identity = hash(JSON.stringify([key, paramsHash, role]));
    const charge: Charge = { id: identity, amount: amount.toString(), identity };
    const prior = readPrivate(join(receipts, charge.id), 4096);
    if (prior !== undefined) {
      const prev = JSON.parse(prior) as Charge;
      if (!validCharge(prev) || prev.identity !== identity || prev.amount !== charge.amount) throw new Error("Spending reservation identity changed");
      if (BigInt(ledger.total) > cap) throw new Error("Current spending allowance is below reserved spending");
      return;
    }
    const total = BigInt(ledger.total) + amount;
    if (total > cap) throw new Error("Cumulative spending allowance exhausted");
    replaceAtomic(dir, "ledger.json", JSON.stringify({ version: 2, total: total.toString(), pending: charge }));
    if (!createExclusive(receipts, charge.id, JSON.stringify(charge))) throw new Error("Spending receipt unexpectedly exists");
    replaceAtomic(dir, "ledger.json", JSON.stringify({ version: 2, total: total.toString() }));
  } catch {
    throw new PolicyError("SPENDING_BUDGET_REFUSED", "The durable cumulative spending allowance cannot authorize this payment. Operator review is required; no allowance was reset.");
  }
}

/** Local operator migration, under the wallet lock. Charges every historical intent. */
export function initializeHistoricalBudget(store: PaymentStore, lock: WalletLock): void {
  lock.assertHeld();
  const dir = join(store.dir, "spending-budget");
  if (fs.existsSync(dir)) throw new Error("Spending budget already exists; never reset its ledger.");
  let total = 0n;
  for (const id of fs.readdirSync(join(store.dir, "calls"))) {
    if (id.startsWith(".tmp-")) throw new Error("Incomplete historical state requires investigation");
    const record = store.readCall(id);
    if (!record?.intent?.amount_zats || !digits.test(record.intent.amount_zats)) throw new Error("Unreadable historical intent");
    const fees = record.events.filter(e => e.calculated_fee_zats !== undefined);
    if (fees.length !== 1 || !digits.test(fees[0].calculated_fee_zats!)) throw new Error("Historical fee evidence is missing; refuse to undercount spending.");
    total += BigInt(record.intent.amount_zats) + BigInt(fees[0].calculated_fee_zats!);
  }
  if (!digits.test(total.toString())) throw new Error("Historical total out of range");
  ensurePrivateDir(dir);
  if (!createExclusive(dir, "ledger.json", JSON.stringify({ version: 2, total: total.toString() }))) throw new Error("Budget already exists");
}

/** Separate immutable receipt permits upgrading a principal reservation without refunds. */
export function reserveFee(config: Config, store: PaymentStore, lock: WalletLock,
  callId: string, fee: bigint | undefined, paramsHash: string, key: string): void {
  if (config.totalSpendingCapZec === undefined) return;
  if (typeof fee !== "bigint" || fee <= 0n) throw new PolicyError("SPENDING_BUDGET_REFUSED", "A positive verified transaction fee is required before transmission.");
  reserveSpending(config, store, lock, `fee:${callId}`, fee, paramsHash, key);
}
