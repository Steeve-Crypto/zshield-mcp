// Takes the wallet lease the way a server process does and reports what happened, one JSON
// line per event. Its lease time comes from ZSHIELD_LOCK_LEASE_MS.
// argv: <dir> <holdMs> <waitMs> [rounds] [marker]
// With a marker file, each round creates it exclusively inside the critical section and
// reports "overlap" if it already exists, so a second holder shows up.
import { closeSync, openSync, unlinkSync } from "node:fs";
import { acquireFileLock } from "../../src/payments/filelock.ts";

const [dir, holdMs, waitMs, rounds = "1", marker] = process.argv.slice(2);
const say = (o: object) => process.stdout.write(JSON.stringify({ pid: process.pid, t: Date.now(), ...o }) + "\n");
for (let i = 0; i < Number(rounds); i++) {
  let lease;
  try {
    lease = await acquireFileLock(dir, { waitMs: Number(waitMs), purpose: "lock-driver" });
  } catch (e) {
    say({ event: "busy", message: e instanceof Error ? e.message : String(e) });
    continue;
  }
  say({ event: "acquired", round: i });
  let fd: number | undefined;
  if (marker) {
    try {
      fd = openSync(marker, "wx");
    } catch {
      say({ event: "overlap", round: i });
    }
  }
  await new Promise((r) => setTimeout(r, Number(holdMs)));
  try {
    lease.assertHeld();
    say({ event: "held" });
  } catch (e) {
    say({ event: "lost", message: e instanceof Error ? e.message : String(e) });
  }
  if (fd !== undefined) {
    closeSync(fd);
    try {
      unlinkSync(marker!);
    } catch {
      // Gone already.
    }
  }
  lease.release();
}
process.exit(0);
