"use strict";
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const test = require("node:test");
const { Pool } = require("pg");
const { assertSafeTestDatabaseUrl } = require("./helpers/databaseTargetSafety");
const { getMigrationFiles, runMigrationCollection } = require("../scripts/run-migrations");
const { createExternalLifecycleFixture, payExternalDeposit, assertNoExternalCustomerAuthority, quiet } = require("./helpers/externalLifecycleFixture");
const { activateApprovedWorkVisitAuthority, getApprovedWorkVisitAuthority } = require("../server/workflow/approvedWorkVisitService");
const { proposeVisit, getVisit, listVisits, startVisit, confirmVisit } = require("../server/workflow/visitService");
const { getProfessionalSchedule } = require("../server/workflow/professionalScheduleService");
const { evaluateApprovedWorkDepositGateWithClient } = require("../server/finance/preWorkDepositService");
const databaseUrl = process.env.EXTERNAL_SCHEDULING_DATABASE_URL;

test("external Approved Work scheduling uses exact common approval and deposit authority", {skip:!databaseUrl}, async t => {
  const database = assertSafeTestDatabaseUrl(databaseUrl,{nodeEnv:process.env.NODE_ENV});
  const pool = new Pool({connectionString:databaseUrl,max:4});
  t.after(()=>pool.end());
  const migrations=await runMigrationCollection(pool,getMigrationFiles(),{target:"local-test",database});
  assert.equal(migrations.success,true,JSON.stringify(migrations.failed));
  const replay=await runMigrationCollection(pool,getMigrationFiles(),{target:"local-test",database});
  assert.equal(replay.applied.length,0);
  assert.deepEqual(replay.failed,[]);
  for (const mode of ["EXTERNAL_CONTACT","DOCUMENT_ONLY"]) await t.test(mode,async()=>{
    const f=await createExternalLifecycleFixture(pool,mode);
    const base={pool,authenticatedActor:f.authenticatedActor,jobId:f.jobId,logger:quiet};
    const activation={...base,quoteId:f.quoteId,idempotencyKey:`activate-${f.suffix}`};
    const read={...base,quoteId:f.quoteId};
    const proposal={...base,purpose:"APPROVED_WORK",quoteApprovalId:f.quoteApprovalId,
      scheduledStartAt:new Date(Date.now()+86400000).toISOString(),
      scheduledEndAt:new Date(Date.now()+90000000).toISOString(),timeZone:"America/New_York",
      locationMode:"JOB_SERVICE_LOCATION",idempotencyKey:`propose-${f.suffix}`};
    assert.equal((await activateApprovedWorkVisitAuthority(activation)).code,"DEPOSIT_REQUIRED_BEFORE_SCHEDULING");
    assert.equal((await getApprovedWorkVisitAuthority(read)).authority.state,"LOCKED");
    let schedule=await getProfessionalSchedule({pool,authenticatedActor:f.authenticatedActor});
    assert.equal(schedule.ok,true,schedule.code);
    assert.equal(schedule.schedule.opportunities.find(row=>row.jobId===f.jobId).actions.canStartScheduling,false);
    const first=await payExternalDeposit(f,5000,1);
    assert.equal(first.result.deposit.state,"PARTIALLY_SATISFIED");
    assert.equal((await activateApprovedWorkVisitAuthority(activation)).code,"DEPOSIT_REQUIRED_BEFORE_SCHEDULING");
    assert.equal((await proposeVisit(proposal)).ok,false);
    const final=await payExternalDeposit(f,8500,2);
    assert.equal(final.result.deposit.state,"SATISFIED");
    const active=await activateApprovedWorkVisitAuthority(activation);
    assert.equal(active.ok,true,active.code);
    assert.equal(active.authority.quoteApprovalId,f.quoteApprovalId);
    assert.equal(active.authority.approvalSource,"EXTERNAL_EVIDENCE");
    assert.equal(active.authority.approvedQuoteDecisionId,null);
    assert.deepEqual(active.authority.customerCapabilities,[]);
    assert.deepEqual(active.authority.professionalCapabilities,["visit.read","visit.propose","visit.reschedule","visit.cancel","visit.external_confirmation.record"]);
    assert.equal((await activateApprovedWorkVisitAuthority(activation)).replayed,true);
    schedule=await getProfessionalSchedule({pool,authenticatedActor:f.authenticatedActor});
    const opportunity=schedule.schedule.opportunities.find(row=>row.jobId===f.jobId);
    assert.equal(opportunity.quoteApprovalId,f.quoteApprovalId);
    assert.equal(opportunity.actions.canStartScheduling,true);
    assert.equal((await proposeVisit({...proposal,quoteApprovalId:randomUUID()})).ok,false);
    assert.equal((await proposeVisit({...proposal,jobId:randomUUID()})).ok,false);
    assert.equal((await evaluateApprovedWorkDepositGateWithClient({client:pool,jobId:f.jobId,quoteApprovalId:randomUUID()})).allowed,false);
    assert.equal((await evaluateApprovedWorkDepositGateWithClient({client:pool,jobId:f.jobId})).allowed,false);
    const proposed=await proposeVisit(proposal);
    assert.equal(proposed.ok,true,proposed.code);
    assert.equal(proposed.visit.state,"PROPOSED");
    assert.equal(proposed.visit.quoteApprovalId,f.quoteApprovalId);
    assert.equal(proposed.visit.approvalSource,"EXTERNAL_EVIDENCE");
    assert.equal(proposed.visit.actions.canConfirm,false);
    assert.equal(proposed.visit.actions.canStart,false);
    assert.equal((await proposeVisit(proposal)).replayed,true);
    assert.equal((await proposeVisit({...proposal,reason:"Changed payload"})).ok,false);
    const detail=await getVisit({...base,visitId:proposed.visit.id});
    assert.equal(detail.ok,true,detail.code);
    assert.equal((await listVisits(base)).visits.length,1);
    const command={...base,visitId:proposed.visit.id,expectedVersion:1,idempotencyKey:`ordinary-confirm-${f.suffix}`};
    assert.equal((await confirmVisit(command)).ok,false);
    assert.equal((await startVisit({...command,idempotencyKey:`early-start-${f.suffix}`})).ok,false);
    schedule=await getProfessionalSchedule({pool,authenticatedActor:f.authenticatedActor});
    assert.equal(schedule.schedule.visits.find(row=>row.id===proposed.visit.id).quoteApprovalId,f.quoteApprovalId);
    assert.equal(schedule.schedule.summary.waitingOnCustomer,1);
    const counts=(await pool.query(`SELECT
      (SELECT count(*)::int FROM canonical_approved_work_visit_authority_activations WHERE job_id=$1) activations,
      (SELECT count(*)::int FROM lifecycle_authority_grants WHERE job_id=$1 AND scope_type='approved_work') grants,
      (SELECT count(*)::int FROM canonical_visits WHERE job_id=$1) visits,
      (SELECT count(*)::int FROM canonical_visit_versions WHERE job_id=$1) versions,
      (SELECT count(*)::int FROM canonical_visit_events WHERE job_id=$1) events`,[f.jobId])).rows[0];
    assert.deepEqual(counts,{activations:1,grants:5,visits:1,versions:1,events:1});
    await assertNoExternalCustomerAuthority(f);
  });
});
