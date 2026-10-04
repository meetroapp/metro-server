'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {getCanonicalInvoicePdf}=require('../server/finance/canonicalInvoicePdf');
const invoice={invoiceId:'11111111-1111-4111-8111-111111111111',invoiceNumber:'INV-111111111111',jobId:'22222222-2222-4222-8222-222222222222',currentVersion:3,status:'PARTIALLY_PAID',currency:'USD',invoiceDate:'2026-09-12',due:{mode:'DUE_ON_RECEIPT',date:null},business:{displayName:'Business'},customer:{displayName:'Customer'},job:{title:'Repair'},lineItems:[{description:'Repair',quantity:1,unitAmountMinor:68000,lineTotalMinor:68000}],subtotalMinor:68000,totalMinor:68000,paidMinor:51000,balanceMinor:17000,terms:'Due on receipt',customerNotes:null};
test('canonical PDF reads exact authorized Invoice and preserves canonical amounts',async()=>{
 let seen;const input={invoiceId:invoice.invoiceId,authenticatedActor:{id:5},pool:{},expectedVersion:3};
 const result=await getCanonicalInvoicePdf(input,{readInvoice:async args=>{assert.equal(args.invoiceId,invoice.invoiceId);return {ok:true,invoice};},render:async p=>{seen=p;return {contentType:'application/pdf',bytes:Buffer.from('%PDF-1.4')};}});
 assert.equal(result.ok,true);assert.equal(seen.document.id,invoice.invoiceId);assert.equal(seen.document.status,invoice.status);assert.equal(seen.totalMinor,68000);assert.equal(seen.paidMinor,51000);assert.equal(seen.balanceMinor,17000);assert.equal(seen.lineItems[0].lineTotalMinor,68000);
});
test('PDF denies unauthorized or stale reads and never renders a replacement document',async()=>{
 for(const read of [{ok:false,status:403},{ok:true,invoice}]){
 const result=await getCanonicalInvoicePdf({invoiceId:invoice.invoiceId,expectedVersion:2},{readInvoice:async()=>read,render:()=>{throw Error('must not render');}});assert.equal(result.ok,false);
 }
});
test('Customer PDF uses the exact internal version without exposing command authority',async()=>{
 let version;const customer={...invoice};delete customer.currentVersion;
 const result=await getCanonicalInvoicePdf({invoiceId:invoice.invoiceId,audience:'customer'},{readInvoice:async()=>({ok:true,invoice:customer,invoiceVersion:7}),render:async p=>{version=p.document.version;return {};}});
 assert.equal(result.ok,true);assert.equal(version,7);
});
test('real shared renderer produces canonical PDF bytes with paid amount and balance',async()=>{
 const result=await getCanonicalInvoicePdf({invoiceId:invoice.invoiceId},{readInvoice:async()=>({ok:true,invoice})});
 assert.match(result.pdf.buffer.toString('latin1'),/^%PDF-/);assert.match(result.pdf.buffer.toString('latin1'),/510\.00/);assert.match(result.pdf.buffer.toString('latin1'),/170\.00/);assert.match(result.pdf.filename,/INV-111111111111-v3/);
});
