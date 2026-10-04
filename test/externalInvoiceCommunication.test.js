'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {sendExternalInvoiceEmail}=require('../server/finance/externalInvoiceCommunicationService');
test('external email refuses client-owned recipient or authority fields before any provider call',async()=>{
 const result=await sendExternalInvoiceEmail({recipientEmail:'injected@example.test'});
 assert.equal(result.ok,false); assert.equal(result.status,400);
});
