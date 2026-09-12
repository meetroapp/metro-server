'use strict';
const {randomUUID,createHash}=require('node:crypto');
const {commercialAuthorityInternals}=require('../authorization/commercialAuthorityService');
const {loadBusinessJobContext}=require('../relationships/businessJobAuthority');
const invoiceService=require('./invoicePaymentService');
const {getCanonicalInvoicePdf}=require('./canonicalInvoicePdf');
const {createEmailDelivery}=require('../email/emailDelivery');
const {failure,normalizedUuid,validateAuthenticatedActor,validateIdempotencyKey}=commercialAuthorityInternals;
const escapeHtml=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function deliveryProjection(row) {
 return {id:row.id,invoiceId:row.invoice_id,jobId:row.job_id,invoiceVersion:Number(row.invoice_version),
   purpose:row.purpose,recipientEmail:row.recipient_email,state:row.state};
}
function response(row,replayed=false) {
 if(row.state==='FAILED') return failure(502,'INVOICE_EMAIL_FAILED','Email was not accepted. Retry with a new attempt.');
 return {ok:true,status:202,code:row.state==='REQUESTING'?'INVOICE_EMAIL_PENDING':'INVOICE_EMAIL_DELIVERY_REQUESTED',
   delivery:deliveryProjection(row),replayed};
}
async function sendExternalInvoiceEmail(input={}) {
 const allowed=['pool','authenticatedActor','invoiceId','expectedVersion','purpose','messageText','idempotencyKey','emailDelivery'];
 if(!input || typeof input!=='object' || Object.keys(input).some(key=>!allowed.includes(key))) return failure(400,'INVOICE_EMAIL_FIELD_REJECTED','The email request is invalid.');
 const actor=validateAuthenticatedActor(input.authenticatedActor); if(actor.error)return actor.error;
 const invoiceId=normalizedUuid(input.invoiceId), expectedVersion=Number(input.expectedVersion);
 const key=validateIdempotencyKey(input.idempotencyKey); if(key.error)return key.error;
 const messageText=input.messageText==null?null:String(input.messageText).trim();
 if(!invoiceId || !Number.isSafeInteger(expectedVersion) || expectedVersion<1 || !['INVOICE','REMINDER'].includes(input.purpose)
   || (input.messageText!=null && (typeof input.messageText!=='string' || !messageText || messageText.length>5000)))
   return failure(400,'INVALID_INVOICE_EMAIL_COMMAND','The email request is invalid.');
 const fingerprint=createHash('sha256').update(JSON.stringify({invoiceId,expectedVersion,purpose:input.purpose,messageText})).digest('hex');
 const client=await input.pool.connect();
 let reservation,invoice;
 try {
   await client.query('BEGIN');
   const identity=await client.query('SELECT job_id FROM canonical_invoices WHERE id=$1 FOR UPDATE',[invoiceId]);
   const context=identity.rows[0] && await loadBusinessJobContext(client,identity.rows[0].job_id,actor.id,{lock:true});
   if(!context){await client.query('ROLLBACK');return failure(404,'INVOICE_UNAVAILABLE','The Invoice is unavailable.');}
   const prior=await client.query('SELECT * FROM canonical_invoice_external_communications WHERE actor_user_id=$1 AND idempotency_key=$2',[actor.id,key.idempotencyKey]);
   if(prior.rows[0]) {
     await client.query('COMMIT');
     return prior.rows[0].request_fingerprint===fingerprint?response(prior.rows[0],true):failure(409,'INVOICE_EMAIL_IDEMPOTENCY_CONFLICT','This attempt belongs to different Invoice details.');
   }
   // Read in this transaction so the attachment and reservation bind the same version.
   const source=await invoiceService.invoicePaymentInternals.loadInvoiceContext(client,invoiceId,actor.id);
   if(!source || !invoiceService.invoicePaymentInternals.professionalAuthorized(source,actor.id)) {await client.query('ROLLBACK');return failure(404,'INVOICE_UNAVAILABLE','The Invoice is unavailable.');}
   invoice=await invoiceService.invoicePaymentInternals.loadInvoiceProjection(client,source,'professional');
   if(invoice.currentVersion!==expectedVersion || invoice.status==='DRAFT' || !context.completion_id ||
      (input.purpose==='REMINDER' && invoice.balanceMinor<=0)) {
     await client.query('ROLLBACK');return failure(409,'STALE_INVOICE_EMAIL_SOURCE','Reopen the completed, issued Invoice before sending.');
   }
   if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(context.customer_email || '')) {
     await client.query('ROLLBACK');return failure(409,'INVOICE_CUSTOMER_EMAIL_UNAVAILABLE','Add an email address to this Customer contact before emailing.');
   }
   const inserted=await client.query(`INSERT INTO canonical_invoice_external_communications
     (id,invoice_id,invoice_version,job_id,actor_user_id,purpose,recipient_email,customer_message,idempotency_key,request_fingerprint,state)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'REQUESTING') RETURNING *`,
     [randomUUID(),invoiceId,expectedVersion,context.job_id,actor.id,input.purpose,context.customer_email,messageText,key.idempotencyKey,fingerprint]);
   reservation=inserted.rows[0];
   await client.query('COMMIT');
 } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
 let provider;
 try {
   const artifact=await getCanonicalInvoicePdf({invoiceId,expectedVersion},{readInvoice:async()=>({ok:true,invoice})});
   if(!artifact.ok) throw new Error('Invoice PDF unavailable');
   const amount=(invoice.balanceMinor/100).toFixed(2);
   const subject=`${input.purpose==='REMINDER'?'Payment reminder: ':''}Invoice ${invoice.invoiceNumber}`;
   const text=[messageText,`${invoice.business.displayName} — ${invoice.job.title}`,`${subject}. Balance due: ${invoice.currency} ${amount}.`,
     input.purpose==='REMINDER'?'This is a payment reminder only.':'Your Invoice PDF is attached.'].filter(Boolean).join('\n\n');
   provider=await (input.emailDelivery || createEmailDelivery()).sendBusinessDocumentEmail({
     recipientEmail:reservation.recipient_email,subject,text,html:`<main><p style="white-space:pre-line">${escapeHtml(text)}</p></main>`,
     attachment:{filename:artifact.pdf.filename,content:artifact.pdf.base64,contentType:'application/pdf'},
     idempotencyKey:`invoice-email-${reservation.id}`});
 } catch {provider={accepted:false,status:'provider_unavailable'};}
 const state=provider.accepted || provider.status==='timeout'?'DELIVERY_REQUESTED':'FAILED';
 const final=await input.pool.query(`UPDATE canonical_invoice_external_communications SET state=$2,provider_status=$3,
   provider_reference=$4,completed_at=CURRENT_TIMESTAMP WHERE id=$1 AND state='REQUESTING' RETURNING *`,
   [reservation.id,state,provider.status || 'provider_unavailable',provider.providerReference || null]);
 if(!final.rows[0]) throw new Error('Invoice communication evidence unavailable');
 return response(final.rows[0]);
}
module.exports={sendExternalInvoiceEmail};
