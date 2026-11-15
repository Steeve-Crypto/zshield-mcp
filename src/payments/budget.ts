import fs from "node:fs";
import { join, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createExclusive, ensurePrivateDir, fsyncDir, readPrivate } from "../fsafe.js";
import { parseZecToZats } from "../policy/amount.js";
import { PolicyError } from "../policy/caps.js";
import type { Config } from "../types.js";
import { mayHaveBroadcast, onCallChanges, paymentParamsHash, safeName, type CallEvent, type CallIntent, type CallRecord, type PaymentStore } from "./store.js";
import type { WalletLock } from "./lock.js";

type Charge = { id: string; amount: string; identity: string };
type Ledger = { version: 2; total: string; pending?: Charge };
const digits = /^(0|[1-9][0-9]{0,30})$/;
const hex = /^[a-f0-9]{64}$/;
function validCharge(c: Charge): boolean { return !!c && hex.test(c.id) && digits.test(c.amount) && BigInt(c.amount) > 0n && hex.test(c.identity); }
function parseLedger(raw: string | undefined): Ledger {
  if (raw === undefined) throw new Error("Missing spending ledger");
  const l = JSON.parse(raw) as Ledger;
  if (!l || l.version !== 2 || typeof l.total !== "string" || !digits.test(l.total) || (l.pending && (!validCharge(l.pending) || BigInt(l.pending.amount) > BigInt(l.total)))) throw new Error("Invalid spending ledger");
  return l;
}
function readLedger(dir: string): Ledger {
  return parseLedger(readPrivate(join(dir, "ledger.json"), 4096));
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

/** The charges one call's transmit authorizations carry, by payment identity. Throws on an invalid charge. */
function chargesOf(record: CallRecord | undefined): Map<string, Roles> {
  const charges = new Map<string, Roles>();
  if (!record) return charges;
  for (const e of record.events) {
    const charge = chargeOf(record, e);
    if (!charge) continue;
    const { key, paramsHash } = paymentIdentity(record.intent!, record.callId);
    const at = JSON.stringify([key, paramsHash]);
    const prior = charges.get(at) ?? ZERO;
    charges.set(at, { principal: max(prior.principal, charge.principal), fee: max(prior.fee, charge.fee) });
  }
  return charges;
}

/**
 * The in-process spending tally (F-91). It holds exactly what `counted` would compute, built
 * from each call's charges and kept current without re-reading unchanged calls:
 *
 * - Call records are append-only. An intent is written once and events are immutable files
 *   that are never rewritten or removed, so a call whose folder listing is unchanged has the
 *   same charges. Each entry keeps the listing it was read from.
 * - Every write this process makes into a call goes through the store, which marks the call
 *   dirty before writing; a dirty call is re-read before the next decision.
 * - Another process can only charge while it holds the exclusive wallet lock, so the first
 *   decision of every lock hold compares each call's folder listing (directory listings
 *   only, no record files) and re-reads just the calls that changed. Later decisions in the
 *   same hold re-read only dirty calls. Spending is never authorized from data older than
 *   the current hold.
 * - Charges, receipts and the ledger only ever add to the count, so the cached total never
 *   exceeds the true one. A refusal decided from it is therefore always a correct refusal and
 *   needs no disk check; only an acceptance is validated.
 * - The ledger file and the receipts folder are compared on every decision. Any change to
 *   them, a call that disappears or a call whose charges shrink rebuilds the totals.
 *
 * A fresh process reads every call once, when the store is opened (`ensureLayout`); that
 * read seeds the tally. Nothing here is written to disk.
 */
type Entry = { listing: string; charges: Map<string, Roles> };
interface Tally {
  mark: string;
  ledger: Ledger;
  total: bigint;
  calls: Map<string, Entry>;
  byIdentity: Map<string, Roles>;
  receipts: Map<string, Roles>;
  dirty: Set<string>;
  validFor?: WeakRef<object>;
}
const tallies = new Map<string, Tally>();
const keys = new Map<string, string>();
/** One key per store folder however it is named, so every alias shares one tally. */
function storeKey(dir: string): string {
  let key = keys.get(dir);
  if (key === undefined) {
    try {
      key = fs.realpathSync(dir);
      keys.set(dir, key);
    } catch { key = resolve(dir); }
  }
  return key;
}
/** Records the store-open scan read, by store, adopted by the first tally built. */
const seeds = new Map<string, Map<string, Entry>>();
class Rebuild extends Error {}

onCallChanges({
  write(dir, name) {
    const key = storeKey(dir);
    tallies.get(key)?.dirty.add(name);
    seeds.get(key)?.delete(name);
  },
  scan(dir, name, record, listing) {
    dir = storeKey(dir);
    let charges: Map<string, Roles>;
    try { charges = chargesOf(record); } catch { return; }
    let pool = seeds.get(dir);
    if (!pool) seeds.set(dir, (pool = new Map()));
    pool.set(name, { listing: listing.join("/"), charges });
  },
  reset() {
    tallies.clear();
    seeds.clear();
    keys.clear();
  },
});

const callsDir = (store: PaymentStore) => join(store.dir, "calls");

/** A call folder's listing, the marker of what its record holds. Throws like readCall would. */
function listingOf(store: PaymentStore, name: string): string {
  let dir: string;
  try { dir = join(callsDir(store), safeName(name, "call id")); } catch { return "!invalid"; }
  try {
    return fs.readdirSync(dir).sort().join("/");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "!absent";
    throw e;
  }
}

function readEntry(store: PaymentStore, name: string): Entry {
  const listed: { names?: string[] } = {};
  const record = store.readCall(name, listed);
  const listing = listed.names ? listed.names.join("/") : listingOf(store, name);
  return { listing, charges: chargesOf(record) };
}

/** The ledger's content and the identity of the budget and receipts folders. */
function ledgerMark(dir: string): { mark: string; ledger: Ledger } {
  const raw = readPrivate(join(dir, "ledger.json"), 4096);
  const ledger = parseLedger(raw);
  const d = fs.statSync(dir, { bigint: true });
  let r = "none";
  try {
    const st = fs.statSync(join(dir, "receipts"), { bigint: true });
    r = `${st.dev}:${st.ino}:${st.mtimeNs}:${st.ctimeNs}:${st.size}`;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  return { mark: `${d.dev}:${d.ino}|${r}|${raw}`, ledger };
}

function receiptsOf(t: Tally, dir: string, at: string): Roles {
  let r = t.receipts.get(at);
  if (r) return r;
  const [key, paramsHash] = JSON.parse(at) as [string, string];
  const ids = identities(paramsHash, key);
  const receipt = (id: string): bigint => {
    if (t.ledger.pending?.id === id) return BigInt(t.ledger.pending.amount);
    const raw = readPrivate(join(dir, "receipts", id), 4096);
    if (raw === undefined) return 0n;
    const c = JSON.parse(raw) as Charge;
    if (!validCharge(c) || c.id !== id || c.identity !== id) throw new Error("Invalid spending receipt");
    return BigInt(c.amount);
  };
  r = { principal: receipt(ids.principal), fee: receipt(ids.fee) };
  t.receipts.set(at, r);
  return r;
}

function term(t: Tally, dir: string, at: string, events: Roles): bigint {
  const receipts = receiptsOf(t, dir, at);
  return max(0n, events.principal - receipts.principal) + max(0n, events.fee - receipts.fee);
}

/** Adopt a call's entry. Charges only grow; one that shrank or vanished means rebuild. */
function apply(t: Tally, dir: string, name: string, entry: Entry): void {
  const old = t.calls.get(name);
  if (old) {
    for (const [at, r] of old.charges) {
      const n = entry.charges.get(at);
      if (!n || n.principal < r.principal || n.fee < r.fee) throw new Rebuild();
    }
  }
  if (entry.listing === "!absent") {
    t.calls.delete(name);
    return;
  }
  for (const [at, r] of entry.charges) {
    const prev = t.byIdentity.get(at);
    const next = prev ? { principal: max(prev.principal, r.principal), fee: max(prev.fee, r.fee) } : r;
    if (prev && next.principal === prev.principal && next.fee === prev.fee) continue;
    t.total += term(t, dir, at, next) - (prev ? term(t, dir, at, prev) : 0n);
    t.byIdentity.set(at, next);
  }
  t.calls.set(name, entry);
}

/**
 * A new tally, exact when it returns: every call folder on disk is listed, and a known entry
 * (from `pool` or the store-open scan) is reused only when its listing is unchanged; every
 * other call is read. A call that disappeared is simply no longer counted.
 */
function build(store: PaymentStore, dir: string, key: string, mark: { mark: string; ledger: Ledger }, pool?: Map<string, Entry>): Tally {
  const t: Tally = { mark: mark.mark, ledger: mark.ledger, total: BigInt(mark.ledger.total), calls: new Map(), byIdentity: new Map(), receipts: new Map(), dirty: new Set() };
  const seeded = seeds.get(key);
  for (const name of fs.readdirSync(callsDir(store))) {
    const known = pool?.get(name) ?? seeded?.get(name);
    apply(t, dir, name, known && known.listing === listingOf(store, name) ? known : readEntry(store, name));
  }
  seeds.delete(key);
  tallies.set(key, t);
  return t;
}

/** The tally for this store, current with its ledger. Builds it on first use in a process. */
function tallyFor(store: PaymentStore, dir: string): Tally {
  const key = storeKey(store.dir);
  const mark = ledgerMark(dir);
  const t = tallies.get(key);
  if (t && t.mark === mark.mark) return t;
  return rebuild(store, dir, t);
}

/** Rebuild from disk, reusing entries whose folder listing is unchanged. */
function rebuild(store: PaymentStore, dir: string, prior?: Tally): Tally {
  const pool = prior ? new Map([...prior.calls].filter(([name]) => !prior.dirty.has(name))) : undefined;
  return build(store, dir, storeKey(store.dir), ledgerMark(dir), pool);
}

/** Re-read the calls this process wrote since the last decision. */
function refreshDirty(store: PaymentStore, dir: string, t: Tally): Tally {
  try {
    for (const name of [...t.dirty]) {
      const entry = readEntry(store, name);
      apply(t, dir, name, entry);
      t.dirty.delete(name);
    }
    return t;
  } catch (e) {
    if (!(e instanceof Rebuild)) throw e;
    return rebuild(store, dir, t);
  }
}

/**
 * Bring every call up to date: list each call folder and re-read only those whose listing
 * changed. Reads no record file of an unchanged call. Equal to a full recount.
 */
function refreshAll(store: PaymentStore, dir: string, t: Tally): Tally {
  try {
    const names = fs.readdirSync(callsDir(store));
    const present = new Set(names);
    for (const name of t.calls.keys()) if (!present.has(name)) throw new Rebuild();
    for (const name of names) {
      const entry = t.calls.get(name);
      if (entry && !t.dirty.has(name) && entry.listing === listingOf(store, name)) continue;
      apply(t, dir, name, readEntry(store, name));
      t.dirty.delete(name);
    }
    return t;
  } catch (e) {
    if (!(e instanceof Rebuild)) throw e;
    return rebuild(store, dir, t);
  }
}

function chargedIn(t: Tally, dir: string, paramsHash: string, key: string): Roles {
  const at = JSON.stringify([key, paramsHash]);
  const receipts = receiptsOf(t, dir, at), events = t.byIdentity.get(at) ?? ZERO;
  return { principal: max(receipts.principal, events.principal), fee: max(receipts.fee, events.fee) };
}

/**
 * The cumulative spending the allowance has counted, or undefined when this store has no
 * spending ledger. Read only. Throws when the spending state cannot be read. Lists every
 * call folder and re-reads only changed calls, so it always equals a full recount.
 */
export function spentZats(store: PaymentStore): bigint | undefined {
  const dir = join(store.dir, "spending-budget");
  if (!fs.existsSync(dir)) return undefined;
  return refreshAll(store, dir, tallyFor(store, dir)).total;
}

/** The full recount from every record, with no tally. For audits and tests. */
export function recountSpentZats(store: PaymentStore): bigint | undefined {
  const dir = join(store.dir, "spending-budget");
  if (!fs.existsSync(dir)) return undefined;
  return counted(store, dir).total;
}

/**
 * What a decision inside an already validated lock hold counts: the tally plus the calls
 * this process wrote since. No folder listing. For tests.
 */
export function cachedSpentZats(store: PaymentStore): bigint | undefined {
  const dir = join(store.dir, "spending-budget");
  if (!fs.existsSync(dir)) return undefined;
  return refreshDirty(store, dir, tallyFor(store, dir)).total;
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
    const decide = (t: Tally): bigint => {
      const has = chargedIn(t, dir, paramsHash, key);
      const more = max(0n, principal - has.principal) + max(0n, feeZats - has.fee);
      if (t.total + more > cap) throw new Error("Cumulative spending allowance exhausted");
      return more;
    };
    // The cached count never exceeds the true one, so a refusal from it is final and costs
    // no disk reads (F-91). Only an acceptance is validated: by every call folder's listing
    // on the first decision of this lock hold, then by the calls this process wrote since.
    // The hold is reused only when the OS lock excludes every other process; with only the
    // in-process lock (mock fallback) every acceptance lists every call folder again.
    let t = tallyFor(store, dir);
    decide(t);
    if (lock.exclusiveAcrossProcesses === true && t.validFor?.deref() === lock) t = refreshDirty(store, dir, t);
    else {
      t = refreshAll(store, dir, t);
      t.validFor = new WeakRef(lock);
    }
    return decide(t);
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
