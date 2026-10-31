import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { withEnv } from "./helpers.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const json = (f: string) => JSON.parse(readFileSync(join(root, f), "utf8"));

describe("test type-checking", () => {
  it("tsconfig.test.json covers src and tests without emitting", () => {
    const cfg = json("tsconfig.test.json");
    assert.equal(cfg.extends, "./tsconfig.json");
    assert.equal(cfg.compilerOptions.noEmit, true);
    assert.ok(cfg.include.includes("tests/**/*.ts"));
    assert.ok(cfg.include.includes("src/**/*.ts"));
  });
  it("package.json has a typecheck script that uses it", () => {
    assert.equal(json("package.json").scripts.typecheck, "tsc -p tsconfig.test.json");
  });
});

describe("withEnv", () => {
  const NAME = "ZSHIELD_TEST_WITH_ENV";
  it("sets, then removes, a variable that was not there", async () => {
    delete process.env[NAME];
    const seen = await withEnv(NAME, "x", async () => process.env[NAME]);
    assert.equal(seen, "x");
    assert.equal(Object.prototype.hasOwnProperty.call(process.env, NAME), false);
  });
  it("hides a variable, then restores it, even when the callback throws", async () => {
    process.env[NAME] = "before";
    await assert.rejects(
      withEnv(NAME, undefined, async () => {
        assert.equal(process.env[NAME], undefined);
        throw new Error("boom");
      }),
      /boom/
    );
    assert.equal(process.env[NAME], "before");
    delete process.env[NAME];
  });
});
