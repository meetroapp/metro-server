"use strict";
const test=require('node:test'),assert=require('node:assert/strict');const {createTimeEvidenceHandlers}=require('../server/team/timeEvidence');
function response(){return {headers:{},setHeader(k,v){this.headers[k]=v;},status(n){this.statusCode=n;return this;},json(v){this.body=v;return this;}};}
test('Existing time routes reject forged distance, algorithm, command, actor, and internal transaction fields',async()=>{
 let calls=0;const handlers=createTimeEvidenceHandlers({getPool:()=>({}),sendPublicDatabaseError:()=>assert.fail('Unexpected handler failure'),service:{clockIn:async()=>{calls++;return {ok:true,status:200};},clockOut:async()=>{calls++;return {ok:true,status:200};}}});
 for(const key of ['timeCommandId','time_command_id','distanceMeters','verificationAlgorithm','verificationResult','membershipId','userId','authenticatedActor','_transactionClient'])for(const name of ['clockIn','clockOut']){const res=response();await handlers[name]({user:{id:42},body:{businessId:7,[key]:'forged'}},res);assert.equal(res.statusCode,400);assert.equal(res.headers['Cache-Control'],'private, no-store');}
 assert.equal(calls,0);
});
test('Route forwards bounded GPS/assignment/site evidence and always uses authenticated req.user',async()=>{
 const actor={id:42};let received;const payload={businessId:7,jobId:'job',assignmentId:'assignment',assignmentActivationVersion:3,location:{status:'CAPTURED',latitude:0,longitude:0,accuracyMeters:8,sampledAt:'2026-09-30T12:00:00.000Z'},siteId:'site',siteVersion:2,associationVersion:4,idempotencyKey:'key'};
 const handlers=createTimeEvidenceHandlers({getPool:()=>({}),sendPublicDatabaseError:()=>assert.fail(),service:{clockIn:async x=>{received=x;return {ok:true,status:201};}}});const res=response();await handlers.clockIn({user:actor,body:payload},res);assert.equal(received.authenticatedActor,actor);for(const [k,v]of Object.entries(payload))assert.deepEqual(received[k],v);assert.equal(res.statusCode,201);
});
