import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it, mock } from "node:test";
import { join } from "node:path";
import { AUDIT_SLOT_BYTES } from "../src/audit/budget.ts";
import { prepareAuditReservations, writeAuditRow } from "../src/audit/log.ts";
import { ensurePaymentReservation, readPaymentEvidence } from "../src/audit/reservation.ts";
import { tempConfig } from "./helpers.ts";

describe("payment audit disk protection", () => {
  it("F-82 refusal rows cannot use disk still promised to payment rows", () => {
    const config = tempConfig({ auditMaxBytes: 4 * AUDIT_SLOT_BYTES });
    const row = (status: string) => ({ ts: new Date().toISOString(), tool: "zcash_pay", call_id: `c-${status}`, status,
      amount_zec: "0.0001", recipient: "x", allowlist_hit: false, cap_zec: "0.1" }) as never;
    prepareAuditReservations(config); // Reserve real blocks before the traffic flood.
    const journal = ensurePaymentReservation(join(config.auditDir,"2000-01-01.jsonl"),config,true);
    const before = fs.statSync(journal);
    assert.ok(before.blocks * 512 >= before.size, "must allocate real extents, not a sparse length");
    const realWrite = fs.writeSync, realStatfs = fs.statfsSync;
    const space = mock.method(fs, "statfsSync", ((...args: Parameters<typeof fs.statfsSync>) => ({ ...realStatfs(...args), bavail: 0, bfree: 0 })) as typeof fs.statfsSync);
    const diskFull = mock.method(fs, "writeSync", ((fd: number, ...args: unknown[]) => {
      if (fs.realpathSync(`/proc/self/fd/${fd}`).endsWith(".jsonl")) throw Object.assign(new Error("traffic disk full"), { code: "ENOSPC" });
      return (realWrite as (...args: unknown[]) => number)(fd,...args);
    }) as typeof fs.writeSync);
    try {
      assert.equal(writeAuditRow(config, row("rejected"), () => {}).durable, false);
      const paid = writeAuditRow(config, row("ok"));
      assert.equal(paid.durable, true, "payment evidence must use already allocated bytes despite full traffic disk");
      assert.equal(paid.file, journal);
      assert.equal(fs.statSync(journal).size, before.size);
      assert.equal(fs.statSync(journal).blocks, before.blocks);
      assert.deepEqual(readPaymentEvidence(journal).rows.map(r => (r as {call_id:string}).call_id), ["c-ok"]);
    } finally { diskFull.mock.restore(); space.mock.restore(); }
    assert.equal(writeAuditRow(config, row("rejected")).durable, true);
  });
});
