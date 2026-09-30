"use strict";
const assert = require('node:assert/strict');
const test = require('node:test');
const {Pool} = require('pg');
const {assertSafeTestDatabaseUrl}=require('./helpers/databaseTargetSafety');
const native=require('../server/workflow/nativeCustomerHistoryService');
const relationship=require('../server/relationships/businessCustomerRelationshipService');
const url=process.env.CUSTOMER_HISTORY_READ_ONLY_DATABASE_URL;
const dbOptions={skip:!url};
const tables=['jobs','canonical_quotes','canonical_invoices','canonical_job_completion_records','business_contacts','business_customer_relationships'];
function readPool(pool) {
 return {async query(sql,args) {
  assert.doesNotMatch(sql,/\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|TRUNCATE|DROP)\b/i);
  if (/^BEGIN/.test(sql)) assert.match(sql,/READ ONLY/);
  return pool.query(sql,args);
 },async connect() {
  const client=await pool.connect();
  return {async query(sql,args) {
    assert.doesNotMatch(sql,/\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|TRUNCATE|DROP)\b/i);
    if (/^BEGIN/.test(sql)) assert.match(sql,/READ ONLY/);
    return client.query(sql,args);
  },release(){client.release();}};
 }};
}
async function counts(pool) {
 const values=[];for(const table of tables) values.push((await pool.query(`SELECT count(*)::integer AS n FROM ${table}`)).rows[0].n);return values;
}

test('existing local fixture native history executes read-only with exact subject, paging and commercial associations',dbOptions,async()=>{
 assertSafeTestDatabaseUrl(url,{nodeEnv:process.env.NODE_ENV});
 const raw=new Pool({connectionString:url});const pool=readPool(raw);
 try {
  const before=await counts(pool);const profiles=(await pool.query('SELECT id,user_id FROM contractor_profiles ORDER BY id')).rows;
  let found;
  for(const profile of profiles) {
   const directory=await native.listNativeCustomers({pool,authenticatedActor:{id:profile.user_id},contractorProfileId:profile.id,limit:50});
   assert.equal(directory.ok,true);
   if(directory.nativeCustomers.customers.length){found={profile,customer:directory.nativeCustomers.customers[0]};break;}
  }
  assert.ok(found,'This read-only certification requires an existing native Job fixture; no fixtures are created.');
  const {profile,customer}=found;
  const input={pool,authenticatedActor:{id:profile.user_id},contractorProfileId:profile.id,homeownerUserId:customer.subject.homeownerUserId};
  let result=await native.listNativeCustomerHistory({...input,limit:1});assert.equal(result.ok,true,result.message);
  const first=result.nativeCustomerHistory;assert.ok(first.jobs.length);
  const jobs=[...first.jobs];const seen=new Set();
  while(result.nativeCustomerHistory.pagination.nextCursor) {
   const cursor=result.nativeCustomerHistory.pagination.nextCursor;assert.equal(seen.has(cursor),false);seen.add(cursor);
   result=await native.listNativeCustomerHistory({...input,limit:1,cursor});assert.equal(result.ok,true);
   jobs.push(...result.nativeCustomerHistory.jobs);
  }
  assert.equal(new Set(jobs.map(job=>job.jobId)).size,jobs.length);
  assert.equal(jobs.length,first.summary.activeJobs+first.summary.completedJobs);
  const complete=await native.listNativeCustomerHistory({...input,limit:50});assert.equal(complete.ok,true);
  const history=complete.nativeCustomerHistory;const ids=new Set(history.jobs.map(job=>job.jobId));
  for(const row of [...history.quotes,...history.invoices]) assert.ok(ids.has(row.jobId));
  for(const row of [...history.documents,...history.media]) assert.ok(ids.has(row.parentId));
  for(const row of history.quotes) {assert.equal(row.status,'ISSUED');assert.ok(row.issuedAt);}
  for(const row of history.invoices) {assert.notEqual(row.status,'DRAFT');assert.ok(row.issuedAt);}
  for(const row of history.jobs) {
   const detail=await native.getNativeCustomerJobHistory({...input,jobId:row.jobId});
   assert.equal(detail.nativeCustomerJobHistory.job.jobId,row.jobId);
   assert.equal(detail.nativeCustomerJobHistory.job.completionState,row.completionState);
  }
  assert.equal((await native.listNativeCustomerHistory({...input,authenticatedActor:{id:customer.subject.homeownerUserId}})).status,404);
  assert.equal((await native.listNativeCustomerHistory({...input,homeownerUserId:2147483646})).status,404);
  assert.deepEqual(await counts(pool),before);
 }finally {await raw.end();}
});

test('all relationship activity SQL plans against existing local schema without fixture or business writes',dbOptions,async()=>{
 assertSafeTestDatabaseUrl(url,{nodeEnv:process.env.NODE_ENV});
 const statements=[];
 const fake={async query(sql,args) {
  if(sql.includes('business_customer_relationship:load_owned'))return {rows:[{id:'22222222-2222-4222-8222-222222222222',contractor_profile_id:10,business_contact_id:'11111111-1111-4111-8111-111111111111',version:1,contact_party_type:'PERSON',contact_display_name:'Fixture',contact_status:'ACTIVE',contact_version:1}]};
  if(sql.includes(':activity_'))statements.push({sql,args});return {rows:[]};
 }};
 await relationship.getBusinessCustomerRelationshipActivity({pool:fake,authenticatedActor:{id:101},relationshipId:'22222222-2222-4222-8222-222222222222'});
 assert.equal(statements.length,8);
 const raw=new Pool({connectionString:url});const client=await raw.connect();
 try {
  await client.query('BEGIN TRANSACTION READ ONLY');
  for(const statement of statements) {
   const plan=await client.query(`EXPLAIN (FORMAT JSON) ${statement.sql}`,statement.args);assert.ok(plan.rows.length);
  }
  await client.query('ROLLBACK');
 }finally {client.release();await raw.end();}
});
