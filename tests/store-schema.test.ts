import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { MockChainAdapter } from "../src/chain/mock.ts";
import { storeFor, resetPaymentStores } from "../src/payments/store.ts";
import { executePay } from "../src/tools/pay.ts";
import { tempConfig, ALLOWED } from "./helpers.ts";
function setup() {
  const config=tempConfig(),chain=new MockChainAdapter(),store=storeFor(config,chain);
  store.writeIntent({call_id:"original",ts:new Date().toISOString(),amount_zec:"0.001",amount_zats:"100000",recipient:ALLOWED,allowlist_hit:true,cap_zec:"0.1",view_key_fingerprint:null,two_step:true,transmit_tracked:true});
  return {config,chain,store,dir:join(store.dir,"calls","original")};
}
describe("persisted payment schema",()=>{
  it("malformed intent JSON fails closed instead of disappearing",()=>{
    const {store,dir}=setup();fs.writeFileSync(join(dir,"intent.json"),"{truncated");
    assert.throws(()=>store.unresolvedSend("replacement"),/persisted payment/);
  });
  it("unknown event states and mismatched identities cannot erase authorization",()=>{
    for(const event of [{state:"future_paid",call_id:"original"},{state:"pending",call_id:"other"},{state:"__proto__",call_id:"original"}]) {
      const {store,dir}=setup();fs.writeFileSync(join(dir,"bad.json"),JSON.stringify({ts:new Date().toISOString(),by:"send",transmit_authorized:true,...event}));
      assert.throws(()=>store.readCall("original"),/persisted payment/);
    }
  });
  it("unknown fields and incorrectly typed protocol flags fail closed",()=>{
    for(const extra of [{future_protocol:2},{transmit_tracked:"true"},{two_step:0}]) {
      const {store,dir}=setup();const file=join(dir,"intent.json");fs.writeFileSync(file,JSON.stringify({...JSON.parse(fs.readFileSync(file,"utf8")),...extra}));
      assert.throws(()=>store.readCall("original"),/persisted payment/);
    }
  });
  it("truncated event history is refused rather than silently capped",()=>{
    const {store,dir}=setup();for(let i=0;i<65;i++)fs.writeFileSync(join(dir,`${i}.json`),JSON.stringify({ts:new Date().toISOString(),call_id:"original",state:"pending",by:"send"}));
    assert.throws(()=>store.readCall("original"),/persisted payment/);
  });
  it("corrupt bindings and unknown metadata versions fail closed",()=>{
    const {store}=setup();store.bindKey("bound","original","hash");const file=fs.readdirSync(join(store.dir,"keys"))[0];
    fs.writeFileSync(join(store.dir,"keys",file),JSON.stringify({key:"bound",call_id:"original",params_sha256:3,ts:new Date().toISOString()}));
    assert.throws(()=>store.readKey("bound"),/persisted payment/);
    fs.writeFileSync(join(store.dir,"meta.json"),JSON.stringify({version:999,created:new Date().toISOString(),note:"future"}));
    assert.throws(()=>store.initialized,/persisted payment/);
  });
  it("corrupt authorization evidence blocks replacement without a chain call",async()=>{
    const {config,chain,store,dir}=setup();fs.writeFileSync(join(dir,"auth.json"),"bad JSON");let sends=0;chain.pay=async()=>{sends++;throw new Error("must not run");};
    const out=await executePay({amount_zec:"0.001",recipient:ALLOWED,idempotency_key:"new"},{config,chain});
    assert.equal(out.ok,false);assert.equal(sends,0);
  });
});

it("restart cannot route a corrupt store into a fresh fallback directory", () => {
  const {config,chain,dir}=setup();
  fs.writeFileSync(join(dir,"intent.json"),"bad JSON");
  resetPaymentStores();
  assert.throws(()=>storeFor(config,chain),/persisted payment/);
});
