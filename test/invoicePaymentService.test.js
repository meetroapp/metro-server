"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  invoicePaymentInternals,
} = require("../server/finance/invoicePaymentService");
const {
  normalizeInvoiceSharedPayload,
  serializeConversationMessage,
} = require("../server/conversations/conversations");

const INVOICE_ID = "11111111-1111-4111-8111-111111111111";
const JOB_ID = "22222222-2222-4222-8222-222222222222";

function invoiceRow(overrides = {}) {
  return {
    invoice_id: INVOICE_ID,
    invoice_number: "INV-111111111111",
    job_id: JOB_ID,
    job_request_id: 14,
    relationship_id: 9,
    conversation_id: 340,
    business_name: "BGone Services",
    customer_name: "Liam Molina",
    job_title: "Kitchen repair",
    job_service: "Plumbing",
    status: "SENT",
    currency: "USD",
    version: 2,
    invoice_date: "2026-08-15",
    due_mode: "DUE_ON_RECEIPT",
    due_date: null,
    subtotal_minor: 92000,
    total_minor: 92000,
    paid_minor: 0,
    balance_minor: 92000,
    customer_notes: "Thank you.",
    terms: "Due on receipt.",
    issued_at: "2026-08-15T12:00:00.000Z",
    ...overrides,
  };
}

const line = {
  id: "33333333-3333-4333-8333-333333333333",
  sequence: 1,
  source_quote_id: "44444444-4444-4444-8444-444444444444",
  source_quote_version: 3,
  lineage_label: "ORIGINAL",
  description: "Replace disposal",
  quantity: 1,
  unit_amount_minor: 92000,
  line_total_minor: 92000,
};

test("customer Invoice projection excludes command and internal lineage authority", () => {
  const projected = invoicePaymentInternals.invoiceProjection(invoiceRow(), [line], [], "customer");
  assert.equal(projected.invoiceId, INVOICE_ID);
  assert.equal(projected.status, "SENT");
  assert.deepEqual(projected.actions, { canReview: true, canPayOnline: false });
  const serialized = JSON.stringify(projected);
  for (const forbidden of [
    "currentVersion", "lineItemId", "sourceQuoteId", "sourceQuoteVersion",
    "integrityHash", "idempotency", "issuerParticipant", "costMinor",
    "marginMinor", "markupMinor", "Home Depot", "processorReference",
  ]) assert.equal(serialized.includes(forbidden), false, forbidden);
});
test("professional Invoice projection exposes only bounded command safety state", () => {
  const projected = invoicePaymentInternals.invoiceProjection(invoiceRow(), [line], [], "professional");
  assert.equal(projected.currentVersion, 2);
  assert.equal(projected.actions.canIssue, false);
  assert.equal(projected.actions.canRecordPayment, true);
  assert.equal(projected.actions.canShareExternal, true);
  assert.equal(projected.lineItems[0].sourceQuoteId, line.source_quote_id);
});

test("Invoice Conversation snapshot is customer-safe and exact-identity bound", () => {
  const invoice = invoicePaymentInternals.invoiceProjection(invoiceRow(), [line], [], "professional");
  const snapshot = invoicePaymentInternals.invoiceMessageSnapshot(invoice);
  const row = {
    id: 501,
    sender_id: 65,
    receiver_id: 64,
    message_text: "BGone Services shared an Invoice.",
    message_type: "invoice_shared",
    workflow_type: "INVOICE_SHARED",
    workflow_status: "SENT",
    workflow_payload: snapshot,
    invoice_id: INVOICE_ID,
    job_id: JOB_ID,
    created_at: "2026-08-15T12:00:00.000Z",
  };
  assert.deepEqual(normalizeInvoiceSharedPayload(row), snapshot);
  const message = serializeConversationMessage(row, 64);
  assert.deepEqual(message.reference, {
    type: "invoice", invoiceId: INVOICE_ID, jobId: JOB_ID,
  });
  assert.equal(message.workflow.payload.invoiceId, INVOICE_ID);
});

test("Invoice Conversation serializer fails closed on identity mismatch", () => {
  const invoice = invoicePaymentInternals.invoiceProjection(invoiceRow(), [line], [], "professional");
  const row = {
    message_type: "invoice_shared",
    workflow_type: "INVOICE_SHARED",
    workflow_status: "SENT",
    workflow_payload: invoicePaymentInternals.invoiceMessageSnapshot(invoice),
    invoice_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    job_id: JOB_ID,
  };
  assert.deepEqual(normalizeInvoiceSharedPayload(row), {});
});
