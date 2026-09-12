"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { assertSafeTestDatabaseUrl } = require('./helpers/databaseTargetSafety');
const { getMigrationFiles, runMigrationCollection } = require('../scripts/run-migrations');
const { createWorkingQuote, createExternalLifecycleFixture, payExternalDeposit, assertNoExternalCustomerAuthority, quiet } = require('./helpers/externalLifecycleFixture');
const completion = require('../server/workflow/jobCompletionService');
const invoices = require('../server/finance/invoicePaymentService');
const { createWorkstream } = require('../server/workflow/workstreamService');
const execution = require('../server/workflow/approvedWorkExecutionService');
const preparation = require('../server/workflow/workPreparationService');
const visits = require('../server/workflow/visitService');
const { activateApprovedWorkVisitAuthority } = require('../server/workflow/approvedWorkVisitService');
const { recordExternalVisitConfirmation } = require('../server/workflow/externalVisitConfirmationService');
const {sendExternalInvoiceEmail}=require('../server/finance/externalInvoiceCommunicationService');
const {getBusinessCustomerRelationshipActivity}=require('../server/relationships/businessCustomerRelationshipService');
const {getCanonicalLiveJob}=require('../server/workflow/liveJobProjectionService');
const {getProfessionalJobWorkPlan}=require('../server/workflow/workPlanService');
const { getCanonicalInvoicePdf } = require('../server/finance/canonicalInvoicePdf');
const databaseUrl = process.env.EXTERNAL_FINISH_DATABASE_URL;
const ok = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result; };

