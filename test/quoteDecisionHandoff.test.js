"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  deriveQuoteDepositGate,
} = require("../server/authorization/quoteDecisionHandoff");
const {
  createProfessionalQuoteDecisionAlertWithClient,
} = require("../server/conversations/conversationMessageService");

const QUOTE_ID = "f08a4f3b-8a21-4da8-a6b0-4258f5a8df9b";
const JOB_ID = "072c8736-5d97-4253-ba3e-dd1bce281a20";
const DECISION_ID = "a3135bd1-0d52-44e8-a84b-359f09be3af9";

test("canonical percentage deposit terms derive an exact unpaid gate", () => {
  assert.deepEqual(deriveQuoteDepositGate({
    customerTermsSnapshot: { paymentTerms: "75% deposit" },
    totalMinor: 68000,
  }), {
    state: "DEPOSIT_DUE",
    paymentTerms: "75% deposit",
    percent: 75,
    dueMinor: 51000,
    remainingMinor: 17000,
  });
  assert.equal(deriveQuoteDepositGate({
    customerTermsSnapshot: { paymentTerms: "Deposit due on approval" },
    totalMinor: 68000,
  }).state, "DEPOSIT_TERMS_UNVERIFIED");
  assert.equal(deriveQuoteDepositGate({
    customerTermsSnapshot: { paymentTerms: "Balance due on completion" },
    totalMinor: 68000,
  }).state, "NONE");
});

test("approved decision creates one bounded professional alert with resource-only navigation", async () => {
  const calls = [];
  const client = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (/UPDATE alerts/.test(sql)) return { rows: [] };
      assert.match(sql, /INSERT INTO alerts/);
      return { rows: [{
        id: 91,
        recipient_user_id: 24,
        source_domain: "commercial",
        source_event_type: "quote.customer_approved",
        source_entity_type: "quote",
        source_entity_id: QUOTE_ID,
        source_event_id: DECISION_ID,
        category: "proposal",
        priority: "high",
        title_key: "alerts.commercial.quoteApproved.title",
        message_key: "alerts.commercial.quoteApproved.message",
        safe_payload: JSON.parse(values[11]),
        destination_type: "conversation",
        destination_payload: JSON.parse(values[13]),
        dedupe_key: values[14],
        lifecycle_state: "active",
        available_at: "2026-08-28T14:00:00.000Z",
        expires_at: null,
        read_at: null,
        dismissed_at: null,
        resolved_at: null,
        archived_at: null,
        created_at: "2026-08-28T14:00:00.000Z",
        updated_at: "2026-08-28T14:00:00.000Z",
      }] };
    },
  };
  const result = await createProfessionalQuoteDecisionAlertWithClient({
    client,
    context: {
      professional_user_id: 24,
      customer_user_id: 17,
      customer_display_name: "Antony Guzman",
      job_title: "Inspect damaged cabinet door and trim",
    },
    quote: {
      id: QUOTE_ID,
      jobId: JOB_ID,
      currentVersion: 2,
      documentNumber: "Q-0000001",
      totalMinor: 68000,
      currency: "USD",
      customerTermsSnapshot: { paymentTerms: "75% deposit" },
    },
    decisionRow: {
      id: DECISION_ID,
      decision: "APPROVED",
      issued_quote_version: 2,
      decided_at: "2026-08-28T14:00:00.000Z",
    },
    delivery: { conversation_id: 342 },
  });
  assert.deepEqual(result, { alertId: "91", created: true });
  assert.equal(calls.length, 2);
  assert.match(calls[0].sql, /UPDATE alerts/);
  const inserted = calls[1].values;
  assert.deepEqual(JSON.parse(inserted[11]), {
    shortPreview: "Inspect damaged cabinet door and trim",
    projectTitle: "Inspect damaged cabinet door and trim",
    customerLabel: "Antony Guzman",
    quoteNumber: "Q-0000001",
    quoteTotalMinor: 68000,
    currency: "USD",
    decision: "APPROVED",
    issuedQuoteVersion: 2,
    depositState: "DEPOSIT_DUE",
    depositPercent: 75,
    depositDueMinor: 51000,
    remainingMinor: 17000,
  });
  assert.deepEqual(JSON.parse(inserted[13]), {
    conversationId: 342,
    jobId: JOB_ID,
    quoteId: QUOTE_ID,
  });
  assert.match(inserted[14], /version:2:decision:APPROVED:professional:24$/);
});

test("declined decision preserves one durable professional Alert and resolves exact customer delivery", async () => {
  const calls = [];
  const client = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (/UPDATE alerts/.test(sql)) return { rows: [] };
      return { rows: [{
        id: 92,
        recipient_user_id: 24,
        source_domain: "commercial",
        source_event_type: "quote.customer_declined",
        source_entity_type: "quote",
        source_entity_id: QUOTE_ID,
        source_event_id: DECISION_ID,
        canonical_event_key: values[6],
        category: "proposal",
        priority: "high",
        title_key: values[9],
        message_key: values[10],
        safe_payload: JSON.parse(values[11]),
        destination_type: values[12],
        destination_payload: JSON.parse(values[13]),
        dedupe_key: values[14],
        lifecycle_state: "active",
        available_at: "2026-08-28T14:00:00.000Z",
        expires_at: null,
        read_at: null,
        dismissed_at: null,
        resolved_at: null,
        archived_at: null,
        created_at: "2026-08-28T14:00:00.000Z",
        updated_at: "2026-08-28T14:00:00.000Z",
      }] };
    },
  };

  const result = await createProfessionalQuoteDecisionAlertWithClient({
    client,
    context: {
      professional_user_id: 24,
      customer_user_id: 17,
      customer_display_name: "Customer",
      job_title: "Customer project",
    },
    quote: {
      id: QUOTE_ID,
      jobId: JOB_ID,
      currentVersion: 2,
      documentNumber: "Q-0000001",
      totalMinor: 68000,
      currency: "USD",
      customerTermsSnapshot: {},
    },
    decisionRow: {
      id: DECISION_ID,
      decision: "DECLINED",
      issued_quote_version: 2,
      decided_at: "2026-08-28T14:00:00.000Z",
    },
    delivery: { conversation_id: 342 },
  });

  assert.deepEqual(result, { alertId: "92", created: true });
  assert.match(calls[0].sql, /UPDATE alerts/);
  assert.deepEqual(calls[0].values.slice(0, 5), [
    "commercial",
    "quote",
    QUOTE_ID,
    "quote.delivered",
    17,
  ]);
  assert.equal(calls[1].values[2], "quote.customer_declined");
  assert.match(calls[1].values[6], /^[0-9a-f]{64}$/);
  assert.equal(calls[1].values[12], "conversation");
});

test("mismatched decision identity fails before creating professional attention", async () => {
  let queried = false;
  await assert.rejects(
    createProfessionalQuoteDecisionAlertWithClient({
      client: { async query() { queried = true; return { rows: [] }; } },
      context: { professional_user_id: 24 },
      quote: {
        id: QUOTE_ID,
        jobId: JOB_ID,
        currentVersion: 2,
        totalMinor: 68000,
        currency: "USD",
      },
      decisionRow: {
        id: DECISION_ID,
        decision: "APPROVED",
        issued_quote_version: 1,
      },
      delivery: { conversation_id: 342 },
    }),
    /decision attention identity/
  );
  assert.equal(queried, false);
});
