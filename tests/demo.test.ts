import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const TSX = import.meta.resolve("tsx");

describe("the testnet demo script", () => {
  it("sends once through the real policy path: live sends need a key and the demo supplies one", async () => {
    const root = mkdtempSync(join(tmpdir(), "zshield-demo-"));
    const chain = join(root, "chain");
    mkdirSync(chain);
    const child = spawn(process.execPath, ["--import", TSX, here("../scripts/demo-testnet.ts")], {
      cwd: root,
      env: { PATH: process.env.PATH ?? "", HOME: root, ZINGO_BIN: here("./fixtures/fake-zingo-cli.mjs"), FAKE_ZINGO_STATE: chain },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    assert.equal(code, 0, out);
    assert.match(out, /txid: [0-9a-f]{64}/);
    const sends = readFileSync(join(chain, "sends.jsonl"), "utf8").split("\n").filter(Boolean);
    assert.equal(sends.length, 1);
    assert.ok(!existsSync(join(chain, "overlap.log")));
  });
});
