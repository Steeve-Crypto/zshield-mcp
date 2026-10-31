// INVARIANT SUITE driver: one server operation in its own process, like a second MCP server
// on the same wallet (copy of tests/fixtures/race-driver.mts with extra ops and hooks).
// argv: pay <key> <amount> | recover | status <key> | status-op <operation id> | reads <rounds> | recover-then-pay <key>
// Hooks, all from the environment:
//   PAUSE_AT=fence1|fence2, PAUSE_FILE=<path>: the pay stops right after the Nth fence()
//     returned (fence1 = before the build starts, fence2 = before the transmit starts),
//     writes <path>.reached, and waits for <path>.go.
//   CRASH_AT=<n>: the process SIGKILLs itself just before its nth durable fs call
//     (link, rename, fsync, unlink) during the pay. It writes <path>/crash.txt first.
//     Without a crash it prints how many durable calls the pay made.

import fs from "node:fs";
import { loadConfig } from "../../../src/config.ts";
import { createChain } from "../../../src/server.ts";
import { executePay } from "../../../src/tools/pay.ts";
import { paymentStatus } from "../../../src/tools/status.ts";
import { executeBalance } from "../../../src/tools/balance.ts";
import { executeReceiveAddress } from "../../../src/tools/address.ts";
import { executeHistory } from "../../../src/tools/history.ts";
import { recoverPendingPayments } from "../../../src/payments/recovery.ts";

const [op, key, amount] = process.argv.slice(2);
const config = loadConfig();
const chain = createChain(config);
const sleepBuf = new Int32Array(new SharedArrayBuffer(4));

function installPause() {
  const at = process.env.PAUSE_AT;
  const file = process.env.PAUSE_FILE;
  if (!at || !file) return;
  const orig = chain.pay.bind(chain);
  (chain as any).pay = (req: any) => {
    const fence = req.fence;
    let n = 0;
    req.fence = () => {
      fence?.();
      n++;
      if (at === `fence${n}`) {
        fs.writeFileSync(`${file}.reached`, String(process.pid));
        while (!fs.existsSync(`${file}.go`)) Atomics.wait(sleepBuf, 0, 0, 20);
      }
    };
    return orig(req);
  };
}

let durableCalls = 0;
function installCrash() {
  const at = Number(process.env.CRASH_AT ?? 0);
  const dir = process.env.CRASH_DIR;
  for (const name of ["linkSync", "renameSync", "fsyncSync", "unlinkSync"] as const) {
    const orig = (fs as any)[name] as (...a: unknown[]) => unknown;
    (fs as any)[name] = (...a: unknown[]) => {
      durableCalls++;
      if (at && durableCalls === at) {
        const what = typeof a[0] === "string" ? `${name} ${a[0]}${typeof a[1] === "string" ? " -> " + a[1] : ""}` : `${name} fd=${a[0]}`;
        if (dir) fs.writeFileSync(`${dir}/crash.txt`, what);
        process.kill(process.pid, "SIGKILL");
      }
      return orig.apply(fs, a);
    };
  }
}

async function pay(k: string | undefined, amt: string | undefined) {
  const input: Record<string, unknown> = { amount_zec: amt ?? "0.001", recipient: process.env.RACE_RECIPIENT!, idempotency_key: k };
  // An operation id supplied by the caller must be ignored: ZShield makes its own.
  if (process.env.OPERATION_ID) input.operation_id = process.env.OPERATION_ID;
  const r = await executePay(input as never, { config, chain });
  return { code: r.code, ...JSON.parse(r.text) };
}

let result: unknown;
if (op === "pay") {
  installPause();
  if (process.env.CRASH_AT !== undefined) installCrash();
  const r = await pay(key, amount);
  result = process.env.CRASH_AT !== undefined ? { ...r, durable_calls: durableCalls } : r;
} else if (op === "recover") {
  result = await recoverPendingPayments(config, chain);
} else if (op === "recover-then-pay") {
  const recovered = await recoverPendingPayments(config, chain);
  result = { recovered, pay: await pay(key, amount) };
} else if (op === "status") {
  try {
    result = await paymentStatus(config, chain, { idempotency_key: key });
  } catch (e) {
    result = { error: e instanceof Error ? e.message : String(e), code: (e as { code?: string }).code };
  }
} else if (op === "status-op") {
  try {
    result = await paymentStatus(config, chain, { operation_id: key } as never);
  } catch (e) {
    result = { error: e instanceof Error ? e.message : String(e), code: (e as { code?: string }).code };
  }
} else if (op === "reads") {
  const rounds = Number(key ?? 1);
  const codes: string[] = [];
  for (let i = 0; i < rounds; i++) {
    const deps = { config, chain };
    for (const r of [await executeBalance(deps), await executeReceiveAddress(deps), await executeHistory({} as never, deps)]) codes.push(String((r as { audit: { code?: string } }).audit.code ?? "ok"));
    try {
      await paymentStatus(config, chain, { idempotency_key: process.env.STATUS_KEY ?? "none" });
      codes.push("ok");
    } catch (e) {
      codes.push(String((e as { code?: string }).code ?? "error"));
    }
  }
  result = { codes };
}
process.stdout.write(JSON.stringify(result) + "\n");
process.exit(0);
