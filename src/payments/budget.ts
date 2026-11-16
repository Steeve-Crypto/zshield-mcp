import fs from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createExclusive, ensurePrivateDir, fsyncDir, readPrivate } from "../fsafe.js";
import { parseZecToZats } from "../policy/amount.js";
import { PolicyError } from "../policy/caps.js";
import type { Config } from "../types.js";
import { mayHaveBroadcast, paymentParamsHash, type CallEvent, type CallIntent, type CallRecord, type PaymentStore } from "./store.js";
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

const ZERO = { principal: 0n, fee: 0n };
type Roles = { principal: bigint; fee: bigint };

/** The principal and fee receipt identities of one payment. */
function identities(paramsHash: string, key: string): { principal: string; fee: string } {
  return { principal: hash(JSON.stringify([key, paramsHash, "principal"])), fee: hash(JSON.stringify([key, paramsHash, "fee"])) };
}

/**
 * The stored idempotency identity a payment is charged under: its key (the call id for a
 * keyless call) and its parameter hash. Every charge site uses this, never the call id
 * of one attempt, so retries, resumes and recovery all find the same charge.
 */
export function paymentIdentity(intent: CallIntent, callId: string): { key: string; paramsHash: string } {
  return { key: intent.idempotency_key ?? callId, paramsHash: intent.params_sha256 ?? paymentParamsHash(intent) };
}

/** The charge a transmit authorization event carries, or undefined for one that carries none. */
function chargeOf(record: CallRecord, e: CallEvent): Roles | undefined {
  if (e.transmit_authorized !== true) {
    if (e.charged_principal_zats !== undefined || e.charged_fee_zats !== undefined) throw new Error("A charge without a transmit authorization");
    return undefined;
  }
  if (e.charged_principal_zats === undefined && e.charged_fee_zats === undefined) return undefined;
  if (!digits.test(e.charged_principal_zats ?? "") || !digits.test(e.charged_fee_zats ?? "")) throw new Error("Invalid authorization charge");
  if (e.charged_principal_zats !== record.intent?.amount_zats) throw new Error("An authorization charge differs from its intent");
  return { principal: BigInt(e.charged_principal_zats!), fee: BigInt(e.charged_fee_zats!) };
}

/**
 * What the allowance has counted. The ledger holds the operator migration and charges an
 * older version wrote as receipts. Every charge since is the transmit authorization event
 * itself: one immutable record written by one exclusive publish, so a charge and its
 * authorization exist together or not at all (F-72). Each payment identity counts once,
 * at the highest amount any of its records carries. Unreadable state throws.
 */
function counted(store: PaymentStore, dir: string): { total: bigint; charged: (paramsHash: string, key: string) => Roles } {
  const ledger = readLedger(dir);
  const receipt = (id: string): bigint => {
    if (ledger.pending?.id === id) return BigInt(ledger.pending.amount);
    const raw = readPrivate(join(dir, "receipts", id), 4096);
    if (raw === undefined) return 0n;
    const c = JSON.parse(raw) as Charge;
    if (!validCharge(c) || c.id !== id || c.identity !== id) throw new Error("Invalid spending receipt");
    return BigInt(c.amount);
  };
  const byIdentity = new Map<string, Roles>();
  for (const name of fs.readdirSync(join(store.dir, "calls"))) {
    const record = store.readCall(name);
    if (!record) continue;
    for (const e of record.events) {
      const charge = chargeOf(record, e);
      if (!charge) continue;
      const { key, paramsHash } = paymentIdentity(record.intent!, record.callId);
      const at = JSON.stringify([key, paramsHash]);
      const prior = byIdentity.get(at) ?? ZERO;
      byIdentity.set(at, { principal: max(prior.principal, charge.principal), fee: max(prior.fee, charge.fee) });
    }
  }
  const fromReceipts = new Map<string, Roles>();
  const both = (paramsHash: string, key: string): { receipts: Roles; events: Roles } => {
    const at = JSON.stringify([key, paramsHash]);
    let r = fromReceipts.get(at);
    if (!r) {
      const ids = identities(paramsHash, key);
      r = { principal: receipt(ids.principal), fee: receipt(ids.fee) };
      fromReceipts.set(at, r);
    }
    return { receipts: r, events: byIdentity.get(at) ?? ZERO };
  };
  let total = BigInt(ledger.total);
  for (const at of byIdentity.keys()) {
    const [key, paramsHash] = JSON.parse(at) as [string, string];
    const { receipts, events } = both(paramsHash, key);
    total += max(0n, events.principal - receipts.principal) + max(0n, events.fee - receipts.fee);
  }
  return { total, charged: (paramsHash, key) => {
    const { receipts, events } = both(paramsHash, key);
    return { principal: max(receipts.principal, events.principal), fee: max(receipts.fee, events.fee) };
  } };
}
const max = (a: bigint, b: bigint) => (a > b ? a : b);

