import type { TxSummary } from "../types.js";

/**
 * The text `transactions` listing prints memos raw, so a memo sent to this wallet can carry
 * lines that look like more transactions. These readers use zingo-cli's JSON commands
 * (`notes all`, `coins all`, `messages`), where every string is escaped and cannot add an
 * entry. A listing entry is trusted only when the JSON agrees with it.
 */

export type SpendClass = "confirmed" | "mempool" | "transmitted" | "calculated";
const CLASSES = new Set<string>(["confirmed", "mempool", "transmitted", "calculated"]);

export interface TxFacts {
  /** How the wallet itself records this txid: as a note's own transaction or as a spender */
  classes: Set<string>;
  /** Mined heights the JSON gives for notes of this transaction */
  heights: Set<number>;
}

export interface WalletFacts {
  byTxid: Map<string, TxFacts>;
  /** From `messages`: per txid, the kind, amount, recipient and memos of each memo-bearing transfer */
  messages: Map<string, { kind?: string; value?: bigint; recipient?: string; memos: string[] }[]>;
}

/** The JSON value a zingo-cli command printed: from its first `{` line to the last `}` line. */
export function extractJson(out: string): unknown {
  const lines = out.split("\n");
  const first = lines.findIndex((l) => l.startsWith("{") || l.startsWith("["));
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith("}") || lines[i].startsWith("]")) {
      last = i;
      break;
    }
  }
  if (first < 0 || last < first) throw new Error("no JSON in the zingo-cli output");
  return JSON.parse(lines.slice(first, last + 1).join("\n"));
}

const TXID = /^[0-9a-f]{64}$/i;

function facts(map: Map<string, TxFacts>, txid: string): TxFacts {
  const key = txid.toLowerCase();
  let f = map.get(key);
  if (!f) {
    f = { classes: new Set(), heights: new Set() };
    map.set(key, f);
  }
  return f;
}

/** Every object anywhere in `value` that has a string `txid`: notes of any pool, coins. */
function collect(value: unknown, into: Record<string, unknown>[], depth = 0): void {
  if (depth > 8 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const v of value) collect(v, into, depth + 1);
    return;
  }
  const o = value as Record<string, unknown>;
  if (typeof o.txid === "string") into.push(o);
  for (const v of Object.values(o)) collect(v, into, depth + 1);
}

/** Fold the JSON of `notes all` and `coins all` into per-txid facts. */
export function addNoteFacts(out: unknown, byTxid: Map<string, TxFacts>): void {
  const items: Record<string, unknown>[] = [];
  collect(out, items);
  for (const o of items) {
    const txid = o.txid as string;
    if (!TXID.test(txid)) continue;
    if (typeof o.status === "string") {
      const m = o.status.match(/^([a-z]+)(?: at block height (\d+))?/);
      if (m && CLASSES.has(m[1])) {
        const f = facts(byTxid, txid);
        f.classes.add(m[1]);
        if (m[2] !== undefined) f.heights.add(Number(m[2]));
      }
    }
    if (typeof o.spend_status === "string") {
      const m = o.spend_status.match(/^([a-z]+) spent in ([0-9a-f]{64})$/i);
      if (m && CLASSES.has(m[1])) facts(byTxid, m[2]).classes.add(m[1]);
    }
  }
}

/** Fold the JSON of `messages` into per-txid kind, amount, recipient and memos. */
export function messageFacts(out: unknown): WalletFacts["messages"] {
  const map: WalletFacts["messages"] = new Map();
  const list = (out as { value_transfers?: unknown })?.value_transfers;
  if (!Array.isArray(list)) return map;
  for (const v of list) {
    const o = v as Record<string, unknown>;
    if (typeof o?.txid !== "string" || !TXID.test(o.txid)) continue;
    const memos = Array.isArray(o.memos) ? o.memos.filter((m): m is string => typeof m === "string") : [];
    const recipient = typeof o.recipient_address === "string" ? o.recipient_address : undefined;
    const kind = typeof o.kind === "string" ? o.kind : undefined;
    const value = typeof o.value === "number" && Number.isSafeInteger(o.value) && o.value >= 0 ? BigInt(o.value) : undefined;
    const key = o.txid.toLowerCase();
    map.set(key, [...(map.get(key) ?? []), { kind, value, recipient, memos }]);
  }
  return map;
}

/**
 * Whether the wallet's JSON agrees with a listing entry. False means the entry may be a
 * forgery or the wallet could not vouch for it; it never confirms a payment. An entry that
 * appears more than once in the listing is suspect too: a real transaction is printed once.
 */
export function corroborate(t: TxSummary, wallet: WalletFacts | undefined, listedTimes: number): boolean {
  if (!wallet || listedTimes !== 1) return false;
  const f = wallet.byTxid.get(t.txid);
  if (!f || f.classes.size === 0) return false;
  switch (t.status) {
    case "confirmed":
      if (!f.classes.has("confirmed")) return false;
      if (f.heights.size > 0 && (t.blockHeight === undefined || !f.heights.has(t.blockHeight))) return false;
      break;
    case "calculated":
    case "transmitted":
    case "mempool":
      if (!f.classes.has(t.status)) return false;
      break;
    default:
      // failed or a status this code does not know: the wallet knows the txid, nothing more
      break;
  }
  for (const n of t.outgoing ?? []) {
    if (!n.memo) continue;
    const seen = wallet.messages.get(t.txid) ?? [];
    // The JSON must call it a send, with this amount, to this recipient, carrying this memo.
    const ok = seen.some(
      (m) => m.kind === "sent" && m.value === n.valueZats && m.memos.includes(n.memo) && (m.recipient === n.recipient || m.recipient === n.unifiedAddress)
    );
    if (!ok) return false;
  }
  return true;
}
