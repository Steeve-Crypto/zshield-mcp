import fs from "node:fs";
import { dirname } from "node:path";
import { ensurePrivateDir } from "../../src/fsafe.ts";
import { appendPaymentEvidence, ensurePaymentReservation } from "../../src/audit/reservation.ts";
const [mode,file,id] = process.argv.slice(2);
try {
  if(mode==="crash-init") {
    ensurePrivateDir(dirname(file));
    const write=fs.writeSync;
    fs.writeSync=((fd:number,...args:unknown[])=>{
      const n=(write as (...args:unknown[])=>number)(fd,...args);
      if(fs.realpathSync(`/proc/self/fd/${fd}`).includes(".tmp-reservation-")) process.kill(process.pid,"SIGKILL");
      return n;
    }) as typeof fs.writeSync;
    ensurePaymentReservation(file,{auditMaxBytes:128*8193},false);
  } else {
    appendPaymentEvidence(file,{ts:new Date().toISOString(),call_id:id,tool:"zcash_pay",status:"pending"});
    console.log("OK");
  }
} catch(e) { console.log((e as NodeJS.ErrnoException).code ?? "ERROR"); process.exitCode=1; }
