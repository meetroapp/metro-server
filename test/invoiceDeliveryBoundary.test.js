'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {invoicePaymentInternals,issueInvoice}=require('../server/finance/invoicePaymentService');
test('Invoice resend preserves version, balance and original issue time',()=>{
 const row={status:'PARTIALLY_PAID',version:3,issued_at:'2026-09-12T12:00:00.000Z',paid_minor:51000,balance_minor:17000};
 const plan=invoicePaymentInternals.invoiceDeliveryPlan(row,{completion_id:'complete'});
 assert.equal(plan.allowed,true);assert.equal(plan.initialIssue,false);assert.equal(plan.version,3);assert.equal(plan.issuedAt,row.issued_at);assert.equal(row.paid_minor,51000);
});
test('Incomplete Job blocks both draft and resend delivery',()=>{
 for(const status of ['DRAFT','SENT','PARTIALLY_PAID','PAID']) assert.equal(invoicePaymentInternals.invoiceDeliveryPlan({status,version:2},{}).allowed,false);
});
test('Delivery refuses external party without conversation, with no financial or Job mutation',async()=>{
 const sql=[];const pool={query:async(q)=>{sql.push(q);if(q.includes('FROM canonical_invoices invoices'))return {rows:[{invoice_id:'11111111-1111-4111-8111-111111111111',job_id:'22222222-2222-4222-8222-222222222222',professional_user_id:7,primary_role_active:true,relationship_status:'active',status:'SENT',version:2,conversation_id:null}]};if(q.includes('FROM jobs'))return {rows:[{completion_id:'complete'}]};return {rows:[],rowCount:1};}};
 const result=await issueInvoice({pool,authenticatedActor:{id:7},invoiceId:'11111111-1111-4111-8111-111111111111',expectedVersion:2,messageText:'Invoice',idempotencyKey:'test-no-conversation'});
 assert.equal(result.ok,false);assert.equal(sql.some(q=>/^\s*(?:INSERT|UPDATE|DELETE)\b/.test(q)),false);
});
