// Runs one command under the OS wallet lock through the real runner and reports the result as
// one JSON line. argv: <bin> <lockFile> <waitMs> [deadlineOffsetMs]
import { defaultRunner } from "../../src/chain/live.ts";

const [bin, lockFile, waitMs, deadlineOffset] = process.argv.slice(2);
const say = (o: object) => process.stdout.write(JSON.stringify({ pid: process.pid, t: Date.now(), ...o }) + "\n");
try {
  const out = await defaultRunner(bin, [], {
    lockFile,
    lockWaitMs: Number(waitMs),
    timeoutMs: 60_000,
    ...(deadlineOffset ? { lockDeadlineMs: Date.now() + Number(deadlineOffset) } : {}),
  });
  say({ event: "ran", out: out.trim() });
} catch (e) {
  say({ event: "failed", name: e instanceof Error ? e.name : "?", kind: (e as { kind?: string }).kind, message: e instanceof Error ? e.message : String(e) });
}