/**
 * The cumulative spending the allowance has counted, or undefined when this store has no
 * spending ledger. Read only. Throws when the spending state cannot be read.
 */
export function spentZats(store: PaymentStore): bigint | undefined {
  const dir = join(store.dir, "spending-budget");
  if (!fs.existsSync(dir)) return undefined;
  return counted(store, dir).total;
}

/**
 * How much more the allowance must count for this payment identity to carry `principal`
 * and `feeZats`. Refuses when that does not fit. Charges nothing, so a refusal here is
 * repeatable at no cost (F-59, F-72). The only write is creating an empty ledger for a
 * store with no payments yet, before the first intent exists. Any state a charge would
 * refuse (missing, corrupt, disabled ledger) is refused here too. Caller holds the wallet lock.
 */
function needed(config: Config, store: PaymentStore, lock: WalletLock, principal: bigint, feeZats: bigint, paramsHash: string, key: string): bigint {
  lock.assertHeld();
  const dir = join(store.dir, "spending-budget");
  try {
    if (config.totalSpendingCapZec === undefined) {
      if (fs.existsSync(dir)) throw new Error("An existing spending ledger cannot be disabled by removing configuration");
      return 0n;
    }
    const cap = parseZecToZats(config.totalSpendingCapZec, "Total spending cap");
    if (principal <= 0n || feeZats < 0n || !hex.test(paramsHash) || !key) throw new Error("Invalid spending check");
    if (!fs.existsSync(dir)) {
      // A call that is refused later still leaves an intent behind, so the empty ledger
      // must exist before the first one, or the next payment would look historical.
      if (fs.readdirSync(join(store.dir, "calls")).length) throw new Error("Historical payments require operator budget initialization");
      ensurePrivateDir(dir);
      createExclusive(dir, "ledger.json", JSON.stringify({ version: 2, total: "0" }));
    }
    const { total, charged } = counted(store, dir);
    const has = charged(paramsHash, key);
    const more = max(0n, principal - has.principal) + max(0n, feeZats - has.fee);
    if (total + more > cap) throw new Error("Cumulative spending allowance exhausted");
    return more;
  } catch {
    throw new PolicyError("SPENDING_BUDGET_REFUSED", "The durable cumulative spending allowance cannot authorize this payment. Operator review is required; no allowance was reset.");
  }
}

/** Refuses when the principal plus `feeZats` cannot fit in the cumulative allowance. Charges nothing. */
export function checkSpending(config: Config, store: PaymentStore, lock: WalletLock, principal: bigint, feeZats: bigint, paramsHash: string, key: string): void {
  needed(config, store, lock, principal, feeZats, paramsHash, key);
}

/**
 * The single charge point. Checks the allowance, then writes ONE immutable transmit
 * authorization event that carries the principal and fee charge, published by one
 * exclusive link and fsynced. There is no other spending write, so a crash or failed
 * write leaves either both the charge and the authorization or neither (F-72). A refusal
 * writes nothing. With `onlyIfNeeded`, a call already authorized whose identity is
 * already fully counted writes nothing at all. Returns whether an event was written.
 * Caller holds the wallet lock.
 */
