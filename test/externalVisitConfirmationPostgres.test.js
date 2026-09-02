"use strict";
const assert=require("node:assert/strict");
const {randomUUID}=require("node:crypto");
const test=require("node:test");
const {Pool}=require("pg");
const {assertSafeTestDatabaseUrl}=require("./helpers/databaseTargetSafety");
const {getMigrationFiles,runMigrationCollection}=require("../scripts/run-migrations");
const {createExternalLifecycleFixture,payExternalDeposit,assertNoExternalCustomerAuthority,quiet}=require("./helpers/externalLifecycleFixture");
const {activateApprovedWorkVisitAuthority}=require("../server/workflow/approvedWorkVisitService");
const {proposeVisit,confirmVisit,startVisit,getVisit,rescheduleVisit}=require("../server/workflow/visitService");
const {recordExternalVisitConfirmation}=require("../server/workflow/externalVisitConfirmationService");
const {reverseDepositAllocation}=require("../server/finance/preWorkDepositService");
const databaseUrl=process.env.EXTERNAL_CONFIRMATION_DATABASE_URL;

test("external schedule confirmation binds immutable proposal evidence without customer authority",{skip:!databaseUrl},async t=>{
 const database=assertSafeTestDatabaseUrl(databaseUrl,{nodeEnv:process.env.NODE_ENV});
 const pool=new Pool({connectionString:databaseUrl,max:4});t.after(()=>pool.end());
 const migrations=getMigrationFiles();
 assert.equal(migrations[79].filename,"202609020005_create_external_visit_schedule_confirmation.sql");
 const applied=await runMigrationCollection(pool,migrations,{target:"local-test",database});
 assert.equal(applied.success,true,JSON.stringify(applied.failed));
 const replay=await runMigrationCollection(pool,migrations,{target:"local-test",database});
 assert.equal(replay.applied.length,0);assert.deepEqual(replay.failed,[]);
 for (const mode of ["EXTERNAL_CONTACT","DOCUMENT_ONLY"]) await t.test(mode,async()=>{
  const f=await createExternalLifecycleFixture(pool,mode);
  const base={pool,authenticatedActor:f.authenticatedActor,jobId:f.jobId,logger:quiet};
  await payExternalDeposit(f,13500,1);
  assert.equal((await activateApprovedWorkVisitAuthority({...base,quoteId:f.quoteId,idempotencyKey:`activate-${f.suffix}`})).ok,true);
  const proposed=await proposeVisit({...base,quoteApprovalId:f.quoteApprovalId,purpose:"APPROVED_WORK",
    scheduledStartAt:new Date(Date.now()+86400000).toISOString(),scheduledEndAt:new Date(Date.now()+90000000).toISOString(),
    timeZone:"America/New_York",locationMode:"JOB_SERVICE_LOCATION",idempotencyKey:`propose-${f.suffix}`});
  assert.equal(proposed.ok,true,proposed.code);
  const visitId=proposed.visit.id;
  const version=(await pool.query(`SELECT * FROM canonical_visit_versions WHERE visit_id=$1 AND version=1`,[visitId])).rows[0];
  const command={...base,visitId,expectedVersion:1,quoteApprovalId:f.quoteApprovalId,
    expectedProposalIntegrityHash:version.integrity_hash,evidenceMethod:mode==="DOCUMENT_ONLY"?"EMAIL":"PHONE",
    confirmedAt:new Date().toISOString(),evidenceReference:"Customer confirmed the proposed appointment",
    evidenceNote:"Business recorded customer confirmation outside Meetro.",idempotencyKey:`external-confirm-${f.suffix}`};
  assert.equal((await confirmVisit({...base,visitId,expectedVersion:1,idempotencyKey:randomUUID()})).ok,false);
  assert.equal((await startVisit({...base,visitId,expectedVersion:1,idempotencyKey:randomUUID()})).ok,false);
  assert.equal((await recordExternalVisitConfirmation({...command,expectedVersion:2})).code,"STALE_VISIT_VERSION");
  assert.equal((await recordExternalVisitConfirmation({...command,quoteApprovalId:randomUUID()})).code,"EXTERNAL_VISIT_APPROVAL_MISMATCH");
  assert.equal((await recordExternalVisitConfirmation({...command,jobId:randomUUID()})).ok,false);
  assert.equal((await recordExternalVisitConfirmation({...command,expectedProposalIntegrityHash:"0".repeat(64)})).code,"EXTERNAL_VISIT_PROPOSAL_MISMATCH");
  assert.equal((await recordExternalVisitConfirmation({...command,confirmedAt:new Date(Date.now()+60000).toISOString()})).ok,false);
  assert.equal((await recordExternalVisitConfirmation({...command,evidenceNote:null,evidenceReference:null})).ok,false);
  const allocation=(await pool.query(`SELECT id FROM canonical_pre_work_payment_allocations WHERE job_id=$1`,[f.jobId])).rows[0];
  const reversed=await reverseDepositAllocation({...base,allocationId:allocation.id,amountMinor:100,
    expectedVersion:2,reasonCategory:"CORRECTION",reason:"Correct recorded amount",idempotencyKey:`reverse-${f.suffix}`});
  assert.equal(reversed.ok,true,reversed.code);
  assert.equal((await recordExternalVisitConfirmation(command)).code,"DEPOSIT_REQUIRED_BEFORE_SCHEDULING");
  await payExternalDeposit(f,100,3);
  await assert.rejects(recordExternalVisitConfirmation({...command,failureInjector:()=>{throw new Error("rollback probe");}}),/rollback probe/);
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM canonical_visit_external_confirmation_evidence WHERE visit_id=$1`,[visitId])).rows[0].count,0);
  const confirmed=await recordExternalVisitConfirmation(command);
  assert.equal(confirmed.ok,true,confirmed.code);
  assert.equal(confirmed.visit.state,"SCHEDULED");
  assert.equal(confirmed.visit.currentVersion,2);
  assert.equal(confirmed.visit.externalScheduleConfirmation.source,"BUSINESS_RECORDED_EXTERNAL_EVIDENCE");
  assert.equal(confirmed.visit.externalScheduleConfirmation.proposedIntegrityHash,version.integrity_hash);
  assert.equal(confirmed.visit.actions.canStart,false);
  assert.equal((await recordExternalVisitConfirmation(command)).replayed,true);
  assert.equal((await recordExternalVisitConfirmation({...command,evidenceNote:"Changed"})).ok,false);
  assert.equal((await recordExternalVisitConfirmation({...command,expectedVersion:2,idempotencyKey:randomUUID()})).code,"EXTERNAL_VISIT_CONFIRMATION_FINAL");
  assert.equal((await startVisit({...base,visitId,expectedVersion:2,idempotencyKey:randomUUID()})).ok,false);
  const detail=await getVisit({...base,visitId});
  assert.equal(detail.visit.externalScheduleConfirmation.id,confirmed.visit.externalScheduleConfirmation.id);
  const evidence=(await pool.query(`SELECT * FROM canonical_visit_external_confirmation_evidence WHERE visit_id=$1`,[visitId])).rows;
  assert.equal(evidence.length,1);assert.equal(evidence[0].quote_approval_id,f.quoteApprovalId);
  assert.equal(evidence[0].scheduled_start_at.toISOString(),version.scheduled_start_at.toISOString());
  assert.equal(evidence[0].scheduled_end_at.toISOString(),version.scheduled_end_at.toISOString());
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM canonical_visit_versions WHERE visit_id=$1`,[visitId])).rows[0].count,2);
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM canonical_visit_events WHERE visit_id=$1`,[visitId])).rows[0].count,2);
  await assert.rejects(pool.query(`UPDATE canonical_visit_external_confirmation_evidence SET evidence_method='OTHER' WHERE visit_id=$1`,[visitId]),/append-only|immutable/i);
  const rescheduled=await rescheduleVisit({...base,visitId,expectedVersion:2,
    scheduledStartAt:new Date(Date.now()+172800000).toISOString(),scheduledEndAt:null,timeZone:"America/New_York",
    locationMode:"JOB_SERVICE_LOCATION",reason:"Customer requested another day",idempotencyKey:randomUUID()});
  assert.equal(rescheduled.ok,true,rescheduled.code);
  assert.equal(rescheduled.visit.externalScheduleConfirmation,null);
  assert.equal((await recordExternalVisitConfirmation({...command,idempotencyKey:randomUUID()})).code,"STALE_VISIT_VERSION");
  await assertNoExternalCustomerAuthority(f);
 });
});
