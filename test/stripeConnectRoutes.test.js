"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),express=require("express"),fs=require("node:fs"),path=require("node:path");
const { randomUUID }=require("node:crypto");
const { fixture }=require("./stripeConnectLiveProvider.test");
const { registerStripeConnectWebhooks,registerStripeConnectOwnerRoutes }=require("../server/integrations/stripeConnectRoutes");
const { registerConnectedServicesRoutes }=require("../server/integrations/connectedServices");
async function appFixture(t,{role="OWNER",disabled=false,invalidSignature=false,processing={ok:true},realWebhook=false}={}){
  const f=fixture(),app=express(),calls=[];
  const pool={async query(sql,params){calls.push({sql,params});return {rows:[{contractor_profile_id:10,role,business_name:"Fixture"}]};}};
  const auth=(req,res,next)=>{if(req.get("Authorization")!=="fixture"){res.status(401).json({success:false});return;}req.user={id:1};next();};
  const options={app,authMiddleware:auth,getPool:()=>pool,getRuntime:()=>disabled?{config:{enabled:false}}:f,
    onboardingService:{async onboard(opts){calls.push({onboard:opts});return {ok:true,status:200,code:"ONBOARDING_READY"};},async refresh(opts){calls.push({refresh:opts});return {ok:true,status:200,code:"ACCOUNT_RECONCILED"};}},
    webhookService:{async receive(opts){calls.push({webhook:opts});return invalidSignature?{ok:false,status:400,code:"SIGNATURE_OR_ENVELOPE_INVALID"}:{ok:true,status:200,code:"EVENT_DURABLE",processable:true,eventId:"evt_fixture"};},async processEvent(opts){calls.push({process:opts});return processing;}}};
  if(realWebhook){options.webhookService=require("../server/integrations/stripeConnectWebhookService");f.client.parseEventNotification=()=>{throw Error("synthetic signature failure");};}
  registerStripeConnectWebhooks(options);
  app.use(express.json({verify(req,res,b){if(req.originalUrl==="/subscriptions/stripe/webhook")req.rawBody=Buffer.from(b);}}));
  app.post("/subscriptions/stripe/webhook",(req,res)=>res.json({preserved:Buffer.isBuffer(req.rawBody)&&req.rawBody.equals(Buffer.from('{ "fixture": true }')),parsed:req.body.fixture===true}));
  registerStripeConnectOwnerRoutes(options);
  registerConnectedServicesRoutes({app,authMiddleware:auth,getPool:()=>pool,sendPublicDatabaseError:()=>{throw Error("unexpected database error");}});
  const server=app.listen(0,"127.0.0.1");await new Promise(r=>server.once("listening",r));t.after(()=>new Promise(r=>server.close(r)));
  async function request(route,body,authenticated=true){const response=await fetch(`http://127.0.0.1:${server.address().port}${route}`,{method:route==="/connected-services"?"GET":"POST",headers:{"Content-Type":"application/json",...(authenticated?{Authorization:"fixture"}:{}),"Idempotency-Key":randomUUID(),"Stripe-Signature":"fixture"},...(body!==undefined?{body:typeof body==="string"?body:JSON.stringify(body)}:{})});return {status:response.status,body:await response.json()};}
  return {...f,app,pool,calls,request,baseUrl:`http://127.0.0.1:${server.address().port}`};
}
test("Owner onboarding/refresh allowed; Manager and anonymous denied before service dispatch",async t=>{
  for(const role of ["OWNER","MANAGER"]){const h=await appFixture(t,{role});for(const [route,body]of[["onboarding",{intent:"CONNECT",country:"us"}],["refresh",{}]]){const r=await h.request("/connected-services/stripe/"+route,body);assert.equal(r.status,role==="OWNER"?200:403);}
    if(role==="MANAGER")assert.equal(h.calls.filter(x=>x.onboard||x.refresh).length,0);
    assert.equal((await h.request("/connected-services/stripe/onboarding",{intent:"CONNECT"},false)).status,401);
  }
});
test("body/query cannot select Business/provider/account/callback/format/CONNECTED; return route absent",async t=>{
  const h=await appFixture(t);for(const bad of [{intent:"CONNECT",businessId:20},{intent:"CONNECT",accountId:"cus_fixture"},{intent:"CONNECT",success:true},{intent:"CONNECT",returnUrl:"https://untrusted.invalid"},{intent:"CONNECT",provider:"fake"}])assert.equal((await h.request("/connected-services/stripe/onboarding",bad)).status,400);
  assert.equal((await h.request("/connected-services/stripe/refresh",{intent:"REFRESH"})).status,400);
  assert.equal((await h.request("/connected-services/stripe/onboarding?format=THIN",{intent:"CONNECT"})).status,400);
  assert.equal((await fetch(h.baseUrl+"/connected-services/stripe/return")).status,404);
  assert.equal(h.calls.filter(x=>x.onboard||x.refresh).length,0);
});
test("thin and snapshot routes bypass user auth and retain exact unparsed bytes and server format",async t=>{
  const h=await appFixture(t),raw='{  "fixture": true }';
  for(const format of ["thin","snapshot"]){assert.equal((await h.request("/connected-services/stripe/webhooks/"+format,raw,false)).status,200);const last=h.calls.filter(x=>x.webhook).at(-1).webhook;assert.ok(Buffer.isBuffer(last.rawBody));assert.ok(last.rawBody.equals(Buffer.from(raw)));assert.equal(last.format,format.toUpperCase());}
  assert.equal(h.calls.filter(x=>x.sql).length,0);
  assert.equal(h.calls.filter(x=>x.process).length,2);
});
test("invalid signature and retryable processing reject; disabled config never dispatches provider",async t=>{
  const bad=await appFixture(t,{invalidSignature:true});assert.equal((await bad.request("/connected-services/stripe/webhooks/thin",{},false)).status,400);assert.equal(bad.calls.filter(x=>x.process).length,0);
  const retry=await appFixture(t,{processing:{ok:false,code:"EVENT_NOT_CLAIMABLE"}});assert.equal((await retry.request("/connected-services/stripe/webhooks/thin",{},false)).status,503);
  const disabled=await appFixture(t,{disabled:true});assert.equal((await disabled.request("/connected-services/stripe/onboarding",{intent:"CONNECT"})).status,503);assert.equal((await disabled.request("/connected-services/stripe/webhooks/snapshot",{},false)).status,503);assert.equal(disabled.calls.filter(x=>x.onboard||x.webhook).length,0);
});
test("subscription raw-body parsing and Owner/Manager GET read authority remain unchanged",async t=>{
  for(const role of ["OWNER","MANAGER"]){const h=await appFixture(t,{role});assert.deepEqual((await h.request("/subscriptions/stripe/webhook",'{ "fixture": true }',false)).body,{preserved:true,parsed:true});const r=await h.request("/connected-services");assert.equal(r.status,200);assert.ok(r.body.providers.every(p=>p.status==="COMING_SOON"));}
});
test("bootstrap registers Connect raw ingress before JSON; existing subscription verifier line preserved; no route collisions",()=>{
  const root=path.join(__dirname,".."),index=fs.readFileSync(path.join(root,"index.js"),"utf8");assert.ok(index.indexOf("registerStripeConnectWebhooks({")<index.indexOf("app.use(express.json({"));assert.match(index,/if \(req.originalUrl === "\/subscriptions\/stripe\/webhook"\) req.rawBody = Buffer.from\(buffer\);/);
  const source=fs.readFileSync(path.join(root,"server/integrations/stripeConnectRoutes.js"),"utf8");for(const suffix of ["onboarding","refresh","webhooks/thin","webhooks/snapshot"])assert.equal((source.match(new RegExp('app\\.post\\("/connected-services/stripe/'+suffix+'"',"g"))||[]).length,1);
});

test("actual webhook service rejects invalid SDK signature before canonical persistence",async t=>{
  const h=await appFixture(t,{realWebhook:true});const r=await h.request("/connected-services/stripe/webhooks/thin",'{ "id": "evt_fixture" }',false);
  assert.equal(r.status,400);assert.equal(r.body.code,"SIGNATURE_OR_ENVELOPE_INVALID");assert.equal(h.calls.length,0);
});