export function authorizeCharged(config: Config, store: PaymentStore, lock: WalletLock, record: Pick<CallRecord, "callId" | "intent" | "events">,
  principal: bigint, fee: bigint | undefined, onlyIfNeeded = false): boolean {
  lock.assertHeld();
  const capped = config.totalSpendingCapZec !== undefined;
  if (capped && (typeof fee !== "bigint" || fee <= 0n)) {
    throw new PolicyError("SPENDING_BUDGET_REFUSED", "A positive verified transaction fee is required before transmission.");
  }
  if (!record.intent || record.intent.amount_zats !== principal.toString()) throw new Error("The charge does not match the payment intent.");
  const { key, paramsHash } = paymentIdentity(record.intent, record.callId);
  const more = needed(config, store, lock, principal, fee ?? 0n, paramsHash, key);
  const authorized = record.events.some((e) => e.transmit_authorized === true);
  if (onlyIfNeeded && authorized && more === 0n) return false;
  lock.assertHeld();
  store.authorizeTransmit(record.callId, new Date().toISOString(), capped ? { principal, fee: fee! } : undefined);
  return true;
}

/**
 * Local operator migration, under the wallet lock. Counts only historical calls that may
 * have spent: those with a durable transmit authorization, or whose record cannot prove
 * that nothing was broadcast (`mayHaveBroadcast`). A call the store proves never sent is
 * not a payment and is never charged (F-90). Each counted payment identity gets its
 * principal and fee receipts, so a later resume or recovery of it is recognized as
 * already counted and never charged twice (F-89). The ledger is built in a private
 * temporary directory and published by one rename.
 */
export function initializeHistoricalBudget(store: PaymentStore, lock: WalletLock): void {
  lock.assertHeld();
  const dir = join(store.dir, "spending-budget");
  if (fs.existsSync(dir)) throw new Error("Spending budget already exists; never reset its ledger.");
  const charges = new Map<string, Charge>();
  for (const id of fs.readdirSync(join(store.dir, "calls"))) {
    if (id.startsWith(".tmp-")) throw new Error("Incomplete historical state requires investigation");
    const record = store.readCall(id);
    if (!record?.intent?.amount_zats || !digits.test(record.intent.amount_zats)) throw new Error("Unreadable historical intent");
    const authorizations = record.events.filter(e => e.transmit_authorized === true);
    if (authorizations.length === 0 && !mayHaveBroadcast(record)) continue;
    // A charge an authorization already carries is the fee evidence; otherwise exactly
    // one recorded fee is required, or the migration refuses rather than undercount.
    let fee: bigint | undefined;
    for (const e of record.events) { const c = chargeOf(record, e); if (c) fee = max(fee ?? 0n, c.fee); }
    if (fee === undefined) {
      const fees = record.events.filter(e => e.calculated_fee_zats !== undefined);
      if (fees.length !== 1 || !digits.test(fees[0].calculated_fee_zats!)) throw new Error("Historical fee evidence is missing; refuse to undercount spending.");
      fee = BigInt(fees[0].calculated_fee_zats!);
    }
    const { key, paramsHash } = paymentIdentity(record.intent, record.callId);
    const ids = identities(paramsHash, key);
    for (const [identity, amount] of [[ids.principal, BigInt(record.intent.amount_zats)], [ids.fee, fee]] as const) {
      // Calls of one payment identity are one payment, counted once at its highest amount,
      // the same rule the live allowance applies.
      if (amount <= 0n) continue;
      const prior = charges.get(identity);
      if (!prior || BigInt(prior.amount) < amount) charges.set(identity, { id: identity, amount: amount.toString(), identity });
    }
  }
  let total = 0n;
  for (const c of charges.values()) total += BigInt(c.amount);
  if (!digits.test(total.toString())) throw new Error("Historical total out of range");
  const staging = join(store.dir, `.tmp-spending-budget-${randomBytes(8).toString("hex")}`);
  ensurePrivateDir(staging);
  const receipts = join(staging, "receipts");
  ensurePrivateDir(receipts);
  for (const charge of charges.values()) createExclusive(receipts, charge.id, JSON.stringify(charge));
  fsyncDir(receipts);
  if (!createExclusive(staging, "ledger.json", JSON.stringify({ version: 2, total: total.toString() }))) throw new Error("Budget already exists");
  fsyncDir(staging);
  if (fs.existsSync(dir)) throw new Error("Budget already exists");
  fs.renameSync(staging, dir);
  fsyncDir(store.dir);
}
