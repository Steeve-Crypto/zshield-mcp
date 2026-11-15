import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { assertPlannedRecipient, bech32Decode, bech32Encode, blake2b, decodeAddress, f4jumble, f4jumbleInv, RecipientMismatchError } from "../src/chain/recipient.ts";
import { encodeUnifiedAddress, testUnifiedAddress } from "./helpers.ts";

// Recipient binding: a backend that reports the outputs of a built transaction lets
// ZShield check that the transaction pays the allow-listed address it asked for, before
// anything is signed. The decoders are checked against the published ZIP 316 vectors.

const vectors = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "zip316-vectors.json"), "utf8"));

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58check(body: Uint8Array): string {
  const sum = createHash("sha256").update(createHash("sha256").update(body).digest()).digest().subarray(0, 4);
  const raw = Buffer.concat([body, sum]);
  let n = BigInt("0x" + raw.toString("hex")), out = "";
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of raw) { if (b !== 0) break; out = "1" + out; }
  return out;
}

describe("ZIP 316 decoding", () => {
  it("F4Jumble matches the published vectors both ways", () => {
    for (const v of vectors.f4jumble) {
      assert.equal(Buffer.from(f4jumble(Buffer.from(v.normal, "hex"))).toString("hex"), v.jumbled);
      assert.equal(Buffer.from(f4jumbleInv(Buffer.from(v.jumbled, "hex"))).toString("hex"), v.normal);
    }
    assert.throws(() => f4jumble(new Uint8Array(47)), /length/);
  });

  it("BLAKE2b with an all-zero personalization is plain BLAKE2b-512", () => {
    const msg = Buffer.from("zshield".repeat(40));
    assert.equal(Buffer.from(blake2b(msg, 64, new Uint8Array(16))).toString("hex"), createHash("blake2b512").update(msg).digest("hex"));
    assert.equal(Buffer.from(blake2b(new Uint8Array(0), 64, new Uint8Array(16))).toString("hex"), createHash("blake2b512").update("").digest("hex"));
    assert.throws(() => blake2b(msg, 65, new Uint8Array(16)), /parameters/);
  });

  it("unified addresses decode to exactly the published receivers", () => {
    for (const v of vectors.unified_address) {
      const d = decodeAddress(v.address);
      assert.equal(d.network, "mainnet");
      const expected = new Map<number, string>();
      if (v.p2pkh) expected.set(0, v.p2pkh);
      if (v.p2sh) expected.set(1, v.p2sh);
      if (v.sapling) expected.set(2, v.sapling);
      if (v.orchard) expected.set(3, v.orchard);
      if (v.unknown_typecode !== null) expected.set(v.unknown_typecode, v.unknown_bytes);
      assert.deepEqual(d.receivers, expected);
    }
  });

  it("testnet unified, Sapling and transparent addresses decode", () => {
    const t = testUnifiedAddress(7);
    assert.deepEqual([...decodeAddress(t.ua).receivers.keys()], [2, 3]);
    assert.equal(decodeAddress(t.ua).network, "testnet");
    assert.equal(decodeAddress(t.sapling).receivers.get(2), "07".repeat(43));
    const tm = base58check(Buffer.concat([Buffer.from([0x1d, 0x25]), Buffer.alloc(20, 9)]));
    assert.ok(tm.startsWith("tm"));
    assert.deepEqual(decodeAddress(tm), { network: "testnet", receivers: new Map([[0, "09".repeat(20)]]) });
    const t2 = base58check(Buffer.concat([Buffer.from([0x1c, 0xba]), Buffer.alloc(20, 3)]));
    assert.equal(decodeAddress(t2).receivers.get(1), "03".repeat(20));
  });

  it("refuses anything it cannot fully check", () => {
    const t = testUnifiedAddress(1);
    const flip = t.ua.slice(0, -1) + (t.ua.endsWith("q") ? "p" : "q");
    for (const bad of [flip, "utest1" + "a".repeat(100), t.ua.toUpperCase().slice(0, 10) + t.ua.slice(10), "zs1qqqq", "tmXXXXXXXX",
      base58check(Buffer.concat([Buffer.from([0x99, 0x99]), Buffer.alloc(20)])), "hello", "",
      // A unified address with no shielded receiver is not valid.
      encodeUnifiedAddress("testnet", new Map([[0, new Uint8Array(20)], [1, new Uint8Array(20)]])),
      // Wrong receiver length.
      encodeUnifiedAddress("testnet", new Map([[3, new Uint8Array(42)]])),
      // Two transparent receivers.
      encodeUnifiedAddress("testnet", new Map([[0, new Uint8Array(20)], [1, new Uint8Array(20)], [3, new Uint8Array(43)]])),
      // A Sapling address of the wrong length.
      bech32Encode("ztestsapling", new Uint8Array(42), "bech32"),
      // A bech32 (not bech32m) unified address.
      bech32Encode("utest", Buffer.from(bech32Decode(t.ua, "bech32m").data), "bech32"),
    ]) {
      assert.throws(() => decodeAddress(bad), Error, bad.slice(0, 30));
    }
  });
});

describe("planned recipient check", () => {
  const to = testUnifiedAddress(11), other = testUnifiedAddress(22), change = testUnifiedAddress(33);

  it("accepts an output to any receiver of the requested address, with change beside it", () => {
    assertPlannedRecipient([{ address: to.orchardOnly, valueZats: 5000n }, { address: change.orchardOnly, valueZats: 900n }], to.ua, 5000n);
    assertPlannedRecipient([{ address: to.sapling, valueZats: 5000n }], to.ua, 5000n);
    // Orchard padding outputs carry no value and are skipped, whatever they name.
    assertPlannedRecipient([{ address: to.orchardOnly, valueZats: 5000n }, { address: "padding", valueZats: 0n }], to.ua, 5000n);
    // A Sapling recipient is matched by its own receiver.
    assertPlannedRecipient([{ address: to.sapling, valueZats: 5000n }], to.sapling, 5000n);
  });

  it("refuses a transaction that pays someone else the requested amount", () => {
    assert.throws(() => assertPlannedRecipient([{ address: other.orchardOnly, valueZats: 5000n }, { address: change.orchardOnly, valueZats: 900n }], to.ua, 5000n),
      (e: unknown) => e instanceof RecipientMismatchError && e.code === "RECIPIENT_MISMATCH" && /does not pay the requested recipient/.test(e.message));
  });

  it("refuses a wrong amount to the recipient, split or not", () => {
    assert.throws(() => assertPlannedRecipient([{ address: to.orchardOnly, valueZats: 5001n }], to.ua, 5000n), /5001 zatoshis, not the 5000/);
    assert.throws(() => assertPlannedRecipient([{ address: to.orchardOnly, valueZats: 5000n }, { address: to.sapling, valueZats: 5000n }], to.ua, 5000n), /10000 zatoshis/);
  });

  it("refuses an output or recipient that cannot be decoded, and a network mismatch", () => {
    assert.throws(() => assertPlannedRecipient([{ address: to.orchardOnly, valueZats: 5000n }, { address: "garbage", valueZats: 1n }], to.ua, 5000n), /cannot be checked/);
    assert.throws(() => assertPlannedRecipient([{ address: to.orchardOnly, valueZats: 5000n }], "utest1" + "a".repeat(100), 5000n), /requested recipient cannot be decoded/);
    const mainnetTwin = encodeUnifiedAddress("mainnet", new Map([[3, new Uint8Array(43).fill(11 ^ 0x5a)]]));
    assert.throws(() => assertPlannedRecipient([{ address: mainnetTwin, valueZats: 5000n }], to.ua, 5000n), /does not pay/);
  });
});
