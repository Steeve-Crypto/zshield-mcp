import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { describe, it, mock } from "node:test";
import { AUDIT_SLOT_BYTES, reserveAudit } from "../src/audit/budget.ts";
import { appendAuditEntry } from "../src/audit/log.ts";
import { ensurePaymentReservation, appendPaymentEvidence, readPaymentEvidence, JOURNAL_HEADER_BYTES, paymentReservationUsage } from "../src/audit/reservation.ts";
import { tempConfig } from "./helpers.ts";
const driver=resolve("tests/fixtures/audit-reservation-driver.mts");
const row=(id:string)=>({ts:new Date().toISOString(),tool:"zcash_pay" as const,call_id:id,status:"pending" as const,amount_zec:"0.001",recipient:"x",allowlist_hit:true,cap_zec:"0.1",view_key_fingerprint:null});
function setup(slots=2) {
  const config=tempConfig({auditMaxBytes:slots*AUDIT_SLOT_BYTES}); fs.mkdirSync(config.auditDir,{recursive:true,mode:0o700});
  const file=join(config.auditDir,"2026-11-06.jsonl");
  return {config,file,journal:ensurePaymentReservation(file,config,true)};
}
describe("physical payment evidence reservations",()=>{
  it("reservation exhaustion fails closed without growing the segment",()=>{
    const {journal}=setup(); const before=fs.statSync(journal);
    appendPaymentEvidence(journal,row("a")); appendPaymentEvidence(journal,row("b"));
    assert.throws(()=>appendPaymentEvidence(journal,row("c")),(e:unknown)=>(e as NodeJS.ErrnoException).code==="AUDIT_CAPACITY");
    assert.equal(fs.statSync(journal).size,before.size); assert.equal(fs.statSync(journal).blocks,before.blocks);
    assert.equal(readPaymentEvidence(journal).rows.length,2);
  });
  it("restart reuses original evidence, allocation and capacity",()=>{
    const {journal,file,config}=setup(); appendPaymentEvidence(journal,row("first")); const inode=fs.statSync(journal).ino;
    assert.equal(ensurePaymentReservation(file,config,true),journal); assert.equal(fs.statSync(journal).ino,inode);
    const result=spawnSync(process.execPath,["--import","tsx",driver,"append",journal,"second"],{encoding:"utf8"});
    assert.equal(result.status,0,result.stdout+result.stderr);
    assert.deepEqual(readPaymentEvidence(journal).rows.map(r=>(r as {call_id:string}).call_id),["first","second"]);
    assert.throws(()=>ensurePaymentReservation(file,{auditMaxBytes:3*AUDIT_SLOT_BYTES},true),/offline capacity migration/);
  });
  it("crash during preallocation never publishes partially reserved capacity",()=>{
    const config=tempConfig(), file=join(config.auditDir,"fallback.jsonl");
    const result=spawnSync(process.execPath,["--import","tsx",driver,"crash-init",file],{encoding:"utf8"});
    assert.equal(result.signal,"SIGKILL",result.stdout+result.stderr);
    assert.equal(fs.existsSync(file+".budget/payment-evidence.bin"),false);
    const journal=ensurePaymentReservation(file,config,false); appendPaymentEvidence(journal,row("after-restart"));
    assert.equal(readPaymentEvidence(journal).rows.length,1);
  });
  it("ENOSPC during preallocation fails without publishing a reservation",()=>{
    const config=tempConfig(),file=join(config.auditDir,"2026-11-06.jsonl"); fs.mkdirSync(config.auditDir,{mode:0o700});
    const real=fs.writeSync; const fault=mock.method(fs,"writeSync",((fd:number,...args:unknown[])=>{
      if(fs.realpathSync(`/proc/self/fd/${fd}`).includes(".tmp-reservation-")) throw Object.assign(new Error("disk full"),{code:"ENOSPC"});
      return (real as (...args:unknown[])=>number)(fd,...args);
    }) as typeof fs.writeSync);
    try {assert.throws(()=>ensurePaymentReservation(file,config,true),/disk full/); assert.equal(fs.existsSync(config.auditDir+".budget/payment-evidence.bin"),false);}
    finally {fault.mock.restore();}
    assert.ok(ensurePaymentReservation(file,config,true));
  });
  it("interrupted slots stay consumed and are never reused",()=>{
    const {journal}=setup(); const fd=fs.openSync(journal,"r+"); fs.writeSync(fd,Buffer.from("I"),0,1,JOURNAL_HEADER_BYTES); fs.fsyncSync(fd); fs.closeSync(fd);
    appendPaymentEvidence(journal,row("next"));
    assert.equal(readPaymentEvidence(journal).incomplete,1); assert.equal(paymentReservationUsage(journal.replace(/\.budget\/payment-evidence\.bin$/,"/2000-01-01.jsonl"),true),2);
    assert.throws(()=>appendPaymentEvidence(journal,row("no-space")),/slots exhausted/);
  });
  it("cross-process writers serialize slot ownership without check-then-act",async()=>{
    const {journal}=setup(8);
    const outcomes=await Promise.all(Array.from({length:12},(_,i)=>new Promise<string>((resolve,reject)=>{
      const child=spawn(process.execPath,["--import","tsx",driver,"append",journal,String(i)],{stdio:["ignore","pipe","pipe"]}); let out="",err="";
      child.stdout.on("data",d=>out+=d); child.stderr.on("data",d=>err+=d); child.on("error",reject); child.on("exit",()=>resolve(out.trim()||err));
    })));
    assert.equal(outcomes.filter(s=>s==="OK").length,8,JSON.stringify(outcomes)); assert.equal(outcomes.filter(s=>s==="AUDIT_CAPACITY").length,4,JSON.stringify(outcomes));
    const rows=readPaymentEvidence(journal).rows; assert.equal(new Set(rows.map(r=>(r as {call_id:string}).call_id)).size,8);
  });
  it("legacy reservations remain charged during journal migration",()=>{
    const {file,config,journal}=setup(4); reserveAudit(file,true,config,true); reserveAudit(file,true,config,true);
    appendAuditEntry(config.auditDir,row("a"),config); appendAuditEntry(config.auditDir,row("b"),config);
    assert.throws(()=>appendAuditEntry(config.auditDir,row("c"),config),/slots exhausted/);
    assert.equal(readPaymentEvidence(journal).rows.length,2);
  });
});
