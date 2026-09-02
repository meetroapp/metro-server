"use strict";
const assert=require("node:assert/strict");
const {randomUUID}=require("node:crypto");
const test=require("node:test");
const {Pool}=require("pg");
const {assertSafeTestDatabaseUrl}=require("./helpers/databaseTargetSafety");
const {getMigrationFiles,runMigrationCollection}=require("../scripts/run-migrations");
const {createExternalLifecycleFixture,payExternalDeposit,assertNoExternalCustomerAuthority,quiet}=require("./helpers/externalLifecycleFixture");
const {activateApprovedWorkVisitAuthority}=require("../server/workflow/approvedWorkVisitService");
const {proposeVisit,startVisit,completeVisit,getVisit,cancelVisit}=require("../server/workflow/visitService");
const {recordExternalVisitConfirmation}=require("../server/workflow/externalVisitConfirmationService");
const {materializeWorkPreparation,reviseWorkPreparation,recordPreparationEvent,recordMaterialPurchase,correctMaterialPurchase,attachEvidenceReference}=require("../server/workflow/workPreparationService");
const {materializeApprovedWorkExecution}=require("../server/workflow/approvedWorkExecutionService");
const {getCanonicalLiveJob}=require("../server/workflow/liveJobProjectionService");
const {reverseDepositAllocation}=require("../server/finance/preWorkDepositService");
const databaseUrl=process.env.EXTERNAL_EXECUTION_DATABASE_URL;

