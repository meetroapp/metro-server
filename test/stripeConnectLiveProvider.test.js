"use strict";
const test=require("node:test"), assert=require("node:assert/strict");
const { randomUUID }=require("node:crypto");
const { fixtureEnv }=require("./stripeConnectConfig.test");
const { readConnectConfig }=require("../server/integrations/stripeConnectConfig");
const { createLiveProvider,isLiveProvider }=require("../server/integrations/stripeConnectLiveProvider");
const { API_VERSION,INCLUDE,assertProvider }=require("../server/integrations/stripeConnectProvider");
const { account }=require("./stripeConnectPersistence.test");
function fixture() {
  const env=fixtureEnv(),config=readConnectConfig(env),calls=[];
  const client={v2:{core:{accounts:{
    async create(params,options){calls.push({method:"create",params,options});return account({metadata:params.metadata});},
    async retrieve(id,params,options){calls.push({method:"retrieve",id,params,options});return account({id});},
  },accountLinks:{async create(params,options){calls.push({method:"link",params,options});return {object:"v2.core.account_link",account:params.account,livemode:false,url:"https://connect.stripe.com/setup/fixture",expires_at:new Date(Date.now()+300000).toISOString()};}}}},
  parseEventNotification(...args){calls.push({method:"thin",args});return JSON.parse(args[0]);},
  webhooks:{constructEvent(...args){calls.push({method:"snapshot",args});return JSON.parse(args[0]);}}};
  return {env,config,client,calls,provider:createLiveProvider({config,stripeClient:client})};
}
module.exports={fixture};
if(require.main===module){
  test("injected live provider uses exact frozen Accounts v2 requests without network",async()=>{
    const f=fixture(),key=randomUUID(),intent={country:"us",currency:"usd",operationId:randomUUID(),connectionId:randomUUID()};
    await f.provider.createAccount(intent,key);
    assert.deepEqual(f.calls[0],{method:"create",params:{dashboard:"full",identity:{country:"us"},configuration:{merchant:{capabilities:{card_payments:{requested:true}}}},defaults:{currency:"usd",responsibilities:{fees_collector:"stripe",losses_collector:"stripe"}},metadata:{meetro_operation:intent.operationId,meetro_connection:intent.connectionId},include:[...INCLUDE]},options:{apiVersion:API_VERSION,idempotencyKey:key}});
    await f.provider.retrieveAccount("acct_fixture");assert.deepEqual(f.calls[1],{method:"retrieve",id:"acct_fixture",params:{include:[...INCLUDE]},options:{apiVersion:API_VERSION}});
    assert.ok(isLiveProvider(f.provider));assertProvider(f.provider,f.config,f.config);
    assert.throws(()=>assertProvider({...f.provider},f.config,f.config),/PROVIDER_REQUIRED/);
  });
  test("Account Link request stays merchant-only and uses server callbacks",async()=>{
    const f=fixture(),key=randomUUID();await f.provider.createOnboardingLink("acct_fixture",f.config.callbacks,key);
    assert.deepEqual(f.calls[0].params,{account:"acct_fixture",use_case:{type:"account_onboarding",account_onboarding:{configurations:["merchant"],collection_options:{fields:"eventually_due"},return_url:f.config.callbacks.returnUrl,refresh_url:f.config.callbacks.refreshUrl}}});
    assert.deepEqual(f.calls[0].options,{apiVersion:API_VERSION,idempotencyKey:key});
    await assert.rejects(f.provider.createOnboardingLink("acct_fixture",{...f.config.callbacks,returnUrl:"https://untrusted.invalid/return"}),/PROVIDER_UNAVAILABLE/);
    assert.equal(f.calls.length,1);
  });
  test("separate thin/snapshot SDK verifiers receive original bytes, dedicated secrets and tolerance",async()=>{
    const f=fixture(),raw=Buffer.from('{ "id": "evt_fixture" }');
    await f.provider.verifyEvent(raw,"synthetic-signature","THIN");await f.provider.verifyEvent(raw,"synthetic-signature","SNAPSHOT");
    for(const [i,key] of [[0,"STRIPE_CONNECT_THIN_WEBHOOK_SECRET"],[1,"STRIPE_CONNECT_SNAPSHOT_WEBHOOK_SECRET"]]){
      assert.ok(f.calls[i].args[0]===raw);assert.ok(f.calls[i].args[2]===f.env[key]);assert.equal(f.calls[i].args[3],300);
    }
    assert.equal(f.calls[0].method,"thin");assert.equal(f.calls[1].method,"snapshot");
    await assert.rejects(f.provider.verifyEvent({},"signature","THIN"),/PROVIDER_UNAVAILABLE/);
  });
  test("SDK verifies local signed thin/snapshot events, tampering/replay/format mixing rejected without API calls",async()=>{
    const Stripe=require("stripe"),f=fixture();
    const client=new Stripe(f.env.STRIPE_CONNECT_SECRET_KEY,{apiVersion:API_VERSION,maxNetworkRetries:0});
    const p=createLiveProvider({config:f.config,stripeClient:client});
    for(const [format,obj,key] of [["THIN",{object:"v2.core.event",id:"evt_local",type:"v2.core.account.updated",livemode:false,related_object:{id:"acct_fixture",type:"v2.core.account",url:"/v2/core/accounts/acct_fixture"}},"STRIPE_CONNECT_THIN_WEBHOOK_SECRET"],["SNAPSHOT",{object:"event",id:"evt_local",type:"account.updated",account:"acct_fixture",livemode:false,api_version:API_VERSION,data:{object:{id:"acct_fixture"}}},"STRIPE_CONNECT_SNAPSHOT_WEBHOOK_SECRET"]]){
      const raw=Buffer.from(JSON.stringify(obj)),signature=client.webhooks.generateTestHeaderString({payload:raw.toString(),secret:f.env[key]});
      assert.equal((await p.verifyEvent(raw,signature,format)).id,"evt_local");
      await assert.rejects(p.verifyEvent(Buffer.concat([raw,Buffer.from(" ")]),signature,format),/PROVIDER_UNAVAILABLE/);
      await assert.rejects(p.verifyEvent(raw,signature,format==="THIN"?"SNAPSHOT":"THIN"),/PROVIDER_UNAVAILABLE/);
      const old=client.webhooks.generateTestHeaderString({payload:raw.toString(),secret:f.env[key],timestamp:Math.floor(Date.now()/1000)-600});
      await assert.rejects(p.verifyEvent(raw,old,format),/PROVIDER_UNAVAILABLE/);
    }
  });
  test("provider errors never propagate SDK credentials/payloads/links; wrong account/mode fails closed",async()=>{
    const f=fixture();f.client.v2.core.accounts.retrieve=async()=>{throw Error(f.env.STRIPE_CONNECT_SECRET_KEY);};
    try{await f.provider.retrieveAccount("acct_fixture");assert.fail("must reject");}catch(e){assert.equal(e.message,"STRIPE_CONNECT_PROVIDER_UNAVAILABLE");assert.ok(!JSON.stringify(e).includes(f.env.STRIPE_CONNECT_SECRET_KEY));}
    f.client.v2.core.accounts.retrieve=async()=>account({id:"acct_other"});await assert.rejects(f.provider.retrieveAccount("acct_fixture"),/PROVIDER_UNAVAILABLE/);
    f.client.v2.core.accounts.retrieve=async()=>({...account(),livemode:true});await assert.rejects(f.provider.retrieveAccount("acct_fixture"),/PROVIDER_UNAVAILABLE/);
    assert.throws(()=>createLiveProvider({config:{enabled:true},stripeClient:f.client}),/CONFIGURATION_INVALID/);
    assert.throws(()=>createLiveProvider({config:readConnectConfig({}),stripeClient:f.client}),/CONFIGURATION_INVALID/);
  });
  test("locked SDK construction is local and constructor failures cannot leak configuration",()=>{
    const f=fixture(),Stripe=require("stripe");
    assert.ok(isLiveProvider(createLiveProvider({config:f.config})));
    class Bad {constructor(key){throw Error(key);}}
    Bad.PACKAGE_VERSION="22.6.0";Bad.API_VERSION=API_VERSION;
    try{createLiveProvider({config:f.config,Stripe:Bad});assert.fail("must reject");}catch(e){assert.equal(e.message,"STRIPE_CONNECT_PROVIDER_UNAVAILABLE");assert.ok(!e.message.includes(f.env.STRIPE_CONNECT_SECRET_KEY));}
    assert.throws(()=>createLiveProvider({config:f.config,Stripe:{PACKAGE_VERSION:"wrong",API_VERSION}}),/SDK_CONTRACT_INVALID/);
  });
  test("malformed durable IDs and keys fail before any SDK mutation",async()=>{
    const f=fixture();await assert.rejects(f.provider.createAccount({country:"us",currency:"usd",operationId:"-".repeat(36),connectionId:randomUUID()},randomUUID()),/PROVIDER_UNAVAILABLE/);
    await assert.rejects(f.provider.createOnboardingLink("acct_fixture",f.config.callbacks,"invalid"),/PROVIDER_UNAVAILABLE/);assert.equal(f.calls.length,0);
  });

}
