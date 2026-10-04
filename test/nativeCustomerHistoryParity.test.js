"use strict";
const assert = require('node:assert/strict');
const test = require('node:test');
const native = require('../server/workflow/nativeCustomerHistoryService');
const JOB = '33333333-3333-4333-8333-333333333333';
const DONE = '44444444-4444-4444-8444-444444444444';
const QUOTE = '55555555-5555-4555-8555-555555555555';
const INVOICE = '66666666-6666-4666-8666-666666666666';
const at = '2026-09-01T12:00:00.000Z';
function pool({ owned = true, found = true, paged = false, conversations = [71] } = {}) {
  const calls = [];
  return { calls, async query(sql, args = []) {
    calls.push({ sql, args });
    if (/^BEGIN|^COMMIT|^ROLLBACK/.test(sql)) return {rows:[]};
    if (sql.startsWith('SELECT id FROM contractor_profiles')) return { rows: owned && args[0] === 10 && args[1] === 101 ? [{id:10}] : [] };
    if (sql.includes('SELECT display_name FROM native_jobs')) return { rows: found && args[2] === 17 ? [{display_name:'Same Name'}] : [] };
    if (sql.includes('native_history:jobs')) return { rows: [
      {job_id:JOB,job_created_at:at,source_type:'ordinary_request_selection',service_title:'Active',completed_at:null},
      {job_id:DONE,job_created_at:at,source_type:'emergency_request',service_title:'Completed',completed_at:at,workstream_count:1,work_item_count:2,customer_update_count:3},
    ].slice(0, paged ? 2 : args[5]) };
    if (sql.includes('native_history:quote_versions')) return {rows:[{id:QUOTE,current_version:2}]};
    if (sql.includes('native_history:communication')) return {rows:conversations.map(id=>({id}))};
    if (sql.includes('native_history:summary')) return {rows:[{active_jobs:1,completed_jobs:1,quotes:1,invoices:1,photos:1}]};
    if (sql.includes('native_history:quotes')) return {rows: args[4].includes(JOB) ? [{quote_id:QUOTE,job_id:JOB,status:'ISSUED',issued_at:at,currency:'USD',total_minor:10000,parent_quote_id:DONE,lineage_type:'REVISED_QUOTE'}] : []};
    if (sql.includes('native_history:invoices')) return {rows:args[4].includes(DONE) ? [{invoice_id:INVOICE,invoice_number:'INV-1',job_id:DONE,status:'PARTIALLY_PAID',issued_at:at,currency:'USD',total_minor:10000,paid_minor:3000,balance_minor:7000}] : []};
    if (sql.includes('native_history:media')) return {rows:args[4].includes(JOB) ? [{job_id:JOB,media_id:'photo',secure_url:'https://res.cloudinary.com/meetro/image/upload/photo.jpg',format:'jpg',uploaded_at:at}] : []};
    if (sql.includes('native_jobs.job_id = $4')) return {rows:args[2] === 17 && args[3] === JOB ? [{job_id:JOB,job_created_at:at,source_type:'ordinary_request_selection',service_title:'Active',completed_at:null}] : []};
    throw Error(sql);
  }};
}
const input = db => ({pool:db,authenticatedActor:{id:101},contractorProfileId:10,homeownerUserId:17});

