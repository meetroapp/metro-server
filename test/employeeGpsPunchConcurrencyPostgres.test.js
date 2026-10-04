"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto'),{Client,Pool}=require('pg');
const fns=require('./helpers/punchVerificationFixture'),time=require('../server/team/timeEvidenceService');const {assertSafeTestDatabaseUrl}=require('./helpers/databaseTargetSafety');
const url=process.env.PUNCH_VERIFICATION_DATABASE_URL;
test('Concurrent GPS boundaries preserve one timer and exactly one consumed proof per command',{skip:!url},async()=>{
 assertSafeTestDatabaseUrl(url,{nodeEnv:process.env.NODE_ENV});const setup=new Client({connectionString:url}),live=new Pool({connectionString:url,max:4});await setup.connect();
 try{await setup.query('BEGIN');await setup.query('SET CONSTRAINTS ALL DEFERRED');const x=await fns.setup(setup);await setup.query('SET CONSTRAINTS ALL IMMEDIATE');await setup.query('COMMIT');
 const payload=()=>({pool:live,authenticatedActor:x.f.employee,businessId:x.f.profile,category:'JOB_WORK',jobId:x.f.native,assignmentId:x.assigned.get(x.f.native).id,assignmentActivationVersion:1,location:{status:'CAPTURED',latitude:26.64,longitude:-81.98,accuracyMeters:8,sampledAt:new Date().toISOString()},idempotencyKey:randomUUID()});
 const requests=[payload(),payload()];const results=await Promise.all(requests.map(time.clockIn));assert.equal(results.filter(r=>r.ok).length,1);assert.equal(results.find(r=>!r.ok).code,'TIME_TIMER_ALREADY_ACTIVE');
 const winner=requests[results.findIndex(r=>r.ok)];const accepted=results.find(r=>r.ok);const replay=await Promise.all([time.clockIn(winner),time.clockIn(winner)]);assert.ok(replay.every(r=>r.ok&&r.replayed&&r.session.id===accepted.session.id));
 const out={...payload(),sessionId:accepted.session.id};const outs=await Promise.all([time.clockOut(out),time.clockOut(out)]);assert.ok(outs.every(r=>r.ok));assert.equal(outs.filter(r=>r.replayed).length,1);
 const counts=(await live.query(`SELECT (SELECT count(*)::int FROM business_time_sessions WHERE membership_id=$1) sessions,(SELECT count(*)::int FROM business_time_events WHERE membership_id=$1) events,(SELECT count(*)::int FROM business_punch_location_snapshots WHERE membership_id=$1 AND verification_result='VERIFIED_INSIDE') proofs`,[x.f.employee.membership])).rows[0];assert.deepEqual(counts,{sessions:1,events:2,proofs:2});
 }finally{await setup.query('ROLLBACK');await setup.end();await live.end();}
});
