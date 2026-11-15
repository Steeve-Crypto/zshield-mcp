import { createHash } from "node:crypto";

/**
 * Which receivers an address names, and a check that a planned transaction pays the
 * requested address. Shared by every backend that can report the outputs of a built
 * transaction before it is signed, so the allow-list binds to what the wallet built,
 * not only to the arguments ZShield passed in.
 */

/** Receiver typecodes from ZIP 316: transparent P2PKH and P2SH, Sapling, Orchard. */
export const RECEIVER = { p2pkh: 0, p2sh: 1, sapling: 2, orchard: 3 } as const;

export interface DecodedAddress {
  network: "mainnet" | "testnet";
  /** Receiver typecode to raw receiver bytes, as hex. */
  receivers: Map<number, string>;
}

export class RecipientMismatchError extends Error {
  readonly code = "RECIPIENT_MISMATCH" as const;
  constructor(message: string) {
    super(message);
    this.name = "RecipientMismatchError";
  }
}

// BLAKE2b (RFC 7693) with a personalization string, which node:crypto does not expose.
const MASK = (1n << 64n) - 1n;
const IV = [
  0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
];
const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4], [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13], [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11], [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5], [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];
const rotr = (x: bigint, n: bigint) => ((x >> n) | (x << (64n - n))) & MASK;
function word(b: Uint8Array, i: number): bigint {
  let w = 0n;
  for (let k = 7; k >= 0; k--) w = (w << 8n) | BigInt(b[i + k]);
  return w;
}

export function blake2b(data: Uint8Array, outLen: number, personal: Uint8Array): Uint8Array {
  if (outLen < 1 || outLen > 64 || personal.length !== 16) throw new Error("Invalid BLAKE2b parameters.");
  const param = new Uint8Array(64);
  param[0] = outLen; param[2] = 1; param[3] = 1;
  param.set(personal, 48);
  const h = IV.map((v, i) => v ^ word(param, i * 8));
  const blocks = Math.max(1, Math.ceil(data.length / 128));
  for (let b = 0; b < blocks; b++) {
    const block = new Uint8Array(128);
    block.set(data.subarray(b * 128, b * 128 + 128));
    const last = b === blocks - 1;
    const t = BigInt(last ? data.length : (b + 1) * 128);
    const m = Array.from({ length: 16 }, (_, i) => word(block, i * 8));
    const v = [...h, ...IV];
    v[12] ^= t & MASK; v[13] ^= t >> 64n;
    if (last) v[14] ^= MASK;
    const g = (a: number, bb: number, c: number, d: number, x: bigint, y: bigint) => {
      v[a] = (v[a] + v[bb] + x) & MASK; v[d] = rotr(v[d] ^ v[a], 32n);
      v[c] = (v[c] + v[d]) & MASK; v[bb] = rotr(v[bb] ^ v[c], 24n);
      v[a] = (v[a] + v[bb] + y) & MASK; v[d] = rotr(v[d] ^ v[a], 16n);
      v[c] = (v[c] + v[d]) & MASK; v[bb] = rotr(v[bb] ^ v[c], 63n);
    };
    for (let r = 0; r < 12; r++) {
      const s = SIGMA[r % 10];
      g(0, 4, 8, 12, m[s[0]], m[s[1]]); g(1, 5, 9, 13, m[s[2]], m[s[3]]);
      g(2, 6, 10, 14, m[s[4]], m[s[5]]); g(3, 7, 11, 15, m[s[6]], m[s[7]]);
      g(0, 5, 10, 15, m[s[8]], m[s[9]]); g(1, 6, 11, 12, m[s[10]], m[s[11]]);
      g(2, 7, 8, 13, m[s[12]], m[s[13]]); g(3, 4, 9, 14, m[s[14]], m[s[15]]);
    }
    for (let i = 0; i < 8; i++) h[i] ^= v[i] ^ v[i + 8];
  }
  const out = new Uint8Array(64);
  h.forEach((w, i) => { for (let k = 0; k < 8; k++) out[i * 8 + k] = Number((w >> BigInt(8 * k)) & 0xffn); });
  return out.slice(0, outLen);
}

