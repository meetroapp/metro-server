"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  normalizePaymentLifecyclePayload,
  normalizePaymentReminderPayload,
  serializeConversationMessage,
} = require("../server/conversations/conversations");
const {
  invoicePaymentInternals,
} = require("../server/finance/invoicePaymentService");

const QUOTE_ID = "44444444-4444-4444-8444-444444444444";
const JOB_ID = "22222222-2222-4222-8222-222222222222";

function row(messageType, payload) {
  return {
    id: 601,
    sender_id: 65,
    receiver_id: 64,
    message_text: "Payment update",
    image_url: null,
    message_type: messageType,
    workflow_type: messageType === "payment_request" ? "PAYMENT_REQUEST" : "PAYMENT_RECEIVED",
    workflow_status: "SENT",
    workflow_payload: payload,
    quote_id: null,
    job_id: null,
    created_at: "2026-08-29T16:00:00.000Z",
  };
}

test("Payment Request projection preserves approved $680/$510 commercial terms without receipt evidence", () => {
  const payload = {
    schemaVersion: 1, quoteId: QUOTE_ID, jobId: JOB_ID, issuedQuoteVersion: 13,
    state: "PAYMENT_REQUIRED", currency: "USD", quoteTotalMinor: 68000,
    requiredMinor: 51000, receivedMinor: 0, remainingMinor: 51000,
    balanceRemainingMinor: 17000,
    paymentTerms: "75% deposit required before scheduling. Remaining balance due upon completion.",
    payment: null,
  };
  assert.deepEqual(normalizePaymentLifecyclePayload(row("payment_request", payload)), payload);
  const message = serializeConversationMessage(row("payment_request", payload), 64);
  assert.deepEqual(message.reference, { type: "payment", quoteId: QUOTE_ID, jobId: JOB_ID });
  assert.equal(message.workflow.payload.receivedMinor, 0);
});

test("explicit Deposit Request delivery preserves exact document and requirement identity", () => {
  const payload = {
    schemaVersion: 1,
    depositRequestDocumentId: "66666666-6666-4666-8666-666666666666",
    depositRequestReference: "WDR-ABCDEF12",
    paymentRequirementId: "77777777-7777-4777-8777-777777777777",
    quoteId: QUOTE_ID,
    jobId: JOB_ID,
    issuedQuoteVersion: 13,
    state: "PAYMENT_REQUIRED",
    currency: "USD",
    quoteTotalMinor: 68000,
    requiredMinor: 51000,
    receivedMinor: 0,
    remainingMinor: 51000,
    balanceRemainingMinor: 17000,
    paymentTerms: "Pay by check.",
    payment: null,
  };
  const normalized = normalizePaymentLifecyclePayload(row("payment_request", payload));
  assert.equal(normalized.depositRequestDocumentId, payload.depositRequestDocumentId);
  assert.equal(normalized.paymentRequirementId, payload.paymentRequirementId);
  assert.equal(normalized.depositRequestReference, payload.depositRequestReference);
});

test("partial $200 then cumulative $510 Payment projections preserve remaining deposit", () => {
  const base = {
    schemaVersion: 1, quoteId: QUOTE_ID, jobId: JOB_ID, issuedQuoteVersion: 13,
    currency: "USD", quoteTotalMinor: 68000, requiredMinor: 51000,
    paymentTerms: "75% deposit required before scheduling.",
  };
  const partial = normalizePaymentLifecyclePayload(row("payment_received", {
    ...base, state: "PARTIALLY_RECEIVED", receivedMinor: 20000, remainingMinor: 31000,
    balanceRemainingMinor: 48000,
    payment: { receiptId: "receipt-1", grossAmountMinor: 20000, allocatedMinor: 20000, displayMethod: "Venmo", receivedAt: "2026-08-29T16:00:00.000Z", externalReference: null },
  }));
  assert.equal(partial.remainingMinor, 31000);
  const satisfied = normalizePaymentLifecyclePayload(row("payment_received", {
    ...base, state: "DEPOSIT_RECEIVED", receivedMinor: 51000, remainingMinor: 0,
    balanceRemainingMinor: 17000,
    payment: { receiptId: "receipt-2", grossAmountMinor: 31000, allocatedMinor: 31000, displayMethod: "Check", receivedAt: "2026-08-29T17:00:00.000Z", externalReference: null },
  }));
  assert.equal(satisfied.remainingMinor, 0);
});


