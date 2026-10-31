import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// Real separate server processes on one wallet dir, each with its own working directory
// and its own relative audit dir. zingo-cli is a fake (fixtures/fake-zingo-cli.mjs)
// whose shared state folder plays the chain and counts every broadcast.

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const DRIVER = here("./fixtures/race-driver.mts");
const ZINGO = here("./fixtures/fake-zingo-cli.mjs");
const TSX = import.meta.resolve("tsx");
const RECIPIENT = "utest1" + "r".repeat(100);

interface World {
  wallet: string;
  chain: string;
  root: string;
}

function world(): World {
  const root = mkdtempSync(join(tmpdir(), "zshield-race-"));
  const wallet = join(root, "wallet");
  const chain = join(root, "chain");
  mkdirSync(wallet, { mode: 0o700 });
  mkdirSync(chain);
  return { wallet, chain, root };
}

function proc(w: World, name: string, args: string[], env: Record<string, string> = {}) {
  const cwd = join(w.root, name);
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, "allow.json"), JSON.stringify({ recipients: [{ address: RECIPIENT }] }));
  const child = spawn(process.execPath, ["--import", TSX, DRIVER, ...args], {
    cwd,
    detached: true,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: w.root,
      CHAIN_MODE: "testnet",
      ZINGO_BIN: ZINGO,
      ZINGO_DATA_DIR: w.wallet,
      AUDIT_DIR: "./audits",
      ALLOWLIST_PATH: "./allow.json",
      VIEW_KEY_FINGERPRINT_SALT: "race",
      SEND_QUEUE_WAIT_MS: "8000",
      FAKE_ZINGO_STATE: w.chain,
      RACE_RECIPIENT: RECIPIENT,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout!.on("data", (d) => (out += d));
  child.stderr!.on("data", (d) => (err += d));
  const done = new Promise<any>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${name} timed out: ${err} OUT:${out}`)), 30_000);
    child.on("exit", () => {
      clearTimeout(t);
      const line = out.trim().split("\n").at(-1);
      try {
        resolve(JSON.parse(line ?? ""));
      } catch {
        reject(new Error(`${name} printed no result. stderr: ${err.slice(0, 2000)}`));
      }
    });
  });
  return { child, done };
}

const sends = (w: World) => {
  const f = join(w.chain, "sends.jsonl");
  return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};

async function until(check: () => boolean, what: string, ms = 20_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const killGroup = (c: ChildProcess, sig: NodeJS.Signals) => {
  try {
    process.kill(-c.pid!, sig);
  } catch {
    // already gone
  }
};

describe("two server processes on one wallet", { timeout: 120_000 }, () => {
  it("different audit dirs: the second process replays the first one's key (V12 F-12)", async () => {
    const w = world();
    const a = await proc(w, "a", ["pay", "race-1"]).done;
    assert.equal(a.status, "ok", JSON.stringify(a));
    const b = await proc(w, "b", ["pay", "race-1"]).done;
    if (process.env.RACE_LOG) console.log("audit dirs: A", a.status, a.txid, "| B", b.status, b.idempotent_replay, b.txid);
    assert.equal(sends(w).length, 1);
    assert.equal(b.idempotent_replay, true, JSON.stringify(b));
    assert.equal(b.txid, a.txid);
  });

  it("a holder frozen with its wallet process: another process cannot take the wallet lock or start a wallet process beside it (V12 F-14)", async () => {
    const w = world();
    const hold = join(w.root, "hold");
    const a = proc(w, "a", ["pay", "race-2"], { FAKE_ZINGO_HOLD: hold });
    await until(() => existsSync(`${hold}.reached`), "process A to reach its health check");
    killGroup(a.child, "SIGSTOP");
    await new Promise((r) => setTimeout(r, 1500));
    // A is frozen and still holds the wallet lock, so B waits its queue time, is refused as
    // BUSY, and starts no wallet process. Nothing is sent.
    const b = await proc(w, "b", ["pay", "race-2"], { ZINGO_HEALTH_TIMEOUT_MS: "2500", ZINGO_READ_TIMEOUT_MS: "2500", HEALTH_SYNC_TIMEOUT_MS: "1000" }).done;
    assert.equal(b.code, "BUSY", JSON.stringify(b));
    assert.equal(sends(w).length, 0);
    writeFileSync(`${hold}.go`, "");
    killGroup(a.child, "SIGCONT");
    const ra = await a.done;
    // A woke still holding the lock and finishes its one send. The retry replays it.
    assert.equal(ra.status, "ok", JSON.stringify(ra));
    assert.equal(sends(w).length, 1, `A: ${JSON.stringify(ra)} B: ${JSON.stringify(b)}`);
    const retry = await proc(w, "c", ["pay", "race-2"]).done;
    assert.equal(retry.idempotent_replay, true, JSON.stringify(retry));
    assert.equal(retry.txid, ra.txid);
    assert.equal(sends(w).length, 1);
  });

  it("four processes pay with different keys at once (and one with none): no two wallet processes ever run together", async () => {
    const w = world();
    const env = { SEND_QUEUE_WAIT_MS: "60000", ZINGO_READ_TIMEOUT_MS: "60000", ZINGO_HEALTH_TIMEOUT_MS: "60000" };
    const all = await Promise.all(["k1", "k2", "k3", "k4"].map((k, i) => proc(w, `p${i}`, ["pay", k, `0.00${i + 1}`], env).done));
    assert.deepEqual(all.map((r) => r.status), ["ok", "ok", "ok", "ok"], JSON.stringify(all.map((r) => r.code)));
    assert.equal(sends(w).length, 4);
    assert.equal(existsSync(join(w.chain, "overlap.log")), false, existsSync(join(w.chain, "overlap.log")) ? readFileSync(join(w.chain, "overlap.log"), "utf8") : "");
  });

  it("concurrent recovery after a crash mid-send settles the call once, and the key is never paid again", async () => {
    const w = world();
    const a = proc(w, "a", ["pay", "race-3"], { FAKE_ZINGO_SEND: "hang" });
    await until(() => sends(w).length === 1, "the broadcast");
    killGroup(a.child, "SIGKILL");
    await a.done.catch(() => undefined);
    const txid = sends(w)[0].txid;
    const [b, c] = await Promise.all([proc(w, "b", ["recover"]).done, proc(w, "c", ["recover"]).done]);
    for (const r of [...b, ...c]) assert.doesNotMatch(String(r.status), /expired|not_found/);
    if (process.env.RACE_LOG) console.log("recover: B", JSON.stringify(b.map((r: any) => r.status)), "C", JSON.stringify(c.map((r: any) => r.status)));
    const s = await proc(w, "d", ["status", "race-3"]).done;
    assert.equal(s.txid, txid, JSON.stringify(s));
    assert.match(String(s.state), /mined|sent/);
    const again = await proc(w, "e", ["pay", "race-3"]).done;
    assert.equal(sends(w).length, 1, JSON.stringify(again));
    assert.equal(again.txid, txid);
    if (process.env.RACE_LOG) console.log("after: status", s.state, "| repay", again.status, again.code ?? "", again.idempotent_replay ?? "");
  });

  it("a process that dies after building but before transmitting sends nothing, and the key stays free to retry", async () => {
    const w = world();
    const a = await proc(w, "a", ["pay", "race-4"], { FAKE_ZINGO_STAGE_EXIT: "1" }).done;
    assert.equal(sends(w).length, 0, JSON.stringify(a));
    assert.notEqual(a.ok, true);
    const st = readFileSync(join(w.chain, "staged.jsonl"), "utf8").split("\n").filter(Boolean);
    assert.equal(st.length, 1);
    const b = await proc(w, "b", ["recover"]).done;
    for (const r of b) assert.notEqual(String(r.status), "confirmed");
    assert.equal(sends(w).length, 0);
  });
});