test("external common approval governs preparation, execution, Visit start and completion",{skip:!databaseUrl},async t=>{
 const database=assertSafeTestDatabaseUrl(databaseUrl,{nodeEnv:process.env.NODE_ENV});
 const pool=new Pool({connectionString:databaseUrl,max:4});t.after(()=>pool.end());
 const migrations=getMigrationFiles();
 assert.equal(migrations[80].filename,"202609020006_generalize_work_preparation_execution_approval.sql");
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
    scheduledStartAt:new Date(Date.now()+3600000).toISOString(),scheduledEndAt:new Date(Date.now()+7200000).toISOString(),
    timeZone:"America/New_York",locationMode:"JOB_SERVICE_LOCATION",idempotencyKey:`propose-${f.suffix}`});
  assert.equal(proposed.ok,true,proposed.code);
  const visitId=proposed.visit.id;
  assert.equal((await startVisit({...base,visitId,expectedVersion:1,idempotencyKey:randomUUID()})).ok,false);
  const confirmed=await recordExternalVisitConfirmation({...base,visitId,expectedVersion:1,quoteApprovalId:f.quoteApprovalId,
    evidenceMethod:"PHONE",confirmedAt:new Date().toISOString(),evidenceReference:"Exact appointment confirmed by phone",
    idempotencyKey:`confirm-${f.suffix}`});
  assert.equal(confirmed.ok,true,confirmed.code);
  assert.equal((await startVisit({...base,visitId,expectedVersion:2,idempotencyKey:randomUUID()})).ok,false);
  const preparationCommand={...base,quoteApprovalId:f.quoteApprovalId,idempotencyKey:`prepare-${f.suffix}`};
  const preparation=await materializeWorkPreparation(preparationCommand);
  assert.equal(preparation.ok,true,preparation.code);
  assert.equal(preparation.workPreparation.source.quoteApprovalId,f.quoteApprovalId);
  assert.equal(preparation.workPreparation.source.approvalSource,"EXTERNAL_EVIDENCE");
  assert.equal(preparation.workPreparation.relationshipId,null);
  assert.equal((await materializeWorkPreparation(preparationCommand)).replayed,true);
  const liveScheduled=await getCanonicalLiveJob({...base});
  assert.equal(liveScheduled.ok,true,liveScheduled.code);
  assert.equal(liveScheduled.liveJob.requestId,null);
  assert.equal(liveScheduled.liveJob.relationshipId,null);
  assert.equal(liveScheduled.liveJob.quoteApprovalId,f.quoteApprovalId);
  assert.equal(liveScheduled.liveJob.approvedQuoteDecisionId,null);
  assert.equal(liveScheduled.liveJob.stage.code,"WORK_READY");
  const planId=preparation.workPreparation.id;
  const planned=await reviseWorkPreparation({...base,planId,expectedVersion:1,planningState:"PLANNED",
    workStartPolicy:"REQUIRED_ITEMS_READY",items:[{sequence:1,kind:"TOOL",description:"Installation tools checked",
      quantity:1,unit:"set",providerResponsibility:"BUSINESS",commercialTreatment:"NOT_CUSTOMER_BILLABLE",
      visibility:"BUSINESS_ONLY",requiredForWorkStart:true,sourceLineage:"ACCEPTED_SCOPE_ELABORATION"},
      {sequence:2,kind:"MATERIAL",description:"Internal installation supplies",quantity:1,unit:"each",
       providerResponsibility:"BUSINESS",commercialTreatment:"NOT_CUSTOMER_BILLABLE",visibility:"BUSINESS_ONLY",
       requiredForWorkStart:true,sourceLineage:"ACCEPTED_SCOPE_ELABORATION"}],
    idempotencyKey:`plan-${f.suffix}`});
  assert.equal(planned.ok,true,planned.code);
  const executionCommand={...base,quoteApprovalId:f.quoteApprovalId,idempotencyKey:`execution-${f.suffix}`};
  assert.equal((await materializeApprovedWorkExecution({...executionCommand,quoteApprovalId:randomUUID()})).ok,false);
  const execution=await materializeApprovedWorkExecution(executionCommand);
  assert.equal(execution.ok,true,execution.code);
  assert.equal(execution.execution.source.quoteApprovalId,f.quoteApprovalId);
  assert.equal(execution.execution.source.approvalSource,"EXTERNAL_EVIDENCE");
  assert.equal(execution.execution.source.approvedCustomerDecisionId,null);
  assert.equal(execution.execution.relationshipId,null);
  assert.equal((await materializeApprovedWorkExecution(executionCommand)).replayed,true);
  const startCommand={...base,visitId,expectedVersion:2,approvedWorkExecutionId:execution.execution.id,
    expectedExecutionVersion:1,acknowledgeScheduleVariance:true,idempotencyKey:`start-${f.suffix}`};
  assert.equal((await startVisit({...startCommand,approvedWorkExecutionId:randomUUID()})).ok,false);
  assert.equal((await startVisit(startCommand)).code,"WORK_PREPARATION_NOT_READY");
  const materialId=planned.workPreparation.items.find(item=>item.kind==="MATERIAL").id;
  const purchaseCommand={...base,planId,itemId:materialId,expectedVersion:2,quantity:2,unit:"each",
    internalCostMinor:1000,internalCostCurrency:"USD",vendor:"Synthetic local vendor",
    purchasedAt:new Date().toISOString(),externalReference:`purchase-${f.suffix}`,
    idempotencyKey:`purchase-${f.suffix}`};
  const purchased=await recordMaterialPurchase(purchaseCommand);
  assert.equal(purchased.ok,true,purchased.code);
  assert.equal((await recordMaterialPurchase(purchaseCommand)).replayed,true);
  assert.equal((await recordMaterialPurchase({...purchaseCommand,quantity:3})).ok,false);
  const correctionCommand={...base,planId,purchaseId:purchased.purchase.id,expectedVersion:2,
    reversedQuantity:1,reversedInternalCostMinor:500,reasonCategory:"RETURN",reason:"Returned one spare supply",
    correctedAt:new Date().toISOString(),idempotencyKey:`correction-${f.suffix}`};
  const corrected=await correctMaterialPurchase(correctionCommand);
  assert.equal(corrected.ok,true,corrected.code);
  assert.equal((await correctMaterialPurchase(correctionCommand)).replayed,true);
  const attachmentCommand={...base,planId,purchaseId:purchased.purchase.id,evidenceType:"PURCHASE_RECEIPT",
    referenceNamespace:"test.receipt",referenceId:`receipt-${f.suffix}`,idempotencyKey:`receipt-${f.suffix}`};
  await assert.rejects(attachEvidenceReference({...attachmentCommand,purchaseId:randomUUID()}),error=>error.code==="23503");
  const attached=await attachEvidenceReference(attachmentCommand);
  assert.equal(attached.ok,true,attached.code);
  assert.equal((await attachEvidenceReference(attachmentCommand)).replayed,true);
  const staged=await recordPreparationEvent({...base,planId,itemId:materialId,expectedVersion:2,
    eventType:"MATERIAL_STAGED",idempotencyKey:`staged-${f.suffix}`});
  assert.equal(staged.ok,true,staged.code);
  const itemId=planned.workPreparation.items.find(item=>item.kind==="TOOL").id;
  const readyCommand={...base,planId,itemId,expectedVersion:2,eventType:"TOOLS_READY",idempotencyKey:`ready-${f.suffix}`};
  const ready=await recordPreparationEvent(readyCommand);
  assert.equal(ready.ok,true,ready.code);
  assert.equal((await recordPreparationEvent(readyCommand)).replayed,true);
  const allocation=(await pool.query(`SELECT id FROM canonical_pre_work_payment_allocations WHERE job_id=$1 ORDER BY created_at LIMIT 1`,[f.jobId])).rows[0];
  const reversed=await reverseDepositAllocation({...base,allocationId:allocation.id,amountMinor:100,
    expectedVersion:2,reasonCategory:"CORRECTION",reason:"Recheck payment before Work starts",idempotencyKey:`reverse-${f.suffix}`});
  assert.equal(reversed.ok,true,reversed.code);
  const unpaidStart=await startVisit(startCommand);
  assert.equal(unpaidStart.ok,false);
  assert.match(unpaidStart.code,/DEPOSIT/);
  await payExternalDeposit(f,100,3);
  const unconfirmed=await proposeVisit({...base,quoteApprovalId:f.quoteApprovalId,purpose:"APPROVED_WORK",
    scheduledStartAt:new Date(Date.now()+10800000).toISOString(),scheduledEndAt:new Date(Date.now()+14400000).toISOString(),
    timeZone:"America/New_York",locationMode:"JOB_SERVICE_LOCATION",idempotencyKey:`unconfirmed-${f.suffix}`});
  assert.equal(unconfirmed.ok,true,unconfirmed.code);
  assert.equal((await startVisit({...startCommand,visitId:unconfirmed.visit.id,expectedVersion:1,idempotencyKey:randomUUID()})).code,"INVALID_VISIT_TRANSITION");
  assert.equal((await startVisit({...startCommand,jobId:randomUUID(),idempotencyKey:randomUUID()})).ok,false);
  assert.equal((await cancelVisit({...base,visitId:unconfirmed.visit.id,expectedVersion:1,reason:"Negative gate complete",idempotencyKey:randomUUID()})).ok,true);
  const started=await startVisit(startCommand);
  assert.equal(started.ok,true,started.code);
  assert.equal(started.visit.state,"STARTED");
  const liveStarted=await getCanonicalLiveJob(base);
  assert.equal(liveStarted.ok,true,liveStarted.code);
  assert.equal(liveStarted.liveJob.stage.code,"WORK_IN_PROGRESS");
  assert.equal(liveStarted.liveJob.availableActions.some(action=>action.code==="MESSAGE_CUSTOMER"),false);
  assert.equal((await startVisit(startCommand)).replayed,true);
  assert.equal((await startVisit({...startCommand,expectedExecutionVersion:2})).ok,false);
  const completeCommand={...base,visitId,expectedVersion:3,idempotencyKey:`complete-${f.suffix}`};
  const completed=await completeVisit(completeCommand);
  assert.equal(completed.ok,true,completed.code);
  assert.equal(completed.visit.state,"COMPLETED");
  assert.equal((await completeVisit(completeCommand)).replayed,true);
  assert.equal((await getVisit({...base,visitId})).visit.externalScheduleConfirmation.id,confirmed.visit.externalScheduleConfirmation.id);
  const startEvidence=(await pool.query(`SELECT * FROM canonical_approved_work_execution_start_events WHERE job_id=$1`,[f.jobId])).rows;
  assert.equal(startEvidence.length,1);
  assert.equal(startEvidence[0].external_confirmation_evidence_id,confirmed.visit.externalScheduleConfirmation.id);
  assert.equal(startEvidence[0].quote_approval_id,f.quoteApprovalId);
  assert.equal(startEvidence[0].approval_source,"EXTERNAL_EVIDENCE");
  assert.equal(startEvidence[0].relationship_id,null);
  assert.equal(startEvidence[0].approved_customer_decision_id,null);
  for (const table of ["canonical_work_preparation_plans","canonical_work_preparation_plan_versions","canonical_work_preparation_items",
    "canonical_work_preparation_item_snapshots","canonical_work_preparation_events","canonical_material_purchase_records",
    "canonical_material_purchase_corrections","canonical_work_preparation_evidence_references","canonical_approved_work_executions",
    "canonical_approved_work_execution_versions"]) {
    const rows=(await pool.query(`SELECT quote_approval_id,approval_source,relationship_id FROM ${table} WHERE job_id=$1`,[f.jobId])).rows;
    assert.ok(rows.length>0,table);
    assert.ok(rows.every(row=>row.quote_approval_id===f.quoteApprovalId && row.approval_source==="EXTERNAL_EVIDENCE" && row.relationship_id===null),table);
  }
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM canonical_visit_versions WHERE visit_id=$1`,[visitId])).rows[0].count,4);
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM canonical_visit_events WHERE visit_id=$1`,[visitId])).rows[0].count,4);
  await assertNoExternalCustomerAuthority(f);
 });
});