test("Payment Reminder conversation projection remains separate from Payment evidence", () => {
  const reminderId =
    "88888888-8888-4888-8888-888888888888";
  const invoiceId =
    "11111111-1111-4111-8111-111111111111";

  const payload = {
    schemaVersion: 1,
    reminderId,
    sourceType: "INVOICE",
    invoiceId,
    paymentRequirementId: null,
    jobId: JOB_ID,
    sourceVersion: 3,
    classification: "OVERDUE",
    classifiedOn: "2026-09-02",
    timeZone: "America/New_York",
    currency: "USD",
    amountMinor: 17000,
    due: {
      mode: "SPECIFIC_DATE",
      date: "2026-08-31",
      effectiveDate: "2026-08-31",
    },
  };

  const reminderRow = {
    id: 777,
    sender_id: 65,
    receiver_id: 64,
    message_text:
      "Payment reminder: $170.00 remains due.",
    image_url: null,
    message_type: "payment_reminder",
    workflow_type: "PAYMENT_REMINDER",
    workflow_status: "SENT",
    workflow_payload: payload,
    quote_id: null,
    invoice_id: null,
    job_id: null,
    created_at: "2026-09-02T22:00:00.000Z",
  };

  assert.deepEqual(
    normalizePaymentReminderPayload(reminderRow),
    payload
  );

  const message =
    serializeConversationMessage(reminderRow, 64);

  assert.deepEqual(message.reference, {
    type: "payment_reminder",
    sourceType: "INVOICE",
    invoiceId,
    paymentRequirementId: null,
    jobId: JOB_ID,
  });

  assert.equal(
    message.workflow.payload.amountMinor,
    17000
  );

  assert.equal(
    Object.hasOwn(message.workflow.payload, "payment"),
    false
  );
});

test("Deposit Reminder projection preserves only canonical remaining amount", () => {
  const paymentRequirementId =
    "77777777-7777-4777-8777-777777777777";

  const payload = {
    schemaVersion: 1,
    reminderId:
      "99999999-9999-4999-8999-999999999999",
    sourceType: "DEPOSIT",
    invoiceId: null,
    paymentRequirementId,
    jobId: JOB_ID,
    sourceVersion: 2,
    classification: "DEPOSIT_REMAINING",
    classifiedOn: "2026-09-02",
    timeZone: "America/New_York",
    currency: "USD",
    amountMinor: 31000,
    due: null,
  };

  const row = {
    id: 778,
    sender_id: 65,
    receiver_id: 64,
    message_text:
      "Payment reminder: $310.00 of the deposit remains due.",
    image_url: null,
    message_type: "payment_reminder",
    workflow_type: "PAYMENT_REMINDER",
    workflow_status: "SENT",
    workflow_payload: payload,
    quote_id: null,
    invoice_id: null,
    job_id: null,
    created_at: "2026-09-02T22:01:00.000Z",
  };

  assert.deepEqual(
    normalizePaymentReminderPayload(row),
    payload
  );
});

test("approved Payment terms become server-owned Invoice terms and conflicts fail closed", () => {
  assert.deepEqual(invoicePaymentInternals.effectiveApprovedPaymentTerms([
    { customer_terms_snapshot: { paymentTerms: "75% deposit. Balance due on completion." } },
    { customer_terms_snapshot: { paymentTerms: "75% deposit. Balance due on completion." } },
  ]), { error: false, terms: "75% deposit. Balance due on completion." });
  assert.equal(invoicePaymentInternals.effectiveApprovedPaymentTerms([
    { customer_terms_snapshot: { paymentTerms: "75% deposit." } },
    { customer_terms_snapshot: { paymentTerms: "Due on receipt." } },
  ]).error, true);
});

test("final Invoice preserves $680 total, $510 received, and prominent $170 balance truth", () => {
  const invoice = invoicePaymentInternals.invoiceProjection({
    invoice_id: "11111111-1111-4111-8111-111111111111",
    invoice_number: "INV-111111111111",
    job_id: JOB_ID,
    job_request_id: 14,
    relationship_id: 9,
    conversation_id: 340,
    business_name: "BGone Services",
    customer_name: "Antony Guzman",
    job_title: "Cabinet repair",
    job_service: "Carpentry",
    status: "DRAFT",
    currency: "USD",
    invoice_date: "2026-08-29",
    due_mode: "DUE_ON_RECEIPT",
    due_date: null,
    subtotal_minor: 68000,
    total_minor: 68000,
    paid_minor: 51000,
    balance_minor: 17000,
    customer_notes: null,
    terms: "75% deposit required before scheduling. Remaining balance due upon completion.",
    issued_at: null,
    version: 1,
  }, [], [], "professional");
  assert.equal(invoice.totalMinor, 68000);
  assert.equal(invoice.paidMinor, 51000);
  assert.equal(invoice.balanceMinor, 17000);
  assert.match(invoice.terms, /75% deposit/);
  assert.equal(invoice.status, "DRAFT");
});

test("Invoice Send accepts an editable message only inside the idempotent issue command", () => {
  const { readFileSync } = require("node:fs");
  const source = readFileSync(require.resolve("../server/finance/invoicePaymentService"), "utf8");
  assert.match(source, /\["invoiceId", "expectedVersion", "messageText", "idempotencyKey"\]/);
  assert.match(source, /command: "invoice\.issue"[\s\S]*messageText/);
  assert.match(source, /messageText \|\| `\$\{context\.business_name/);
});

test("Payment lifecycle messages obey the existing ordinary-message storage constraint", () => {
  const { readFileSync } = require("node:fs");
  const source = readFileSync(require.resolve("../server/conversations/conversationMessageService"), "utf8");
  const insert = source.slice(
    source.indexOf("conversation_message:payment_lifecycle"),
    source.indexOf("RETURNING *", source.indexOf("conversation_message:payment_lifecycle"))
  );
  assert.match(insert, /workflow_payload/);
  assert.doesNotMatch(insert, /quote_id|job_id|invoice_id/);
});
