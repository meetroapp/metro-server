'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {buildRevenuePeriod}=require('../server/finance/revenuePeriod');
const {buildRevenueFinancialTruth}=require('../server/finance/revenueFinancialTruth');
const {loadProfessionalRevenueProjection,revenueFinancialProjectionInternals:{AUTHORIZED_JOBS_CTE,SQL}}=require('../server/finance/revenueFinancialProjectionService');
const {invoicePaymentInternals:{invoiceInReportingPeriod}}=require('../server/finance/invoicePaymentService');
const {BUSINESS_CUSTOMER_INVOICE_CONTEXT_SQL}=require('../server/relationships/businessCustomerInvoiceAuthority');
const {EMERGENCY_LIFECYCLE_CONTEXT_SQL}=require('../server/emergency/emergencyCommercialContext');
const now='2026-09-30T18:00:00.000Z';
const range=period=>buildRevenuePeriod({period,timeZone:'America/New_York',now});
const issued=(id,totalMinor,issuedAt='2026-09-28T16:00:00.000Z')=>({invoiceId:id,totalMinor,currency:'USD',issuedAt});
const payment=(id,amountMinor,receivedDate='2026-09-28')=>({paymentId:id,amountMinor,currency:'USD',receivedDate});
const current=(id,status='PAID',balanceMinor=0)=>({invoiceId:id,status,balanceMinor,currency:'USD'});
const paid=(id,receivedDate='2026-09-28')=>({invoiceId:id,source:'PAYMENT',receivedDate,currency:'USD'});
const receipt=(id,amount,date)=>({receiptId:id,grossAmountMinor:amount,currency:'USD',receivedAt:date});
const truth=(data,period='THIS_MONTH')=>buildRevenueFinancialTruth({range:range(period),...data});

