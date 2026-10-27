import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("security model doc", () => {
  const doc = read("docs/SECURITY_MODEL.md");

  it("covers the required sections", () => {
    for (const h of [
      "## Where keys live",
      "## What the server can do",
      "## What the server cannot do",
      "## Trust boundaries",
      "## Threats and mitigations",
      "## Out of scope",
    ]) {
      assert.ok(doc.includes(h), `missing ${h}`);
    }
  });

  it("describes the fingerprint the code actually computes", () => {
    const live = read("src/chain/live.ts");
    assert.ok(live.includes('"export_ufvk"'), "live adapter reads the UFVK");
    assert.ok(!/update\(`\$\{txid\}\|\$\{req\.recipient\}`\)/.test(live), "no txid fingerprint left in code");
    assert.match(doc, /sha256\(salt \| UFVK\)/);
    assert.ok(!/sha256\(txid \| recipient\)/.test(doc), "doc still describes the old txid hash");
    assert.ok(!/comes from the txid and recipient/.test(read("README.md")));
  });

  it("is linked from the README", () => {
    assert.ok(read("README.md").includes("docs/SECURITY_MODEL.md"));
  });
});

describe("docs style", () => {
  for (const f of ["README.md", "docs/AUDIT.md", "docs/SECURITY_MODEL.md"]) {
    it(`${f} has no em dashes or banned references`, () => {
      const text = read(f);
      assert.ok(!text.includes("\u2014"), "em dash");
      assert.ok(!/amonles/i.test(text));
      assert.ok(!/linkedin\.com/i.test(text));
    });
  }
});