// F4Jumble from ZIP 316.
function personal(tag: string, i: number, j = 0): Uint8Array {
  const p = new Uint8Array(16);
  p.set(Buffer.from(tag, "ascii"));
  p[13] = i; p[14] = j & 0xff; p[15] = j >> 8;
  return p;
}
function hRound(i: number, u: Uint8Array, len: number): Uint8Array {
  return blake2b(u, len, personal("UA_F4Jumble_H", i));
}
function gRound(i: number, u: Uint8Array, len: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let j = 0; j * 64 < len; j++) out.set(blake2b(u, 64, personal("UA_F4Jumble_G", i, j)).subarray(0, Math.min(64, len - j * 64)), j * 64);
  return out;
}
const xor = (a: Uint8Array, b: Uint8Array) => a.map((x, i) => x ^ b[i]);
function split(m: Uint8Array): [number, number] {
  if (m.length < 48 || m.length > 4194368) throw new Error("F4Jumble input length out of range.");
  const left = Math.min(64, Math.floor(m.length / 2));
  return [left, m.length - left];
}

export function f4jumble(m: Uint8Array): Uint8Array {
  const [l, r] = split(m);
  const a = m.subarray(0, l), b = m.subarray(l);
  const x = xor(b, gRound(0, a, r));
  const y = xor(a, hRound(0, x, l));
  const d = xor(x, gRound(1, y, r));
  const c = xor(y, hRound(1, d, l));
  return Uint8Array.from([...c, ...d]);
}

export function f4jumbleInv(m: Uint8Array): Uint8Array {
  const [l, r] = split(m);
  const c = m.subarray(0, l), d = m.subarray(l);
  const y = xor(c, hRound(1, d, l));
  const x = xor(d, gRound(1, y, r));
  const a = xor(y, hRound(0, x, l));
  const b = xor(x, gRound(0, a, r));
  return Uint8Array.from([...a, ...b]);
}

// Bech32 and Bech32m (BIP 173, BIP 350), without the 90 character limit unified addresses exceed.
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}
const hrpExpand = (hrp: string) => [...hrp].map((c) => c.charCodeAt(0) >> 5).concat([0], [...hrp].map((c) => c.charCodeAt(0) & 31));
function convertBits(data: number[], from: number, to: number, pad: boolean): number[] {
  let acc = 0, bits = 0;
  const out: number[] = [], maxv = (1 << to) - 1;
  for (const v of data) {
    acc = (acc << from) | v; bits += from;
    while (bits >= to) { bits -= to; out.push((acc >> bits) & maxv); }
  }
  if (pad) { if (bits > 0) out.push((acc << (to - bits)) & maxv); }
  else if (bits >= from || ((acc << (to - bits)) & maxv)) throw new Error("Invalid bech32 padding.");
  return out;
}
const BECH32 = 1, BECH32M = 0x2bc830a3;

export function bech32Decode(text: string, variant: "bech32" | "bech32m"): { hrp: string; data: Uint8Array } {
  if (text !== text.toLowerCase() && text !== text.toUpperCase()) throw new Error("Mixed case address.");
  const s = text.toLowerCase();
  const pos = s.lastIndexOf("1");
  if (pos < 1 || pos + 7 > s.length) throw new Error("Malformed bech32 address.");
  const hrp = s.slice(0, pos);
  const values = [...s.slice(pos + 1)].map((c) => CHARSET.indexOf(c));
  if (values.some((v) => v < 0)) throw new Error("Invalid bech32 character.");
  if (polymod(hrpExpand(hrp).concat(values)) !== (variant === "bech32" ? BECH32 : BECH32M)) throw new Error("Bad bech32 checksum.");
  return { hrp, data: Uint8Array.from(convertBits(values.slice(0, -6), 5, 8, false)) };
}