test('Revenue and period Invoice reads share exact Emergency and business-customer authority, with actor and active role checks',()=>{
 assert.ok(AUTHORIZED_JOBS_CTE.includes(BUSINESS_CUSTOMER_INVOICE_CONTEXT_SQL));
 assert.ok(AUTHORIZED_JOBS_CTE.includes(EMERGENCY_LIFECYCLE_CONTEXT_SQL));
 assert.match(AUTHORIZED_JOBS_CTE,/professional\.user_id = \$1/);
 assert.match(AUTHORIZED_JOBS_CTE,/emergency_job\.primary_role_active = TRUE/);
 assert.match(AUTHORIZED_JOBS_CTE,/profiles\.user_id = \$1/);
 assert.match(AUTHORIZED_JOBS_CTE,/revocations\.id IS NULL/);
 assert.match(AUTHORIZED_JOBS_CTE,/'existing_customer_request'/);
 assert.doesNotMatch(AUTHORIZED_JOBS_CTE,/UNION ALL/);
 for(const query of Object.values(SQL).filter(x=>!x.includes('revenue:time_zone'))) assert.ok(query.includes(AUTHORIZED_JOBS_CTE));
 const workspace=readFileSync(require.resolve('../server/finance/invoicePaymentService'),'utf8');
 assert.match(workspace,/INNER JOIN authorized_jobs revenue_jobs ON revenue_jobs\.job_id = invoices\.job_id/);
 assert.ok(workspace.indexOf("issuances.issued_at >= $3")<workspace.indexOf('LIMIT $2`,',workspace.indexOf('const invoices = await client.query(',workspace.indexOf('async function getProfessionalInvoiceWorkspace'))));
});
for(const [label,totals] of [['standard only',[68000]],['Emergency only',[24000,25000]],['mixed Emergency and standard',[24000,25000,68000]]]) test(label+' uses canonical issuance/payment records',()=>{
 const ids=totals.map((_,i)=>label+i);
 const result=truth({invoiceIssuances:ids.map((id,i)=>issued(id,totals[i])),invoicePayments:ids.map((id,i)=>payment(id,totals[i])),currentInvoices:ids.map(id=>current(id)),firstPaidTransitions:ids.map(id=>paid(id))});
 assert.equal(result.invoicedMinor,totals.reduce((a,b)=>a+b,0));assert.equal(result.paidInvoices,totals.length);assert.equal(result.cashReceivedMinor,result.invoicedMinor);assert.equal(result.outstandingMinor,0);
});
for(const [period,cash] of [['THIS_MONTH',66000],['LAST_30_DAYS',66000],['LAST_90_DAYS',117000],['THIS_YEAR',117000]]) test(period+' reconciles three issued Paid Invoices and deposit/payment dates without double-counting',()=>{
 const result=truth({invoiceIssuances:[issued('kitchen',24000),issued('bathroom',25000),issued('standard',68000,'2026-09-01T15:35:43.048Z')],invoicePayments:[payment('kitchen-final',24000,'2026-09-29'),payment('bathroom-final',25000),payment('standard-final',17000,'2026-09-12')],preWorkReceipts:[receipt('standard-deposit',51000,'2026-08-29T14:12:38.769Z')],currentInvoices:['kitchen','bathroom','standard'].map(id=>current(id)),firstPaidTransitions:['kitchen','bathroom','standard'].map(id=>paid(id))},period);
 assert.equal(result.invoicedMinor,117000);assert.equal(result.paidInvoices,3);assert.equal(result.cashReceivedMinor,cash);assert.equal(result.outstandingMinor,0);
});
test('Emergency deposit, partial and final payments count distinct cash once and keep Outstanding now as an all-date snapshot',()=>{
 const result=truth({preWorkReceipts:[receipt('emergency-deposit',10000,'2026-09-01T15:00:00Z')],invoicePayments:[payment('partial-1',4000),payment('partial-2',6000),payment('final',5000)],invoiceIssuances:[issued('emergency',25000)],currentInvoices:[current('emergency'),current('old-unpaid','SENT',7500)],firstPaidTransitions:[paid('emergency')]});
 assert.equal(result.cashReceivedMinor,25000);assert.equal(result.invoicedMinor,25000);assert.equal(result.outstandingMinor,7500);assert.equal(result.paidInvoices,1);
 const partial=truth({invoicePayments:[payment('partial',4000)],invoiceIssuances:[issued('unpaid',10000)],currentInvoices:[current('unpaid','PARTIALLY_PAID',6000)]});
 assert.equal(partial.paidInvoices,0);assert.equal(partial.outstandingMinor,6000);assert.equal(partial.cashReceivedMinor,4000);
});
test('Draft remains reachable as workflow card and is absent from issued Revenue; missing issuance is ineligible',()=>{
 const r=range('THIS_MONTH');
 assert.equal(invoiceInReportingPeriod({status:'DRAFT',issued_at:null},{requested:true,range:r}),true);
 assert.equal(invoiceInReportingPeriod({status:'SENT',issued_at:null},{requested:true,range:r}),false);
 const result=truth({currentInvoices:[current('draft','DRAFT',12000)]});
 assert.equal(result.invoicedMinor,0);assert.equal(result.cashReceivedMinor,0);assert.equal(result.paidInvoices,0);assert.equal(result.outstandingMinor,0);
});
test('Invoice and cash window boundaries use Business midnight half-open intervals, including DST',()=>{
 for(const period of ['THIS_MONTH','LAST_30_DAYS','LAST_90_DAYS','THIS_YEAR']){
  const r=range(period);
  assert.equal(invoiceInReportingPeriod({status:'PAID',issued_at:r.startsAt},{requested:true,range:r}),true);
  assert.equal(invoiceInReportingPeriod({status:'PAID',issued_at:r.endsAt},{requested:true,range:r}),false);
  assert.equal(invoiceInReportingPeriod({status:'PAID',issued_at:new Date(new Date(r.startsAt).getTime()-1)},{requested:true,range:r}),false);
  const result=buildRevenueFinancialTruth({range:r,invoiceIssuances:[issued('start',100,r.startsAt),issued('end',900,r.endsAt)],invoicePayments:[payment('start',100,r.localStartDate),payment('end',900,r.localEndDateExclusive)]});
  assert.equal(result.invoicedMinor,100);assert.equal(result.cashReceivedMinor,100);
 }
 const dst=buildRevenuePeriod({period:'THIS_MONTH',timeZone:'America/New_York',now:'2026-11-10T12:00:00Z'});
 assert.equal(dst.startsAt,'2026-11-01T04:00:00.000Z');assert.equal(dst.endsAt,'2026-12-01T05:00:00.000Z');
});
test('Paid count retains first-payment date basis even for an Invoice issued in an earlier period',()=>{
 const result=truth({invoiceIssuances:[issued('older',10000,'2026-08-10T12:00:00Z')],invoicePayments:[payment('settlement',10000)],currentInvoices:[current('older')],firstPaidTransitions:[paid('older')]});
 assert.equal(result.invoicedMinor,0);assert.equal(result.paidInvoices,1);assert.equal(result.cashReceivedMinor,10000);
 assert.equal(invoiceInReportingPeriod({status:'PAID',issued_at:'2026-08-10T12:00:00Z'},{requested:true,range:range('THIS_MONTH')}),false);
});
test('duplicate payment/receipt identities fail closed; allocation deallocation is not extra cash or refund',()=>{
 const p=payment('same',100);
 assert.equal(truth({invoicePayments:[p,p]}).state,'UNSAFE_FINANCIAL_HISTORY');
 const d=receipt('same',100,'2026-09-15T12:00:00Z');
 assert.equal(truth({preWorkReceipts:[d,d]}).state,'UNSAFE_FINANCIAL_HISTORY');
 const result=truth({preWorkReceipts:[d],preWorkReversals:[{reversalId:'allocation',reversedMinor:100,currency:'USD',reversalEffect:'DEALLOCATE',reversedAt:'2026-09-15T12:00:00Z'}]});
 assert.equal(result.cashReceivedMinor,100);
});
test('corrected projection returns all-source receipt/payment/issuance records without computing from Invoice paid snapshots',async()=>{
 const map={'time_zone':[{time_zone:'America/New_York'}],'pre_work_receipts':[{receipt_id:'deposit',gross_amount_minor:51000,currency:'USD',received_at:'2026-08-29T14:12:38Z'}],'pre_work_reversals':[],'invoice_payments':[17000,24000,25000].map((amount,i)=>({payment_id:'p'+i,amount_minor:amount,currency:'USD',received_date:'2026-09-28'})),'invoice_issuances':[68000,24000,25000].map((amount,i)=>({invoice_id:'i'+i,total_minor:amount,currency:'USD',issued_at:'2026-09-28T12:00:00Z'})),'current_invoices':[0,1,2].map(i=>({invoice_id:'i'+i,status:'PAID',balance_minor:0,currency:'USD'})),'first_paid':[0,1,2].map(i=>({invoice_id:'i'+i,currency:'USD',first_paid_version:3,issued_version:2,issued_at:'2026-09-28T12:00:00Z',received_date:'2026-09-28'}))};
 const client={query:async(sql,params)=>{assert.equal(params[0],15);return {rows:map[/revenue:([a-z_]+)/.exec(sql)[1]]};}};
 for(const period of ['THIS_MONTH','LAST_30_DAYS','LAST_90_DAYS','THIS_YEAR']){
  const r=await loadProfessionalRevenueProjection({client,actorId:15,period,now});
  assert.equal(r.invoicedMinor,117000);assert.equal(r.paidInvoices,3);assert.equal(r.cashReceivedMinor,['THIS_MONTH','LAST_30_DAYS'].includes(period)?66000:117000);
 }
});
