import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertWithinCap, PolicyError } from "../src/policy/caps.ts";
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
