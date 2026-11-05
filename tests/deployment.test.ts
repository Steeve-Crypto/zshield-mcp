import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join,dirname} from 'node:path';
import {createHash,generateKeyPairSync} from 'node:crypto';
import {it} from 'node:test';
import {pinExecutable} from '../src/chain/executable.ts';
import {assertFinancialProfile} from '../src/startup.ts';
import {tempConfig} from './helpers.ts';
it('wallet binary pin rejects a replacement and an incorrect digest',()=>{
 const c=tempConfig(),bin=join(dirname(c.auditDir),'wallet-bin');
 fs.writeFileSync(bin,'approved executable',{mode:0o700});
 const digest=createHash('sha256').update('approved executable').digest('hex');
 assert.throws(()=>pinExecutable(bin,'0'.repeat(64)),/approved identity/);
 const check=pinExecutable(bin,digest);check();
 fs.renameSync(bin,bin+'.old');fs.writeFileSync(bin,'approved executable',{mode:0o700});
 assert.throws(check,/approved identity/);
});
it('financial profile refuses missing controls and weak approval thresholds',()=>{
 const c=tempConfig({requireFinancialControls:true,chainMode:'live',chainNetwork:'testnet'});
 assert.throws(()=>assertFinancialProfile(c,'linux'),/TOTAL_SPENDING/);
 c.totalSpendingCapZec='0.01';
 assert.throws(()=>assertFinancialProfile(c,'linux'),/approval trust/);
 c.approvalPublicKeys=[generateKeyPairSync('ed25519').publicKey.export({format:'pem',type:'spki'}).toString()];c.approvalDir='/unused';
 assert.throws(()=>assertFinancialProfile(c,'linux'),/two distinct/);
 assert.throws(()=>assertFinancialProfile(c,'darwin'),/Linux/);
 c.chainNetwork='mainnet';assert.throws(()=>assertFinancialProfile(c,'linux'),/testnet/);
});