test('external customer canonical completion, Invoice, payment and history without marketplace authority', {skip: !databaseUrl}, async t => {
  const database = assertSafeTestDatabaseUrl(databaseUrl, {nodeEnv: process.env.NODE_ENV});
  const pool = new Pool({connectionString: databaseUrl});
  t.after(() => pool.end());
  ok(await runMigrationCollection(pool, getMigrationFiles(), {target:'local-test', database}).then(r=>({...r,ok:r.success})));
  const f = await createExternalLifecycleFixture(pool, 'EXTERNAL_CONTACT', {materialItems:[],laborItems:[{id:'labor-1',description:'Approved installation',total:'680.00'}],depositPercent:'75',terms:'75% deposit required.',paymentTerms:'75% deposit required.'});
  await pool.query(`INSERT INTO business_contact_roles(business_contact_id,contractor_profile_id,role,assigned_by_user_id) SELECT business_contact_id,contractor_profile_id,'CUSTOMER',$2 FROM jobs WHERE id=$1`,[f.jobId,f.userId]);
  const base = {pool, authenticatedActor:f.authenticatedActor, jobId:f.jobId};
  const cmd = (fn, values = {}) => fn({...base, logger:quiet, ...values, idempotencyKey:randomUUID()});
  await t.test('null-request external Job obtains governed completion review, incomplete work cannot complete', async () => {
    const review = ok(await completion.getJobCompletionReview(base)).completionReview;
    assert.equal(review.requestId, null);
    assert.equal(review.relationshipId, null);
    assert.equal(review.authority.kind, 'BUSINESS_CUSTOMER');
    assert.equal(review.canComplete, false);
    assert.equal((await cmd(completion.completeJob, {expectedVersion:0})).ok,false);
  });
  await t.test('wrong owner fails closed', async () => {
    assert.equal((await completion.getJobCompletionReview({...base,authenticatedActor:{id:f.userId+10000}})).ok,false);
  });
  await payExternalDeposit(f,51000,1);
  await t.test('Deposit receipt alone cannot complete the Job or create an Invoice',async()=>{
    assert.equal(ok(await completion.getJobCompletionReview(base)).completionReview.state,'ACTIVE');
    const attempted=await invoices.createInvoice({...base,expectedCompletionVersion:1,due:{mode:'DUE_ON_RECEIPT',date:null},idempotencyKey:randomUUID()});
    assert.equal(attempted.code,'JOB_NOT_READY_TO_INVOICE');
    assert.equal((await pool.query('SELECT count(*)::int n FROM canonical_invoices WHERE job_id=$1',[f.jobId])).rows[0].n,0);
  });
  const work = ok(await cmd(createWorkstream,{title:'Approved installation',sequence:1})).workstream;
  const active = ok(await cmd(execution.materializeApprovedWorkExecution,{quoteApprovalId:f.quoteApprovalId})).execution;
  ok(await cmd(execution.bindWorkstreamToExecution,{executionId:active.id,workstreamId:work.id,expectedExecutionVersion:1}));
  const plan = ok(await cmd(preparation.materializeWorkPreparation,{quoteApprovalId:f.quoteApprovalId})).workPreparation;
  ok(await cmd(preparation.reviseWorkPreparation,{planId:plan.id,expectedVersion:1,planningState:'PLANNED',workStartPolicy:'NONE',items:[]}));
  ok(await cmd(activateApprovedWorkVisitAuthority,{quoteId:f.quoteId}));
  const visit = ok(await cmd(visits.proposeVisit,{quoteApprovalId:f.quoteApprovalId,purpose:'APPROVED_WORK',scheduledStartAt:new Date(Date.now()+3600000).toISOString(),scheduledEndAt:new Date(Date.now()+7200000).toISOString(),timeZone:'America/New_York',locationMode:'JOB_SERVICE_LOCATION'})).visit;
  ok(await cmd(recordExternalVisitConfirmation,{visitId:visit.id,expectedVersion:1,quoteApprovalId:f.quoteApprovalId,evidenceMethod:'PHONE',confirmedAt:new Date().toISOString(),evidenceReference:'Confirmed exact scheduled work by phone'}));
  ok(await cmd(visits.startVisit,{visitId:visit.id,expectedVersion:2,approvedWorkExecutionId:active.id,expectedExecutionVersion:1,acknowledgeScheduleVariance:true}));
  ok(await cmd(visits.completeVisit,{visitId:visit.id,expectedVersion:3}));
  ok(await cmd(execution.completeApprovedWork,{executionId:active.id,expectedExecutionVersion:1,expectedWorkstreams:[{workstreamId:work.id,expectedVersion:1}],expectedActivities:[]}));
  let review, completed, invoice;
  await t.test('external Work Plan exposes the exact bound approved work',async()=>{
    const plan=ok(await getProfessionalJobWorkPlan(base)).workPlan;
    assert.equal(plan.requestId,null);assert.ok(plan.workstreams.some(w=>w.id===work.id));
  });
  await t.test('Review then Confirm appends exact canonical completion evidence', async () => {
    assert.equal(ok(await getCanonicalLiveJob(base)).liveJob.nextAction.code,'REVIEW_WORKSTREAM_COMPLETION');
    review = ok(await completion.getJobCompletionReview(base)).completionReview;
    assert.equal(review.canComplete,true);
    const command = {...base,expectedVersion:review.currentVersion,idempotencyKey:randomUUID(),logger:quiet};
    completed = ok(await completion.completeJob(command)).completion;
    assert.equal(completed.status,'COMPLETED');
    assert.equal(completed.requestId,null);
    assert.equal(ok(await completion.completeJob(command)).completion.id,completed.id);
    assert.equal(ok(await completion.getJobCompletionReview(base)).completionReview.state,'COMPLETED');
    assert.equal(ok(await getCanonicalLiveJob(base)).liveJob.nextAction.code,'READY_TO_INVOICE');
  });
  await t.test('completed external Job is ready with exact approved Quote and Deposit evidence', async () => {
    const row = ok(await invoices.getProfessionalInvoiceWorkspace({pool,authenticatedActor:f.authenticatedActor})).workspace.readyJobs.find(j=>j.jobId===f.jobId);
    assert.ok(row);
    assert.equal(row.requestId,null);
    assert.equal(row.approvedAmount.totalMinor,68000);
    assert.equal(row.paymentsReceivedMinor,51000);
    assert.equal(row.amountStillDueMinor,17000);
  });
  await t.test('canonical external Invoice creation preserves scope and payment provenance', async () => {
    invoice = ok(await invoices.createInvoice({...base,expectedCompletionVersion:1,due:{mode:'DUE_ON_RECEIPT',date:null},idempotencyKey:randomUUID()})).invoice;
    assert.equal(invoice.requestId,null);
    assert.equal(invoice.relationshipId,null);
    assert.equal(invoice.conversationId,null);
    assert.equal(invoice.totalMinor,68000);
    assert.equal(invoice.paidMinor,51000);
    assert.equal(invoice.balanceMinor,17000);
    assert.equal(invoice.payments.length,0);
    assert.ok(invoice.lineItems.every(line=>line.sourceQuoteId===f.quoteId && line.sourceQuoteVersion===f.issuedVersion));
  });
  await t.test('Invoice line evidence cannot cite a different approval',async()=>{
    const before=(await pool.query('SELECT count(*)::int n FROM canonical_invoice_line_item_snapshots WHERE invoice_id=$1',[invoice.invoiceId])).rows[0].n;
    await assert.rejects(pool.query(`INSERT INTO canonical_invoice_line_item_snapshots
      (id,invoice_id,invoice_version,job_id,sequence,source_type,source_quote_id,source_quote_version,source_scope_item_id,lineage_label,description,quantity,unit_amount_minor,line_total_minor,created_by_participant_id,source_quote_approval_id)
      SELECT gen_random_uuid(),invoice_id,invoice_version,job_id,100,source_type,source_quote_id,source_quote_version,source_scope_item_id,lineage_label,description,quantity,unit_amount_minor,line_total_minor,created_by_participant_id,$2
      FROM canonical_invoice_line_item_snapshots WHERE invoice_id=$1 LIMIT 1`,[invoice.invoiceId,randomUUID()]),/exact approved Quote evidence|foreign key/);
    assert.equal((await pool.query('SELECT count(*)::int n FROM canonical_invoice_line_item_snapshots WHERE invoice_id=$1',[invoice.invoiceId])).rows[0].n,before);
  });
  await t.test('existing Invoice reopens; a second create cannot duplicate it', async () => {
    assert.equal(ok(await invoices.getProfessionalJobInvoice(base)).invoice.invoiceId,invoice.invoiceId);
    const duplicate = await invoices.createInvoice({...base,expectedCompletionVersion:1,due:{mode:'DUE_ON_RECEIPT',date:null},idempotencyKey:randomUUID()});
    assert.equal(duplicate.code,'INVOICE_ALREADY_EXISTS');
  });
  await t.test('external issue has no Meetro transport and authentic canonical PDF', async () => {
    invoice = ok(await invoices.issueInvoiceExternally({pool,authenticatedActor:f.authenticatedActor,invoiceId:invoice.invoiceId,expectedVersion:invoice.currentVersion,idempotencyKey:randomUUID()})).invoice;
    assert.equal(invoice.status,'PARTIALLY_PAID');
    const pdf=ok(await getCanonicalInvoicePdf({pool,authenticatedActor:f.authenticatedActor,invoiceId:invoice.invoiceId,expectedVersion:invoice.currentVersion},{readInvoice:invoices.getProfessionalInvoice}));
    assert.ok(pdf);
  });
  await t.test('Email PDF and Reminder resolve authorized contact, attach exact PDF, and preserve all financial/completion evidence',async()=>{
    const deliveries=[];
    const emailDelivery={sendBusinessDocumentEmail:async value=>{deliveries.push(value);return {accepted:true,status:'accepted',providerReference:randomUUID()};}};
    const before=ok(await invoices.getProfessionalInvoice({pool,authenticatedActor:f.authenticatedActor,invoiceId:invoice.invoiceId})).invoice;
    for(const purpose of ['INVOICE','REMINDER']) {
      const command={pool,authenticatedActor:f.authenticatedActor,invoiceId:invoice.invoiceId,expectedVersion:invoice.currentVersion,purpose,messageText:'Please review the attached Invoice.',idempotencyKey:randomUUID(),emailDelivery};
      const result=ok(await sendExternalInvoiceEmail(command));
      assert.equal(result.delivery.recipientEmail,'external@example.test');
      assert.equal(result.delivery.state,'DELIVERY_REQUESTED');
      assert.equal(ok(await sendExternalInvoiceEmail(command)).replayed,true);
      assert.equal((await sendExternalInvoiceEmail({...command,messageText:'different'})).code,'INVOICE_EMAIL_IDEMPOTENCY_CONFLICT');
    }
    assert.equal(deliveries.length,2);
    assert.ok(deliveries.every(d=>Buffer.from(d.attachment.content,'base64').subarray(0,5).toString()==='%PDF-'));
    assert.ok(deliveries.every(d=>d.attachment.contentType==='application/pdf'));
    const after=ok(await invoices.getProfessionalInvoice({pool,authenticatedActor:f.authenticatedActor,invoiceId:invoice.invoiceId})).invoice;
    assert.deepEqual(after,before);
    assert.equal((await pool.query('SELECT count(*)::int n FROM canonical_job_completion_records WHERE job_id=$1',[f.jobId])).rows[0].n,1);
    const failed=await sendExternalInvoiceEmail({pool,authenticatedActor:f.authenticatedActor,invoiceId:invoice.invoiceId,expectedVersion:invoice.currentVersion,purpose:'REMINDER',idempotencyKey:randomUUID(),emailDelivery:{sendBusinessDocumentEmail:async()=>({accepted:false,status:'provider_rejected'})}});
    assert.equal(failed.code,'INVOICE_EMAIL_FAILED');
  });
  await t.test('partial/full payment appends only actual Invoice receipts and never completes a Job', async () => {
    const command = {pool,authenticatedActor:f.authenticatedActor,invoiceId:invoice.invoiceId,expectedVersion:invoice.currentVersion,amountMinor:5000,method:'CASH',receivedDate:new Date().toISOString().slice(0,10),idempotencyKey:randomUUID()};
    invoice=ok(await invoices.recordPayment(command)).invoice;
    assert.equal(invoice.paidMinor,56000); assert.equal(invoice.balanceMinor,12000);
    assert.equal(ok(await invoices.recordPayment(command)).invoice.currentVersion,invoice.currentVersion);
    invoice=ok(await invoices.recordPayment({...command,expectedVersion:invoice.currentVersion,amountMinor:12000,idempotencyKey:randomUUID()})).invoice;
    assert.equal(invoice.status,'PAID'); assert.equal(invoice.balanceMinor,0);
    assert.equal(invoice.payments.length,2);
    let providerCalled=false;
    assert.equal((await sendExternalInvoiceEmail({pool,authenticatedActor:f.authenticatedActor,invoiceId:invoice.invoiceId,expectedVersion:invoice.currentVersion,purpose:'REMINDER',idempotencyKey:randomUUID(),emailDelivery:{sendBusinessDocumentEmail:async()=>{providerCalled=true;}}})).ok,false);
    assert.equal(providerCalled,false);
    assert.equal((await pool.query('SELECT count(*)::int n FROM canonical_job_completion_records WHERE job_id=$1',[f.jobId])).rows[0].n,1);
  });
  await t.test('external completed history contains exact Job; source records survive', async () => {
    assert.ok(ok(await completion.listProfessionalJobHistory({pool,authenticatedActor:f.authenticatedActor})).jobHistory.jobs.some(j=>j.jobId===f.jobId));
    const history=ok(await completion.getProfessionalJobHistory(base)).jobHistory;
    assert.equal(history.requestId,null); assert.equal(history.originalRequest,null);assert.equal(history.approvedQuote.totalMinor,68000);
    for(const table of ['canonical_quotes','canonical_quote_approvals','canonical_pre_work_deposit_obligations','canonical_pre_work_payment_receipts','canonical_job_completion_records','canonical_invoices','canonical_invoice_payments']) {
      assert.ok((await pool.query(`SELECT count(*)::int n FROM ${table} WHERE job_id=$1`,[f.jobId])).rows[0].n>0,table);
    }
  });
  await t.test('durable customer history shows completed work, approved Quote and canonical Invoice',async()=>{
    const relation=(await pool.query('SELECT business_customer_relationship_id FROM jobs WHERE id=$1',[f.jobId])).rows[0].business_customer_relationship_id;
    const activity=ok(await getBusinessCustomerRelationshipActivity({pool,authenticatedActor:f.authenticatedActor,relationshipId:relation})).activity;
    assert.ok(activity.work.some(j=>j.jobId===f.jobId && j.status==='COMPLETED'));
    assert.ok(activity.quotes.some(q=>q.quoteId===f.quoteId && q.customerDecision==='APPROVED'));
    assert.ok(activity.invoices.some(i=>i.invoiceId===invoice.invoiceId && i.paidMinor===68000));
    assert.ok(activity.deposits.some(d=>d.quoteId===f.quoteId && d.appliedMinor===51000));
    assert.deepEqual(activity.payments.map(p=>p.amountMinor).sort((a,b)=>a-b),[5000,12000,51000]);
  });
  await t.test('Repeat Job preserves the durable customer relationship and existing history',async()=>{
    const job=(await pool.query('SELECT * FROM jobs WHERE id=$1',[f.jobId])).rows[0];
    const quote=await createWorkingQuote({pool,userId:f.userId,contractorProfileId:f.contractorProfileId,mode:'EXTERNAL_CONTACT',businessContactId:job.business_contact_id,customerRelationshipId:job.business_customer_relationship_id,documentNumber:'Q-2'});
    const imported=ok(await require('../server/authorization/quoteDraftService').importBusinessDocumentDraftQuote({pool,authenticatedActor:f.authenticatedActor,draftId:quote.draftId,expectedDocumentVersion:1,idempotencyKey:randomUUID(),logger:quiet}));
    assert.notEqual(imported.quote.jobId,f.jobId);
    const repeated=(await pool.query('SELECT * FROM jobs WHERE id=$1',[imported.quote.jobId])).rows[0];
    assert.equal(repeated.business_customer_relationship_id,job.business_customer_relationship_id);
    assert.equal(repeated.job_request_id,null);
    assert.equal((await cmd(execution.materializeApprovedWorkExecution,{jobId:repeated.id,quoteApprovalId:f.quoteApprovalId})).ok,false);
    assert.equal(ok(await invoices.getProfessionalJobInvoice(base)).invoice.invoiceId,invoice.invoiceId);
  });
  await t.test('a mismatched durable business relationship cannot materialize a Job',async()=>{
    const job=(await pool.query('SELECT * FROM jobs WHERE id=$1',[f.jobId])).rows[0];
    const other=(await pool.query(`INSERT INTO business_contacts(contractor_profile_id,created_by_user_id,party_type,display_name) VALUES($1,$2,'PERSON','Other synthetic Customer') RETURNING id`,[f.contractorProfileId,f.userId])).rows[0];
    const relation=(await pool.query('INSERT INTO business_customer_relationships(contractor_profile_id,business_contact_id,established_by_user_id) VALUES($1,$2,$3) RETURNING id',[f.contractorProfileId,other.id,f.userId])).rows[0];
    const count=(await pool.query('SELECT count(*)::int n FROM jobs')).rows[0].n;
    await assert.rejects(async()=>{
      const draft=await createWorkingQuote({pool,userId:f.userId,contractorProfileId:f.contractorProfileId,mode:'EXTERNAL_CONTACT',businessContactId:job.business_contact_id,customerRelationshipId:relation.id,documentNumber:'Q-3'});
      const attempted=await require('../server/authorization/quoteDraftService').importBusinessDocumentDraftQuote({pool,authenticatedActor:f.authenticatedActor,draftId:draft.draftId,expectedDocumentVersion:1,idempotencyKey:randomUUID(),logger:quiet});
      if(!attempted.ok) throw Error('Authority rejected');
    });
    assert.equal((await pool.query('SELECT count(*)::int n FROM jobs')).rows[0].n,count);
  });
  await t.test('ended CUSTOMER role denies completion, Invoice access and email without changing prior evidence',async()=>{
    await pool.query(`UPDATE business_contact_roles SET ended_at=CURRENT_TIMESTAMP,ended_by_user_id=$2,ending_source='PROFESSIONAL_EXPLICIT'
      WHERE business_contact_id=(SELECT business_contact_id FROM jobs WHERE id=$1) AND role='CUSTOMER' AND ended_at IS NULL`,[f.jobId,f.userId]);
    assert.equal((await completion.getJobCompletionReview(base)).ok,false);
    assert.equal((await invoices.getProfessionalJobInvoice(base)).ok,false);
    let called=false;
    const email=await sendExternalInvoiceEmail({pool,authenticatedActor:f.authenticatedActor,invoiceId:invoice.invoiceId,expectedVersion:invoice.currentVersion,purpose:'INVOICE',idempotencyKey:randomUUID(),emailDelivery:{sendBusinessDocumentEmail:async()=>{called=true;}}});
    assert.equal(email.ok,false);assert.equal(called,false);
    assert.equal((await pool.query('SELECT count(*)::int n FROM canonical_invoice_payments WHERE invoice_id=$1',[invoice.invoiceId])).rows[0].n,2);
  });
  await t.test('no fake marketplace Request, account, participant or conversation was created',()=>assertNoExternalCustomerAuthority(f));
});
