// Invariants I9 and I10: crashes and uncertain broadcasts.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { PAY_UNKNOWN_CODES } from "../../src/errors.ts";
import { killGroup, proc, sends, until, world, type World } from "./helpers.ts";

const ALLOWED_FINAL_WITH_SEND = new Set(["broadcast", "mined", "unknown"]);

/** Run `fn` over 1..n with at most `width` running at once. */
async function pool<T>(items: number[], width: number, fn: (i: number) => Promise<T>): Promise<T[]> {
  const out: T[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: width }, async () => {
      while (next < items.length) {
        const i = items[next++];
        out[i - 1] = await fn(i);
      }
    })
  );
  return out;
}

describe("crash and uncertainty invariants", { timeout: 600_000 }, () => {
  it("I9 crash_matrix: SIGKILL at every durable operation of one pay, then recover and retry the same key", async () => {
    // Probe: how many durable fs operations does one uncrashed pay make?
    const probeW = world();
    const probe = await proc(probeW, "probe", ["pay", "k-matrix"], { CRASH_AT: "0" }).done;
    assert.equal(probe.status, "ok", JSON.stringify(probe));
    const total = probe.durable_calls as number;
    assert.ok(total > 5, `implausible durable operation count ${total}`);

    const rows = await pool(
      Array.from({ length: total }, (_, i) => i + 1),
      6,
      async (n) => {
        const w = world();
        const first = proc(w, "crash", ["pay", "k-matrix"], { CRASH_AT: String(n), CRASH_DIR: w.root });
        let crashed = true;
        try {
          await first.done;
          crashed = false;
        } catch {
          // killed, as intended
        }
        await first.exited;
        killGroup(first.child, "SIGKILL"); // a leftover wallet process, if any
        const at = existsSync(join(w.root, "crash.txt")) ? readFileSync(join(w.root, "crash.txt"), "utf8") : "(no crash)";
        const retry = await proc(w, "retry", ["recover-then-pay", "k-matrix"]).done;
        const status = await proc(w, "status", ["status", "k-matrix"]).done;
        return { n, crashed, at, retry, status, sends: sends(w).length };
      }
    );

    const violations: string[] = [];
    for (const r of rows) {
      const state = r.status.state ?? r.status.code ?? "none";
      if (r.sends > 1) violations.push(`N=${r.n} (${r.at}): ${r.sends} transmits for one key`);
      if (r.sends === 1 && !ALLOWED_FINAL_WITH_SEND.has(state)) violations.push(`N=${r.n} (${r.at}): transmitted once but the call reads ${state}`);
      if (r.sends === 1 && r.retry.pay.ok !== true && !(r.retry.pay.status === "unknown" || (PAY_UNKNOWN_CODES as readonly string[]).includes(r.retry.pay.code))) {
        violations.push(`N=${r.n} (${r.at}): transmitted once but the retry answered ${r.retry.pay.code}/${r.retry.pay.status}`);
      }
      if (r.sends === 0 && !(r.retry.pay.ok === true)) {
        // Nothing went out and the retry did not pay: acceptable only as an unresolved or cleanly refused key.
        const s = r.retry.pay.status;
        if (!["error", "unknown", "pending", "rejected"].includes(s)) violations.push(`N=${r.n} (${r.at}): nothing sent and the retry answered ${JSON.stringify(r.retry.pay).slice(0, 120)}`);
      }
    }
    const summary = rows.map((r) => `N=${r.n} ${r.crashed ? "crashed" : "no-crash"} sends=${r.sends} retry=${r.retry.pay.ok ? "ok" : r.retry.pay.code} state=${r.status.state ?? r.status.code}`).join("\n");
    process.stdout.write(`# I9 matrix (${total} kill points)\n${summary.replace(/^/gm, "# ")}\n`);
    assert.deepEqual(violations, [], `${violations.length} kill points broke the invariant of ${total}:\n${violations.join("\n")}`);
  });

  /** Make a pay unknown by killing the fake wallet process mid transmit. */
  async function unknownPay(w: World, key: string, mode: string, extra: Record<string, string> = {}) {
    const env = { FAKE_ZINGO_SEND: mode, ...extra };
    const p = proc(w, `pay-${key}`, ["pay", key], env);
    if (mode === "hang" || mode === "hang_before_accept") {
      await until(() => existsSync(join(w.chain, "hang.pid")), "the fake wallet to hang in transmit");
      process.kill(Number(readFileSync(join(w.chain, "hang.pid"), "utf8")), "SIGKILL");
    }
    return p.done;
  }

  for (const mode of ["hang", "hang_before_accept", "die_after_accept"]) {
    it(`I10 uncertain_broadcast (${mode}): unknown, never failed or not_sent, and the key replays as unknown`, async () => {
      const w = world();
      const r = await unknownPay(w, "inv-10", mode);
      assert.equal(r.status, "unknown", `expected unknown, got ${r.status}/${r.code}: ${String(r.message).slice(0, 200)}`);
      assert.ok((PAY_UNKNOWN_CODES as readonly string[]).includes(r.code), `code ${r.code} is not an unknown code`);
      const again = await proc(w, "replay", ["pay", "inv-10"]).done;
      assert.equal(again.status, "unknown", `replay said ${again.status}/${again.code}`);
      assert.ok((PAY_UNKNOWN_CODES as readonly string[]).includes(again.code), `replay code ${again.code} is not an unknown code`);
      assert.ok(sends(w).length <= 1, "the replay must not send again");
    });
  }
});
