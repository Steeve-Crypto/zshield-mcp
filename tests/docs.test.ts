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

  it("stays honest about the live fingerprint while the code still derives it from txid and recipient", () => {
    const live = read("src/chain/live.ts");
    if (/update\(`\$\{txid\}\|\$\{req\.recipient\}`\)/.test(live)) {
      assert.match(doc, /not derived from a real viewing key/);
      assert.match(doc, /sha256\(txid \| recipient\)/);
    }
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
