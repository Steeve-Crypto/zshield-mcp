import assert from "node:assert/strict";
import fs from "node:fs";
import { join, dirname } from "node:path";
import { it } from "node:test";
import { LiveChainAdapter, consensusProblem, parseUfvk, type CliRunner } from "../src/chain/live.ts";
import { bindWalletNetwork } from "../src/chain/network-binding.ts";
import { assertFinancialProfile } from "../src/startup.ts";
import { tempConfig } from "./helpers.ts";

const TX = "ab".repeat(32), BRANCH = "12345678", ADDRESS = "u1" + "q".repeat(100);
function fixture() {
  const config = tempConfig();
  const wallet = join(dirname(config.auditDir), "mainnet-wallet");
  fs.mkdirSync(wallet, { mode: 0o700 });
  const calls: { args: string[]; input?: string }[] = [];
  let info = { chain_name: "main", consensus_branch_id: BRANCH, latest_block_height: 1000 };
  let key = "uview1" + "q".repeat(80);
  const runner: CliRunner = async (_bin, args, opts) => {
    calls.push({args, input: opts?.input});
    switch (args.at(-1)) {
      case "export_ufvk": return JSON.stringify({ ufvk: key });
      case "info": return JSON.stringify(info);
      case "height": return '{"height":1000}';
      case "spendable_balance": return '{"spendable_balance":1000000}';
    }
    if (opts?.input?.startsWith("transmit")) return JSON.stringify({txids:[TX]});
    return `{"fee":10000}\n{"txids":["${TX}"]}`;
  };
  const chain = new LiveChainAdapter({network:"mainnet", mainnetEnabled:true, expectedConsensusBranch:BRANCH,
    dataDir:wallet, server:"https://example.com", runner});
  return { chain, calls, wallet, info: (patch: Partial<typeof info>) => {info={...info,...patch};}, key: (k:string) => {key=k;} };
}

it("mainnet requires opt-in, explicit endpoint, wallet and branch", () => {
  assert.throws(() => new LiveChainAdapter({network:"mainnet"}), /explicit/);
  const c = tempConfig({chainMode:"live", chainNetwork:"mainnet", requireFinancialControls:false});
  assert.throws(() => assertFinancialProfile(c), /MAINNET_ENABLED/);
  c.mainnetEnabled=true;
  assert.throws(() => assertFinancialProfile(c), /EXPECTED_CONSENSUS_BRANCH/);
  c.lightwalletd="https://example.com";c.expectedConsensusBranch=BRANCH;
  assert.throws(() => assertFinancialProfile(c,"linux"), /TOTAL_SPENDING/);
  c.lightwalletd="http://example.com";
  assert.throws(() => assertFinancialProfile(c,"linux"), /HTTPS/);
});

it("mainnet uses explicit chain arguments and reserves fees before exact transmit", async () => {
  const w=fixture(), order:string[]=[];
  const result=await w.chain.pay({amountZats:10000n,recipient:ADDRESS,
    stage:id=>{assert.equal(id,TX);order.push("stage");},
    authorizeFee:fee=>{assert.equal(fee,10000n);order.push("fee");},beforeTransmit:()=>order.push("authorize")});
  assert.equal(result.txid,TX);
  assert.deepEqual(order,["stage","fee","authorize"]);
  assert.ok(w.calls.every(c=>c.args[0]==="--chain" && c.args[1]==="mainnet"));
  assert.equal(w.calls.filter(c=>c.input?.startsWith("transmit")).length,1);
  assert.equal(w.calls.at(-1)?.input,`transmit ${TX}\nquit\n`);
});

it("mainnet refuses a testnet recipient, wallet or server before signing", async () => {
  for (const mismatch of ["recipient","wallet","server","branch"]) {
    const w=fixture();
    if(mismatch==="wallet")w.key("uviewtest1"+"q".repeat(80));
    if(mismatch==="server")w.info({chain_name:"test"});
    if(mismatch==="branch")w.info({consensus_branch_id:"ffffffff"});
    await assert.rejects(w.chain.pay({amountZats:10000n,recipient:mismatch==="recipient"?"utest1"+"q".repeat(80):ADDRESS}));
    assert.equal(w.calls.filter(c=>c.input).length,0);
  }
});

it("mainnet checks the server again after signing and on resume", async () => {
  const w=fixture();
  await assert.rejects(w.chain.pay({amountZats:10000n,recipient:ADDRESS,stage:()=>w.info({chain_name:"test"})}));
  assert.equal(w.calls.filter(c=>c.input?.startsWith("transmit")).length,0);
  await assert.rejects(w.chain.resumeSigned(TX,{fence:()=>{},timeoutMs:1000}));
  assert.equal(w.calls.filter(c=>c.input?.startsWith("transmit")).length,0);
});

it("mainnet requires affirmative chain and branch evidence", () => {
  for(const info of ['{}','{"chain_name":"main"}','{"consensus_branch_id":"12345678"}'])assert.ok(consensusProblem(info,"mainnet",BRANCH));
  assert.equal(consensusProblem('{"chain_name":"main","consensus_branch_id":"12345678"}',"mainnet",BRANCH),undefined);
  assert.throws(()=>parseUfvk('{"ufvk":"uviewtest1qqqq"}',"mainnet"));
  assert.throws(()=>parseUfvk('{"ufvk":"uview1qqqq"}',"testnet"));
});

it("wallet binding blocks network switches, deleted markers and legacy adoption", async () => {
  const w=fixture();
  assert.throws(()=>bindWalletNetwork(w.wallet,"testnet"),/binding/);
  fs.unlinkSync(join(w.wallet,".zshield-network"));
  await assert.rejects(w.chain.getViewingKey(),/binding/);
  const legacy=join(w.wallet,".zshield-state","calls");
  fs.mkdirSync(legacy,{recursive:true,mode:0o700});fs.writeFileSync(join(legacy,"old"),"historical");
  assert.throws(()=>bindWalletNetwork(w.wallet,"mainnet"),/historical/);
});
