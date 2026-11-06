import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { it } from "node:test";
import { createHash } from "node:crypto";
import { createSnapshot, restoreSnapshot } from "../src/operations/snapshot.ts";

function world() {
 const root=fs.mkdtempSync(join(tmpdir(),"snapshot-test-")),wallet=join(root,"wallet");
 fs.mkdirSync(join(wallet,".zshield-state","keys"),{recursive:true,mode:0o700});
 fs.writeFileSync(join(wallet,"zingo-wallet.dat"),"synthetic-wallet",{mode:0o600});
 fs.writeFileSync(join(wallet,".zshield-state","keys","key.json"),'original-binding',{mode:0o600});
 return {root,wallet};
}
it("snapshot restores wallet and identity together, paused",async()=>{
 const w=world(), backup=join(w.root,"backup"), restored=join(w.root,"restored");
 const result=await createSnapshot({wallet:w.wallet},backup,()=>{});
 await restoreSnapshot(backup,restored,result.manifest_sha256);
 assert.equal(fs.readFileSync(join(restored,"wallet/.zshield-state/keys/key.json"),"utf8"),'original-binding');
 assert.equal(fs.readFileSync(join(restored,"wallet/zingo-wallet.dat"),"utf8"),'synthetic-wallet');
 assert.ok(fs.existsSync(join(restored,"wallet/.zshield-state/payments.pause")));
 await assert.rejects(restoreSnapshot(backup,restored,result.manifest_sha256),/must not exist/);
});
it("tampered and extra files cannot produce a restored wallet",async()=>{
 for(const extra of [false,true]) {
 const w=world(),backup=join(w.root,"backup"),restored=join(w.root,"restore");
 const result=await createSnapshot({wallet:w.wallet},backup,()=>{});
 fs.writeFileSync(join(backup,extra?'wallet/extra':'wallet/zingo-wallet.dat'),'tampered');
 await assert.rejects(restoreSnapshot(backup,restored,result.manifest_sha256),/differs/);
 assert.equal(fs.existsSync(restored),false);
 }
});
it("restore rejects traversal even with a supplied manifest digest",async()=>{
 const w=world(),backup=join(w.root,"backup");
 await createSnapshot({wallet:w.wallet},backup,()=>{});
 const text=JSON.stringify({version:1,entries:[{path:'../escape',sha256:'a'.repeat(64),size:0}]});
 fs.writeFileSync(join(backup,'manifest.json'),text);
 await assert.rejects(restoreSnapshot(backup,join(w.root,'restore'),createHash('sha256').update(text).digest('hex')),/Invalid snapshot entry/);
});
it("snapshot refuses links and interrupted locks without publishing partial data",async()=>{
 const w=world(),target=join(w.root,'backup');
 fs.symlinkSync(join(w.wallet,'zingo-wallet.dat'),join(w.wallet,'alias'));
 await assert.rejects(createSnapshot({wallet:w.wallet},target,()=>{}),/symlink/);
 assert.equal(fs.existsSync(target),false);
 fs.unlinkSync(join(w.wallet,'alias'));
 await assert.rejects(createSnapshot({wallet:w.wallet},target,()=>{throw new Error('lock lost');}),/lock lost/);
 assert.equal(fs.existsSync(target),false);
});
it("maintenance excludes a surviving backend process",async()=>{
 const {spawn}=await import('node:child_process');
 const {wrapForWallet}=await import('../src/chain/walletlock.ts');
 const {acquireMaintenanceLock}=await import('../src/payments/lock.ts');
 const w=world(),dir=join(w.wallet,'.zshield-state');
 const cmd=wrapForWallet(process.execPath,['-e','process.stdout.write("held");setInterval(()=>{},1000)'],{lockFile:join(dir,'zingo.flock'),waitMs:100});
 const child=spawn(cmd.bin,cmd.args,{stdio:['ignore','pipe','pipe']});
 const closed=new Promise<void>(resolve=>child.once('close',()=>resolve()));
 try {
  await new Promise<void>((resolve,reject)=>{child.once('error',reject);child.stdout!.once('data',()=>resolve());});
  await assert.rejects(acquireMaintenanceLock({dir,requireOsLock:true},20),/BUSY|busy|holds/);
 } finally {child.kill('SIGKILL');await closed;}
 const lock=await acquireMaintenanceLock({dir,requireOsLock:true},1000);
 try {lock.assertHeld();} finally {await lock.release();}
});
