import fs from "node:fs";
import { join } from "node:path";
import { readPrivate, checkPrivateFile } from "../fsafe.js";
import { fallbackAuditPath } from "../audit/log.js";
import { AUDIT_SLOT_BYTES, DEFAULT_AUDIT_MAX_BYTES } from "../audit/budget.js";
import { parseZecToZats } from "../policy/amount.js";
import type { Config } from "../types.js";
import type { PaymentStore } from "../payments/store.js";

/** Local operator metrics. Never exports recipients, memos, keys, paths or credentials. */
export function operationalHealth(config: Config, store: PaymentStore) {
 const alerts: string[]=[];
 let paused=true,unresolved:number|null=null,total:string|null=null;
 try {paused=readPrivate(join(store.dir,"payments.pause"),4096)!==undefined;} catch {alerts.push("PAUSE_STATE_UNREADABLE");}
 if(paused) alerts.push("PAYMENTS_PAUSED");
 try {unresolved=store.pendingCalls().length;if(unresolved>0)alerts.push("UNRESOLVED_PAYMENTS");} catch {alerts.push("PAYMENT_STATE_UNREADABLE");}
 const controls=!!config.totalSpendingCapZec && !!config.approvalPublicKeys?.length;
 if(!controls) alerts.push("FINANCIAL_CONTROLS_MISSING");
 try {
  const raw=readPrivate(join(store.dir,"spending-budget/ledger.json"),4096);
  if(raw) {
   const ledger=JSON.parse(raw);
   if(ledger.version!==1 || typeof ledger.total!=="string" || !/^(0|[1-9][0-9]{0,30})$/.test(ledger.total))throw new Error("bad ledger");
   total=ledger.total;
   if(!config.totalSpendingCapZec)alerts.push("SPENDING_CONFIGURATION_MISSING");
   else if(BigInt(total!)*100n>=parseZecToZats(config.totalSpendingCapZec)*80n)alerts.push("SPENDING_ALLOWANCE_LOW");
  }
 } catch {alerts.push("SPENDING_STATE_UNREADABLE");}
 const fallback=fallbackAuditPath(config.auditDir,config.auditFallbackPath);
 const capacity=(root:string,daily:boolean)=>{
  try {
   const directory=root+".budget",raw=readPrivate(join(directory,"baseline.json"),1024);
   let baseline=raw ? JSON.parse(raw).bytes : 0;
   if(!raw) {
    const files=daily?fs.readdirSync(root).filter(n=>/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).map(n=>join(root,n)):[root];
    for(const file of files) {checkPrivateFile(file);try{baseline+=fs.statSync(file).size;}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}}
   }
   if(!Number.isSafeInteger(baseline)||baseline<0)throw new Error("bad baseline");
   const names=fs.existsSync(directory)?fs.readdirSync(directory):[];
   return Object.fromEntries(["payment","diagnostic"].map(pool=>{
    const file=join(directory,pool+".counter");checkPrivateFile(file);
    let count=names.filter(n=>new RegExp(`^${pool}-[0-9]+$`).test(n)).length;
    try{count+=fs.statSync(file).size;}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
    const limit=(pool==="payment"?config.auditMaxBytes:config.auditDiagnosticMaxBytes)??DEFAULT_AUDIT_MAX_BYTES;
    const reserved=baseline+count*AUDIT_SLOT_BYTES;
    return [pool,{reserved_bytes:reserved,limit_bytes:limit,remaining_bytes:Math.max(0,limit-reserved)}];
   }));
  } catch {return null;}
 };
 const audit={primary:capacity(config.auditDir,true),fallback:capacity(fallback,false)};
 for(const [sink,pools] of Object.entries(audit)) {
  if(!pools){alerts.push(`AUDIT_${sink.toUpperCase()}_UNREADABLE`);continue;}
  for(const [pool,state] of Object.entries(pools))if(state.remaining_bytes<=state.limit_bytes/5)alerts.push(`AUDIT_${sink.toUpperCase()}_${pool.toUpperCase()}_LOW`);
 }
 try {const st=fs.statfsSync(store.dir);if(st.bavail*st.bsize<64*1024*1024)alerts.push("WALLET_DISK_LOW");}catch{alerts.push("DISK_CAPACITY_UNAVAILABLE");}
 return {ok:alerts.length===0,alerts,payments_paused:paused,unresolved_calls:unresolved,financial_controls_configured:controls,reserved_principal_zats:total,audit};
}