export function bech32Encode(hrp: string, data: Uint8Array, variant: "bech32" | "bech32m"): string {
  const values = convertBits([...data], 8, 5, true);
  const mod = polymod(hrpExpand(hrp).concat(values, [0, 0, 0, 0, 0, 0])) ^ (variant === "bech32" ? BECH32 : BECH32M);
  const checksum = Array.from({ length: 6 }, (_, i) => (mod >>> (5 * (5 - i))) & 31);
  return hrp + "1" + values.concat(checksum).map((v) => CHARSET[v]).join("");
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const sha256d = (b: Uint8Array) => createHash("sha256").update(createHash("sha256").update(b).digest()).digest();
function base58check(text: string): Uint8Array {
  let n = 0n;
  for (const c of text) {
    const v = B58.indexOf(c);
    if (v < 0) throw new Error("Invalid base58 character.");
    n = n * 58n + BigInt(v);
  }
  const bytes: number[] = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const c of text) { if (c !== "1") break; bytes.unshift(0); }
  const raw = Uint8Array.from(bytes);
  if (raw.length < 5) throw new Error("Short base58check address.");
  const body = raw.subarray(0, -4);
  if (!Buffer.from(sha256d(body).subarray(0, 4)).equals(Buffer.from(raw.subarray(-4)))) throw new Error("Bad base58check checksum.");
  return body;
}

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const UA_HRP = { mainnet: "u", testnet: "utest" } as const;
const SAPLING_HRP = { mainnet: "zs", testnet: "ztestsapling" } as const;
const TRANSPARENT: Record<string, { network: "mainnet" | "testnet"; type: number }> = {
  "1cb8": { network: "mainnet", type: RECEIVER.p2pkh }, "1cbd": { network: "mainnet", type: RECEIVER.p2sh },
  "1d25": { network: "testnet", type: RECEIVER.p2pkh }, "1cba": { network: "testnet", type: RECEIVER.p2sh },
};

function readCompactSize(b: Uint8Array, at: number): [number, number] {
  const first = b[at];
  if (first === undefined) throw new Error("Truncated unified address.");
  if (first < 0xfd) return [first, at + 1];
  if (first === 0xfd && at + 3 <= b.length) {
    const v = b[at + 1] | (b[at + 2] << 8);
    if (v < 0xfd) throw new Error("Non-canonical compact size.");
    return [v, at + 3];
  }
  throw new Error("Unsupported compact size in unified address.");
}

/** Every receiver an address names. Throws for anything it cannot fully check. */
export function decodeAddress(address: string): DecodedAddress {
  const a = address.trim();
  for (const network of ["testnet", "mainnet"] as const) {
    if (a.toLowerCase().startsWith(`${UA_HRP[network]}1`)) {
      const { hrp, data } = bech32Decode(a, "bech32m");
      if (hrp !== UA_HRP[network]) continue;
      const raw = f4jumbleInv(data);
      const padding = new Uint8Array(16);
      padding.set(Buffer.from(hrp, "ascii"));
      if (!Buffer.from(raw.subarray(-16)).equals(Buffer.from(padding))) throw new Error("Bad unified address padding.");
      const body = raw.subarray(0, -16);
      const receivers = new Map<number, string>();
      let at = 0, last = -1;
      while (at < body.length) {
        const [type, next] = readCompactSize(body, at);
        const [len, start] = readCompactSize(body, next);
        if (type <= last || start + len > body.length) throw new Error("Malformed unified address receivers.");
        const expected = type === RECEIVER.p2pkh || type === RECEIVER.p2sh ? 20 : type === RECEIVER.sapling || type === RECEIVER.orchard ? 43 : undefined;
        if (expected !== undefined && len !== expected) throw new Error("Wrong unified address receiver length.");
        receivers.set(type, hex(body.subarray(start, start + len)));
        last = type; at = start + len;
      }
      if (![...receivers.keys()].some((t) => t !== RECEIVER.p2pkh && t !== RECEIVER.p2sh)) throw new Error("A unified address needs a shielded receiver.");
      if (receivers.has(RECEIVER.p2pkh) && receivers.has(RECEIVER.p2sh)) throw new Error("A unified address cannot carry two transparent receivers.");
      return { network, receivers };
    }
    if (a.toLowerCase().startsWith(`${SAPLING_HRP[network]}1`)) {
      const { hrp, data } = bech32Decode(a, "bech32");
      if (hrp !== SAPLING_HRP[network] || data.length !== 43) throw new Error("Malformed Sapling address.");
      return { network, receivers: new Map([[RECEIVER.sapling, hex(data)]]) };
    }
  }
  if (/^t[0-9A-Za-z]+$/.test(a)) {
    const body = base58check(a);
    const kind = body.length === 22 ? TRANSPARENT[hex(body.subarray(0, 2))] : undefined;
    if (!kind) throw new Error("Unknown transparent address prefix.");
    return { network: kind.network, receivers: new Map([[kind.type, hex(body.subarray(2))]]) };
  }
  throw new Error("Unrecognized address encoding.");
}

