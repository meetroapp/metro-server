"use strict";
const assert=require('node:assert/strict');const test=require('node:test');
const {normalizeSnapshot,normalizeAddress}=require('../server/team/punchLocationService');
const {createPunchLocationHandlers,registerPunchLocationRoutes}=require('../server/team/punchLocations');
const captured={status:'CAPTURED',latitude:0,longitude:0,accuracyMeters:12,sampledAt:'2026-09-30T13:00:00.000Z'};
test('strict future snapshot boundary distinguishes missing, malformed, range, accuracy and sample-time errors',()=>{
 const cases=[[{latitude:null},'PUNCH_COORDINATES_MISSING'],[{longitude:undefined},'PUNCH_COORDINATES_MISSING'],[{latitude:''},'PUNCH_COORDINATES_MALFORMED'],[{longitude:false},'PUNCH_COORDINATES_MALFORMED'],[{latitude:'0'},'PUNCH_COORDINATES_MALFORMED'],[{latitude:NaN},'PUNCH_COORDINATES_MALFORMED'],[{latitude:Infinity},'PUNCH_COORDINATES_MALFORMED'],[{latitude:90.01},'PUNCH_COORDINATES_OUT_OF_RANGE'],[{longitude:-180.01},'PUNCH_COORDINATES_OUT_OF_RANGE'],[{accuracyMeters:0},'PUNCH_ACCURACY_INVALID'],[{sampledAt:'2026-02-30T13:00:00.000Z'},'PUNCH_SAMPLE_TIME_INVALID'],[{sampledAt:'2026-09-30'},'PUNCH_SAMPLE_TIME_INVALID'],[{isInsideGeofence:true},'PUNCH_POSITION_MALFORMED']];
 for(const [changes,code]of cases)assert.equal(normalizeSnapshot({...captured,...changes}).code,code);
 assert.equal(normalizeSnapshot(captured).latitude,0);assert.equal(normalizeSnapshot({...captured,sampledAt:'2026-09-30T13:00:00Z'}).sampledAt,captured.sampledAt);
 for(const status of ['MISSING','DENIED','UNAVAILABLE'])assert.deepEqual(normalizeSnapshot({status}),{status,latitude:null,longitude:null,accuracyMeters:null,sampledAt:null});
 assert.equal(normalizeSnapshot({status:'DENIED',latitude:0}).ok,false);
});
test('manual authority requires structured address fields and rejects hidden extra content',()=>{
 const address={line1:'123 Shop',city:'Miami',region:'FL',postalCode:'33101',countryCode:'US'};
 assert.deepEqual(normalizeAddress(address),address);
 for(const value of [null,'free text',{...address,line1:''},{...address,countryCode:'us'},{...address,privateNote:'secret'}])assert.equal(normalizeAddress(value),null);
});
function response(){return {headers:{},setHeader(k,v){this.headers[k]=v;},status(n){this.statusCode=n;return this;},json(x){this.body=x;return this;}};}
test('authenticated routes reject forged employee/geometry/verification inputs before service access',async()=>{
 let called=0;let received;
 const h=createPunchLocationHandlers({getPool:()=>({test:true}),sendPublicDatabaseError:()=>assert.fail('Unexpected error'),service:{async recordSnapshot(input){called++;received=input;return {ok:true,status:200,punchAccepted:false};}}});
 for(const key of ['authenticatedActor','userId','membershipId','targetLatitude','radiusMeters','verificationResult','isInsideGeofence','receivedAt']){
  const res=response();await h.snapshot({user:{id:7},params:{assignmentId:'exact'},body:{businessId:1,[key]:true}},res);assert.equal(res.statusCode,400);assert.equal(called,0);
 }
 const res=response();await h.snapshot({user:{id:7},params:{assignmentId:'exact'},body:{businessId:1,snapshot:captured,boundary:'CLOCK_IN'}},res);
 assert.equal(received.authenticatedActor.id,7);assert.equal(received.assignmentId,'exact');assert.equal(res.body.punchAccepted,false);assert.equal(res.headers['Cache-Control'],'private, no-store');
});
test('every new route requires the shared authentication middleware and has no timer/override endpoint',()=>{
 const routes=[];const auth=()=>{};const app=Object.fromEntries(['get','post','put'].map(method=>[method,(path,middleware,handler)=>routes.push({method,path,middleware,handler})]));
 registerPunchLocationRoutes({app,authMiddleware:auth,getPool:()=>({}),sendPublicDatabaseError:()=>{}});
 assert.equal(routes.length,7);assert.ok(routes.every(r=>r.middleware===auth));assert.ok(routes.every(r=>!/(clock-in$|clock-out$|override|track|offline)/.test(r.path)));
 assert.ok(routes.some(r=>r.path==='/employee/punch-location-snapshots'));assert.ok(routes.some(r=>r.path==='/team/punch-location-policies'));
});
