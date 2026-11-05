import { operationalHealth } from "../src/operations/health.js";
import fs from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadConfig } from "../src/config.js";
import { createChain } from "../src/server.js";
import { runStartup } from "../src/startup.js";
import { storeFor, paymentParamsHash } from "../src/payments/store.js";
import { acquireWalletLock, acquireMaintenanceLock } from "../src/payments/lock.js";
import { createExclusive, fsyncDir, readPrivate } from "../src/fsafe.js";
import { initializeHistoricalBudget } from "../src/payments/budget.js";
import { fingerprintViewKey, fallbackAuditPath, freezeAuditWrites, unfreezeAuditWrites } from "../src/audit/log.js";
import { payInputSchema } from "../src/tools/pay.js";
import { createSnapshot, restoreSnapshot } from "../src/operations/snapshot.js";

async function main() {
 const [command, arg, digest] = process.argv.slice(2);
 if (command === "restore") {
   const destination = process.argv[5], expectedDigest = process.argv[6];
   if (!arg || !destination || !expectedDigest || digest !== "--to") throw new Error("Usage: restore SNAPSHOT --to NEW_DIRECTORY MANIFEST_SHA256");
   await restoreSnapshot(resolve(arg),resolve(destination),expectedDigest);
   console.log(JSON.stringify({restored:true,payments_paused:true})); return;
 }
 if (!["inspect","pause","unpause","budget-init","backup","approval-payload"].includes(command)) throw new Error("Commands: inspect, pause, unpause --reviewed, budget-init, backup DESTINATION, restore, approval-payload REQUEST_JSON");
 const config=loadConfig(); runStartup(config);
 const chain=createChain(config), store=storeFor(config,chain);
 const pause=join(store.dir,"payments.pause");
 const hadPause = fs.existsSync(pause);
 let createdPause = false;
 if (command==="pause" || command==="backup") {
   createdPause = createExclusive(store.dir,"payments.pause","Operator maintenance\n");
 }
 if (command==="pause") { console.log(JSON.stringify({payments_paused:true,in_flight_transmission_may_complete:true})); return; }
 let lock;
 try {
   lock=command==="backup" ? await acquireMaintenanceLock(store) : await acquireWalletLock(store,30000,"operator");
 } catch (error) {
   // Do not leave an emergency pause stranded when maintenance never started.
   if (createdPause && !hadPause) { try { fs.unlinkSync(pause); fsyncDir(store.dir); } catch { /* best effort */ } }
   throw error;
 }
 try {
  lock.assertHeld();
  if (command==="inspect") {
    const report=operationalHealth(config,store);console.log(JSON.stringify(report,null,2));if(!report.ok)process.exitCode=2;
  } else if (command==="unpause") {
    if(arg!=="--reviewed") throw new Error("Unpause requires --reviewed after checking incidents and unresolved payments");
    fs.unlinkSync(pause);fsyncDir(store.dir);
    console.log(JSON.stringify({payments_paused:false,unresolved_calls:store.pendingCalls().length}));
  } else if(command==="budget-init") {
    initializeHistoricalBudget(store,lock);console.log(JSON.stringify({historical_budget_initialized:true}));
  } else if(command==="approval-payload") {
    if(!arg) throw new Error("Provide a private payment request JSON file");
    const input=payInputSchema.parse(JSON.parse(readPrivate(resolve(arg),16384)??"null"));
    if(!input.idempotency_key || input.resume) throw new Error("Approval requires an exact payment key, not a resume request");
    const fingerprint=fingerprintViewKey(await chain.getViewingKey(),config.viewKeyFingerprintSalt);
    lock.assertHeld();
    console.log(JSON.stringify({domain:"zshield-payment-approval-v1",network:config.chainNetwork ?? "testnet",wallet_fingerprint:fingerprint,idempotency_key:input.idempotency_key,params_sha256:paymentParamsHash(input),expires_at:Date.now()+3600000},null,2));
  } else if(command==="backup") {
    if(!arg || config.chainMode!=="live" || !config.zingoDataDir) throw new Error("Backup requires a configured live wallet and a new destination");
    const destination=resolve(arg), wallet=fs.realpathSync(config.zingoDataDir);
    const settings=fs.mkdtempSync(join(dirname(destination),".snapshot-settings-"));
    try {
      fs.writeFileSync(join(settings,"config.json"),JSON.stringify(config),{mode:0o600});
      const fallback=fallbackAuditPath(config.auditDir,config.auditFallbackPath);
      const sources: Record<string,string>={wallet,settings,allowlist:config.allowlistPath,audit:config.auditDir};
      for(const [label,path] of Object.entries({"audit.budget":config.auditDir+".budget",fallback,"fallback.budget":fallback+".budget",approvals:config.approvalDir})) if(path && fs.existsSync(path)) sources[label]=path;
      freezeAuditWrites();
      let result;
      try { result=await createSnapshot(sources,destination,()=>lock.assertHeld()); }
      finally { unfreezeAuditWrites(); }
      console.log(JSON.stringify({...result,payments_paused:true,contains_wallet_secrets:true}));
    } finally {fs.rmSync(settings,{recursive:true,force:true});}
  }
 } finally {await lock.release();}
}
main().catch(()=>{ console.error("Operator action failed; inspect configuration, permissions and state locally. No automatic unpause or state reset was performed."); process.exitCode=1; });