/** Whether `address` is encoded as a unified address (its receivers are decoded separately). */
export function isUnifiedAddress(address: string): boolean {
  const a = address.trim().toLowerCase();
  return a.startsWith(`${UA_HRP.testnet}1`) || a.startsWith(`${UA_HRP.mainnet}1`);
}

export interface PlannedOutput {
  /** The address the backend reports for this output. */
  address: string;
  valueZats: bigint;
}

/** Whether `output` pays one of the receivers `requested` names. */
function paysRequested(output: DecodedAddress, requested: DecodedAddress): boolean {
  if (output.network !== requested.network) return false;
  for (const [type, bytes] of output.receivers) if (requested.receivers.get(type) === bytes) return true;
  return false;
}

/**
 * Fail closed unless the planned outputs pay the requested address exactly the requested
 * amount and nobody else: the outputs whose receiver belongs to the requested address
 * must add up to `amountZats`, and every other output with value must pay a receiver
 * carried inside the wallet's own unified address (`own`). Any other own entry is ignored.
 * An output is never presumed to be change (F-88). A recipient or output address that cannot be
 * decoded is a mismatch; an own address that cannot be decoded proves nothing.
 */
export function assertPlannedRecipient(outputs: PlannedOutput[], recipient: string, amountZats: bigint, own: string[]): void {
  let requested: DecodedAddress;
  try { requested = decodeAddress(recipient); }
  catch (e) { throw new RecipientMismatchError(`The requested recipient cannot be decoded to check the planned transaction (${(e as Error).message}). Nothing was signed or sent.`); }
  // Only a unified address counts as the wallet's own, and only the receivers it carries
  // inside it. A standalone Sapling, transparent or single-receiver alias a backend reports
  // beside it proves nothing about who holds it (F-88).
  const mine: DecodedAddress[] = [];
  for (const address of own) {
    try { if (isUnifiedAddress(address)) mine.push(decodeAddress(address)); } catch { /* not provably the wallet's: matches nothing */ }
  }
  let paid = 0n;
  let stranger = false;
  for (const o of outputs) {
    if (o.valueZats === 0n) continue; // Orchard padding actions carry no value.
    let decoded: DecodedAddress;
    try { decoded = decodeAddress(o.address); }
    catch { throw new RecipientMismatchError("The planned transaction has an output whose address cannot be checked. Nothing was signed or sent."); }
    if (paysRequested(decoded, requested)) paid += o.valueZats;
    else if (!mine.some((m) => paysRequested(decoded, m))) stranger = true;
  }
  if (paid !== amountZats) {
    throw new RecipientMismatchError(paid === 0n
      ? "The planned transaction does not pay the requested recipient. Nothing was signed or sent."
      : `The planned transaction pays the requested recipient ${paid} zatoshis, not the ${amountZats} requested. Nothing was signed or sent.`);
  }
  if (stranger) {
    throw new RecipientMismatchError("The planned transaction pays an address that is neither the requested recipient nor one this wallet reported as its own. Nothing was signed or sent.");
  }
}
