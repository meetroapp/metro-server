"use strict";
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const {createHash,randomUUID}=require('node:crypto');const {Client}=require('pg');
const {assertSafeTestDatabaseUrl}=require('./helpers/databaseTargetSafety');const fns=require('./helpers/punchVerificationFixture');
const url=process.env.PUNCH_VERIFICATION_DATABASE_URL;const legacy=process.env.PUNCH_VERIFICATION_LEGACY_DATABASE_URL;
const dir=path.join(__dirname,'../migrations');const sql=fs.readFileSync(path.join(dir,'202609300003_extend_canonical_punch_verification_authority.sql'),'utf8');
test('Frozen A0/A migration hashes remain unchanged',()=>{
 for(const [name,sha] of [['202609300001_generalize_employee_assignment_source_authority.sql','6c5d21ce365e163f06b8f92575d5c31219730a26f4da00a76b2f8d4eca2843bd'],['202609300002_create_canonical_punch_location_authority.sql','3d37e3b48a6650be48f3e7ec8cf8d782a013d36dde47fc54a31ee985e6f3ae27']])assert.equal(createHash('sha256').update(fs.readFileSync(path.join(dir,name))).digest('hex'),sha);
});
test('Reviewed canonical verification schema executes with immutable consumed evidence',{skip:!url},async t=>{
 assertSafeTestDatabaseUrl(url,{nodeEnv:process.env.NODE_ENV});const client=new Client({connectionString:url});await client.connect();
 try{await client.query('BEGIN');await client.query('SET CONSTRAINTS ALL DEFERRED');const x=await fns.setup(client);
  await t.test('110 migrations recorded from empty database',async()=>assert.equal((await client.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n,110));
  let cmd,row;
  await t.test('valid insertion binds exact command and derives HAVERSINE_V1/result/distance',async()=>{cmd=await fns.timeCommand(x);row=await fns.snapshot(x,cmd);assert.equal(row.verification_result,'VERIFIED_INSIDE');assert.equal(row.verification_algorithm,'HAVERSINE_V1');assert.equal(row.distance_meters,0);assert.equal(row.time_command_id,cmd);await fns.consume(x,cmd);await fns.flush(client);});
  for(const [field,value] of Object.entries({verification_result:'NOT_PERFORMED',distance_meters:1,verification_algorithm:'CLIENT',time_command_id:randomUUID(),site_id:randomUUID(),site_version:2,device_latitude:0,device_longitude:0,accuracy_meters:9,sampled_at:new Date(0),assignment_id:randomUUID(),assignment_activation_version:2}))await t.test(field+' cannot be replaced in final evidence',()=>fns.rejectsSql(client,()=>client.query(`UPDATE business_punch_location_snapshots SET ${field}=$2 WHERE id=$1`,[row.id,value]),/immutable/));
  await t.test('final evidence cannot be deleted',()=>fns.rejectsSql(client,()=>client.query('DELETE FROM business_punch_location_snapshots WHERE id=$1',[row.id]),/immutable/));
  await t.test('missing time binding cannot produce final VERIFIED evidence',async()=>{const r=await fns.snapshot(x,null);assert.equal(r.verification_result,'NOT_PERFORMED');assert.equal(r.distance_meters,null);assert.equal(r.verification_algorithm,null);await fns.flush(client);});
  await t.test('forged absent command is rejected',()=>fns.rejectsSql(client,()=>fns.snapshot(x,randomUUID()),/exact unfinished time command/));
  await t.test('another employee command is rejected',()=>fns.rejectsSql(client,async()=>fns.snapshot(x,await fns.timeCommand(x,x.f.otherEmployee)),/exact unfinished time command/));
  await t.test('wrong boundary command is rejected',()=>fns.rejectsSql(client,async()=>fns.snapshot(x,await fns.timeCommand(x,x.f.employee,'CLOCK_OUT')),/exact unfinished time command/));
  await t.test('completed/replayed command is rejected',()=>fns.rejectsSql(client,()=>fns.snapshot(x,cmd),/exact unfinished time command/));
  await t.test('free-floating verified evidence cannot commit',()=>fns.rejectsSql(client,async()=>{await fns.snapshot(x,await fns.timeCommand(x));await fns.flush(client);},/consumed by exact completed time boundary/));
  await t.test('different JOB_WORK assignment boundary cannot consume verification',()=>fns.rejectsSql(client,async()=>{
   // Close the prior timer with its existing governed command before testing another boundary.
   const c=await fns.timeCommand(x,x.f.employee,'CLOCK_OUT');await client.query("UPDATE business_time_sessions SET clock_out_command_id=$1,clock_out_source='MEETRO_CLIENT',clock_out_location_status='NOT_REQUESTED',clocked_out_at=CURRENT_TIMESTAMP WHERE clocked_out_at IS NULL AND membership_id=$2",[c,x.f.employee.membership]);
   const other=await fns.timeCommand(x);await fns.snapshot(x,other);await fns.consume(x,other,x.f.ordinary);await fns.flush(client);
  },/consumed by exact completed time boundary/));
  await t.test('cross-tenant command is rejected',()=>fns.rejectsSql(client,async()=>{const y=await fns.setup(client);await fns.snapshot(x,await fns.timeCommand(y));},/exact unfinished time command/));
  for(const [name,change] of [['outside',{device_latitude:27}],['stale',{sampled_at:new Date(Date.now()-300000)}],['inaccurate',{accuracy_meters:100}],['future',{sampled_at:new Date(Date.now()+300000)}]])await t.test(name+' evidence is rejected before consumption',()=>fns.rejectsSql(client,async()=>fns.snapshot(x,await fns.timeCommand(x),change),/outside authorized proximity|fresh accurate captured evidence/));
 }finally{await client.query('ROLLBACK');await client.end();}
});
test('Rows actually created under A survive the reviewed extension without fabricated evidence',{skip:!legacy},async()=>{
 assertSafeTestDatabaseUrl(legacy,{nodeEnv:process.env.NODE_ENV});const client=new Client({connectionString:legacy});await client.connect();
 try{await client.query('BEGIN');await client.query('SET CONSTRAINTS ALL DEFERRED');const x=await fns.setup(client);const location=require('../server/team/punchLocationService');
  const before=fns.success(await location.recordSnapshot({...x.input(x.f.employee),assignmentId:x.assigned.get(x.f.native).id,siteId:x.site.id,siteVersion:1,associationVersion:1,assignmentActivationVersion:1,boundary:'CLOCK_IN',snapshot:{status:'CAPTURED',latitude:26.64,longitude:-81.98,accuracyMeters:8,sampledAt:new Date().toISOString()}})).snapshot;
  const old=(await client.query('SELECT * FROM business_punch_location_snapshots WHERE id=$1',[before.id])).rows[0];
  assert.equal(Object.hasOwn(old,'time_command_id'),false);await client.query(sql);
  const after=(await client.query('SELECT * FROM business_punch_location_snapshots WHERE id=$1',[before.id])).rows[0];
  assert.equal(after.time_command_id,null);assert.equal(after.verification_algorithm,null);delete after.time_command_id;delete after.verification_algorithm;assert.deepEqual(after,old);
  await fns.flush(client);
 }finally{await client.query('ROLLBACK');await client.end();}
});