test('native authority projects active/completed Jobs and customer-wide evidence without writes', async () => {
  const db = pool(); const result = await native.listNativeCustomerHistory(input(db));
  assert.equal(result.ok,true); const h=result.nativeCustomerHistory;
  assert.equal(h.contractVersion,2); assert.deepEqual(h.subject,{kind:'MEETRO_ACCOUNT',contractorProfileId:10,homeownerUserId:17});
  assert.deepEqual(h.jobs.map(j=>[j.jobId,j.completionState]),[[JOB,'ACTIVE'],[DONE,'COMPLETED']]);
  assert.equal(h.quotes[0].jobId,JOB);assert.equal(h.quotes[0].lineageLabel,'Revised');
  assert.equal(h.invoices[0].jobId,DONE);assert.equal(h.invoices[0].paidMinor,3000);assert.equal(h.invoices[0].balanceMinor,7000);
  assert.equal(h.documents.length,2);assert.equal(h.media[0].parentId,JOB);
  assert.deepEqual(h.summary,{activeJobs:1,completedJobs:1,quotes:1,invoices:1,documents:2,photos:1});
  assert.match(db.calls[0].sql,/READ ONLY/);
  for(const {sql} of db.calls) assert.doesNotMatch(sql,/\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE)\b/i);
  const commercial = db.calls.find(c=>c.sql.includes('native_history:quotes'));
  assert.deepEqual(commercial.args.slice(0,3),[10,101,17]);
  assert.deepEqual(commercial.args[4],[JOB,DONE]);
  assert.match(commercial.sql,/delivery\.delivery_request_fingerprint/);
  assert.match(commercial.sql,/current.status <> 'DRAFT' AND issuances.issued_at IS NOT NULL/);
  assert.match(commercial.sql,/invoices.relationship_id = jobs.relationship_id/);
  assert.match(commercial.sql,/photo.item->>'purpose' = 'request-photo'/);
  assert.match(commercial.sql,/photo.item->>'lifecycle_state' = 'attached'/);
  assert.match(commercial.sql,/role_assignment_id = role.id/);
  assert.doesNotMatch(JSON.stringify(h),/fingerprint|integrity|processor|participant|grant|private/i);
});

test('exact actor/business/customer ownership fails closed before evidence reads', async () => {
  for(const override of [{contractorProfileId:11},{authenticatedActor:{id:102}},{homeownerUserId:18}]) {
    const db=pool();const r=await native.listNativeCustomerHistory({...input(db),...override});
    assert.equal(r.status,404);assert.equal(db.calls.some(c=>c.sql.includes('native_history:quotes')),false);
  }
});

test('active Job opens by exact subject and canonical Job identity', async () => {
  const db=pool();const r=await native.getNativeCustomerJobHistory({...input(db),jobId:JOB});
  assert.equal(r.nativeCustomerJobHistory.job.completionState,'ACTIVE');
  assert.equal((await native.getNativeCustomerJobHistory({...input(db),homeownerUserId:18,jobId:JOB})).status,404);
  assert.equal((await native.getNativeCustomerJobHistory({...input(db),jobId:INVOICE})).status,404);
});

test('pagination uses deterministic activity time plus exact Job and binds cursor to subject', async () => {
  const db=pool({paged:true}); const first=await native.listNativeCustomerHistory({...input(db),limit:1});
  const cursor=first.nativeCustomerHistory.pagination.nextCursor;assert.ok(cursor);
  const value=JSON.parse(Buffer.from(cursor,'base64url'));assert.equal(value.activityAt,at);assert.equal(value.jobId,JOB);
  await native.listNativeCustomerHistory({...input(db),limit:1,cursor});
  const query=db.calls.filter(c=>c.sql.includes('native_history:jobs')).at(-1);
  assert.deepEqual(query.args,[10,101,17,at,JOB,2]);
  assert.match(query.sql,/ORDER BY COALESCE\(native_jobs.completed_at, native_jobs.job_created_at\) DESC, native_jobs.job_id DESC/);
  assert.equal((await native.listNativeCustomerHistory({...input(db),homeownerUserId:18,cursor})).status,400);
});


test('communication never guesses between multiple historical targets and native has no new-work authority', async () => {
  for (const [conversations, expected] of [[[],null],[[71],71],[[71,72],null]]) {
    const db=pool({conversations});const result=await native.listNativeCustomerHistory(input(db));
    assert.deepEqual(result.nativeCustomerHistory.actionBridge,{canStartNewJob:false,conversationId:expected});
    const sql=db.calls.find(call=>call.sql.includes('native_history:communication')).sql;
    assert.match(sql,/conversation.status = 'active'/);
    assert.match(sql,/conversation.professional_archived_at IS NULL/);
  }
});
