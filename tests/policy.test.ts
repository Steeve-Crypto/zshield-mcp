import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertWithinCap, PolicyError } from "../src/policy/caps.ts";
import { AmountError, formatZats, parseZecToZats } from "../src/policy/amount.ts";
import {
  assertRecipientAllowed,
  isRecipientAllowed,
  loadAllowlist,
} from "../src/policy/allowlist.ts";

describe("caps", () => {
  it("allows amount at or under cap", () => {
    assert.doesNotThrow(() => assertWithinCap(0.05, 0.1));
    assert.doesNotThrow(() => assertWithinCap(0.1, 0.1));
  });

  it("rejects over cap", () => {
    assert.throws(() => assertWithinCap(0.2, 0.1), PolicyError);
  });

  it("rejects non-positive amounts", () => {
    assert.throws(() => assertWithinCap(0, 0.1), PolicyError);
    assert.throws(() => assertWithinCap(-1, 0.1), PolicyError);
  });
});

describe("parseZecToZats", () => {
  it("parses decimal strings and numbers to exact zatoshis", () => {
    assert.equal(parseZecToZats("1"), 100_000_000n);
    assert.equal(parseZecToZats("0.05"), 5_000_000n);
    assert.equal(parseZecToZats(0.05), 5_000_000n);
    assert.equal(parseZecToZats("0.00000001"), 1n);
    assert.equal(parseZecToZats(1e-8), 1n);
    assert.equal(parseZecToZats(0.29), 29_000_000n);
    assert.equal(parseZecToZats("1.10000000"), 110_000_000n);
    assert.equal(parseZecToZats(" 0.1 "), 10_000_000n);
    assert.equal(parseZecToZats("21000000"), 2_100_000_000_000_000n);
  });

  it("rejects amounts above the 21M ZEC supply", () => {
    assert.throws(() => parseZecToZats("21000000.00000001"), /supply/);
    assert.throws(() => parseZecToZats(1e21), /supply/);
    assert.throws(() => assertWithinCap("0.01", "99999999"), /Invalid spending cap/);
  });

  it("rejects more than 8 decimals instead of rounding", () => {
    assert.throws(() => parseZecToZats("0.000000001"), /more than 8 decimal places/);
    assert.throws(() => parseZecToZats("0.123456789"), /more than 8 decimal places/);
    assert.throws(() => parseZecToZats(1e-9), /more than 8 decimal places/);
    assert.throws(() => parseZecToZats(0.1 + 0.2), /more than 8 decimal places/);
    assert.throws(() => parseZecToZats("1.000000000"), /more than 8 decimal places/);
  });

  it("rejects zero", () => {
    for (const v of [0, -0, "0", "0.0", "0.00000000"]) {
      assert.throws(() => parseZecToZats(v), /greater than zero/, String(v));
    }
  });

  it("rejects negative amounts", () => {
    for (const v of [-1, -0.01, "-1", "-0.00000001"]) {
      assert.throws(() => parseZecToZats(v), /must be positive/, String(v));
    }
  });

  it("rejects non-finite amounts", () => {
    for (const v of [NaN, Infinity, -Infinity, "NaN", "Infinity", "-Infinity"]) {
      assert.throws(() => parseZecToZats(v), /finite/, String(v));
    }
  });

  it("rejects malformed input", () => {
    for (const v of ["", "abc", "1e-8", "0x10", "1,5", ".5", "5.", "+1", "1 2"]) {
      assert.throws(() => parseZecToZats(v), AmountError, JSON.stringify(v));
    }
    assert.throws(() => parseZecToZats(null), AmountError);
    assert.throws(() => parseZecToZats(10n), AmountError);
  });

  it("formats zatoshis back to ZEC", () => {
    assert.equal(formatZats(5_000_000n), "0.05");
    assert.equal(formatZats(100_000_000n), "1");
    assert.equal(formatZats(1n), "0.00000001");
  });
});

describe("caps in zatoshis", () => {
  it("returns the amount in zatoshis", () => {
    assert.equal(assertWithinCap("0.05", 0.1), 5_000_000n);
  });

  it("compares exactly at the cap boundary", () => {
    assert.doesNotThrow(() => assertWithinCap("0.1", "0.1"));
    assert.doesNotThrow(() => assertWithinCap("0.3", 0.3));
    assert.throws(() => assertWithinCap("0.10000001", 0.1), /exceeds/);
    assert.doesNotThrow(() => assertWithinCap("0.09999999", 0.1));
  });

  it("rejects sub-zatoshi amounts that would round under the cap", () => {
    assert.throws(() => assertWithinCap("0.100000004", 0.1), PolicyError);
    assert.throws(() => assertWithinCap("0.000000004", 0.1), /more than 8 decimal places/);
  });

  it("rejects non-finite amounts with a PolicyError", () => {
    assert.throws(() => assertWithinCap(NaN, 0.1), PolicyError);
    assert.throws(() => assertWithinCap(Infinity, 0.1), PolicyError);
  });

  it("applies the same rules to the cap", () => {
    for (const cap of [0, -1, NaN, Infinity, "0.123456789", "abc"]) {
      assert.throws(() => assertWithinCap("0.01", cap), /Invalid spending cap/, String(cap));
    }
  });
});

describe("allowlist", () => {
  it("loads and matches recipients", () => {
    const dir = mkdtempSync(join(tmpdir(), "zshield-al-"));
    const path = join(dir, "allow.json");
    writeFileSync(
      path,
      JSON.stringify({
        recipients: [{ address: "u1allowed", label: "ok" }],
      })
    );
    const list = loadAllowlist(path);
    assert.equal(isRecipientAllowed("u1allowed", list), true);
    assert.equal(isRecipientAllowed("u1stranger", list), false);
    assert.equal(assertRecipientAllowed("u1allowed", list).label, "ok");
    assert.throws(() => assertRecipientAllowed("u1stranger", list), PolicyError);
  });
});

describe("loadAllowlist errors", () => {
  it("rejects a missing file with a PolicyError", () => {
    assert.throws(() => loadAllowlist("/nonexistent/allow.json"), PolicyError);
  });
  it("rejects malformed JSON with a PolicyError", () => {
    const f = join(mkdtempSync(join(tmpdir(), "zs-")), "a.json");
    writeFileSync(f, "{not json");
    assert.throws(() => loadAllowlist(f), PolicyError);
  });
});
