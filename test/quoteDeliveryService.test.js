"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  quoteDeliveryInternals,
} = require("../server/authorization/quoteDeliveryService");
const {
  quoteDraftServiceInternals,
} = require("../server/authorization/quoteDraftService");
const {
  serializeConversationMessage,
} = require("../server/conversations/conversations");

const QUOTE_ID = "11111111-1111-4111-8111-111111111111";
const JOB_ID = "22222222-2222-4222-8222-222222222222";
const ISSUED_AT = "2026-08-14T14:00:00.000Z";
const HASH = "a".repeat(64);

function issuedQuote(overrides = {}) {
  const currentVersion = overrides.currentVersion || 3;
  return {
    id: QUOTE_ID,
    jobId: JOB_ID,
    status: "ISSUED",
    issuedAt: ISSUED_AT,
    currency: "USD",
    currentVersion,
    totalMinor: 92000,
    materialsSubtotalMinor: 0,
    laborServiceSubtotalMinor: 92000,
    scopeItems: [{
      scopeItemId: "44444444-4444-4444-8444-444444444444",
      scopeItemRevision: 1,
      sequence: 1,
      classification: "LABOR_SERVICE",
      scopeSemantic: "FUTURE_WORK",
      materialResponsibility: "NOT_APPLICABLE",
      description: "Replace disposal",
      quantity: 1,
      unitAmountMinor: 92000,
      lineTotalMinor: 92000,
      includedInTotal: true,
      source: { type: "MANUAL_PROFESSIONAL" },
      materialCostMinor: 41000,
      laborCostMinor: 51000,
      markupMinor: 12000,
      marginMinor: 19000,
      retailerReference: "Home Depot sentinel",
      askMeetroAssumption: "private sentinel",
      professionalNotes: "internal sentinel",
      futureField: "must not leak",
    }],
    conditions: [{ description: "Valid for 30 days", internal: "sentinel" }],
    exclusions: [{ description: "Permit fees", internal: "sentinel" }],
    lineageType: null,
    decisionState: null,
    decidedAt: null,
    versions: [{
      version: currentVersion,
      status: "ISSUED",
      issuedAt: ISSUED_AT,
      integrityHash: HASH,
      materialsSubtotalMinor: 0,
      laborServiceSubtotalMinor: 92000,
      totalMinor: 92000,
      scopeItemCount: 1,
      conditions: [{ description: "Valid for 30 days", internal: "sentinel" }],
      exclusions: [{ description: "Permit fees", internal: "sentinel" }],
    }],
    ...overrides,
  };
}

function validQuote(overrides = {}) {
  const quote = issuedQuote({ conditions: [], exclusions: [], ...overrides });
  const current = quote.versions[0];
  current.conditions = [];
  current.exclusions = [];
  current.integrityHash = quoteDraftServiceInternals.integrityHash({
    quoteId: quote.id,
    version: quote.currentVersion,
    currency: quote.currency,
    status: current.status,
    issuedAt: current.issuedAt,
    totals: {
      materialsSubtotalMinor: 0,
      laborServiceSubtotalMinor: 92000,
      totalMinor: 92000,
    },
    snapshots: quote.scopeItems,
    conditions: [],
    exclusions: [],
  });
  return quote;
}

function issuance(hash = HASH, overrides = {}) {
  return {
    quote_version: 3,
    issued_at: ISSUED_AT,
    source_snapshot_integrity_hash: hash,
    ...overrides,
  };
}

const deliveryContext = {
  conversation_id: 17,
  conversation_relationship_id: 9,
  homeowner_id: 64,
  professional_user_id: 65,
  conversation_status: "active",
  business_name: "Handyman LLC",
  job_title: "Kitchen repair",
  job_service: "handyman",
};

test("issued Quote eligibility requires matching current issuance integrity", () => {
  const quote = validQuote();
  const hash = quote.versions[0].integrityHash;
  assert.equal(quoteDeliveryInternals.validIssuedQuote(quote, issuance(hash)), true);
  assert.equal(quoteDeliveryInternals.validIssuedQuote({ ...quote, status: "DRAFT", issuedAt: null }, issuance(hash)), false);
  assert.equal(quoteDeliveryInternals.validIssuedQuote(quote, issuance(hash, { quote_version: 2 })), false);
  assert.equal(quoteDeliveryInternals.validIssuedQuote(quote, issuance("b".repeat(64))), false);
  assert.equal(quoteDeliveryInternals.validIssuedQuote({ ...quote, versions: [] }, issuance(hash)), false);
  assert.equal(quoteDeliveryInternals.validIssuedQuote({
    ...quote,
    scopeItems: [{ ...quote.scopeItems[0], description: "Tampered scope" }],
  }, issuance(hash)), false);
});

test("server-owned delivery snapshot allowlists customer-safe Quote truth", () => {
  const snapshot = quoteDeliveryInternals.buildSafeSnapshot(issuedQuote(), deliveryContext);
  assert.deepEqual(snapshot, {
    schemaVersion: 1,
    quoteId: QUOTE_ID,
    jobId: JOB_ID,
    lineageLabel: "Original",
    businessStatus: "WAITING_ON_CUSTOMER",
    totalMinor: 92000,
    currency: "USD",
    scopeItems: [{ description: "Replace disposal", quantity: 1, amountMinor: 92000 }],
    conditions: ["Valid for 30 days"],
    exclusions: [{ description: "Permit fees", quantity: 1 }],
    issuedAt: ISSUED_AT,
    decidedAt: null,
    business: { displayName: "Handyman LLC" },
    job: { title: "Kitchen repair", service: "handyman" },
  });
  const serialized = JSON.stringify(snapshot);
  for (const forbidden of [
    "materialCostMinor", "laborCostMinor", "markupMinor", "marginMinor",
    "Home Depot", "askMeetroAssumption", "professionalNotes", "futureField",
    "authority", "grant", "integrityHash", "currentVersion",
  ]) assert.equal(serialized.includes(forbidden), false, forbidden);
});

test("issued Original, Revised, Additional, Approved, and Declined truth remains shareable", () => {
  const cases = [
    [null, null, "Original", "WAITING_ON_CUSTOMER"],
    ["REVISED_QUOTE", null, "Revised", "WAITING_ON_CUSTOMER"],
    ["SUPPLEMENTAL_QUOTE", null, "Additional", "WAITING_ON_CUSTOMER"],
    [null, "APPROVED", "Original", "APPROVED"],
    [null, "DECLINED", "Original", "DECLINED"],
  ];
  for (const [lineageType, decisionState, lineageLabel, businessStatus] of cases) {
    const snapshot = quoteDeliveryInternals.buildSafeSnapshot(
      issuedQuote({ lineageType, decisionState }),
      deliveryContext
    );
    assert.equal(snapshot.lineageLabel, lineageLabel);
    assert.equal(snapshot.businessStatus, businessStatus);
  }
});

test("send authority is exact to active Conversation participants", () => {
  assert.equal(quoteDeliveryInternals.hasSendAuthority(deliveryContext, 65), true);
  assert.equal(quoteDeliveryInternals.hasSendAuthority({ ...deliveryContext, conversation_status: "closed" }, 65), false);
  assert.equal(quoteDeliveryInternals.hasSendAuthority({ ...deliveryContext, professional_user_id: 66 }, 65), false);
  assert.equal(quoteDeliveryInternals.hasSendAuthority({ ...deliveryContext, conversation_id: null }, 65), false);
});

test("shared professional Quote authority rejects an inactive exact relationship", async () => {
  const result = await quoteDraftServiceInternals.requireQuoteAuthority({
    client: { query() { throw new Error("inactive authority must fail before grants"); } },
    context: {
      lifecycle_contract_version: 2,
      relationship_status: "closed",
      job_id: JOB_ID,
      actor_participant_id: "33333333-3333-4333-8333-333333333333",
      selected_professional_user_id: 65,
      actor_user_id: 65,
      actor_is_primary_professional: true,
    },
    capability: "quote.read",
    logger: { info() {}, warn() {} },
  });
  assert.equal(result.code, "QUOTE_CONTEXT_INACTIVE");
});

test("Quote-share Conversation serialization strips every non-allowlisted field", () => {
  const snapshot = {
    ...quoteDeliveryInternals.buildSafeSnapshot(issuedQuote(), deliveryContext),
    materialCostMinor: 41000,
    grants: [{ capability: "quote.read" }],
    futureSentinel: "do-not-leak",
    business: { displayName: "Handyman LLC", internalProfileId: 6 },
    job: { title: "Kitchen repair", service: "handyman", relationshipId: 9 },
  };
  const message = serializeConversationMessage({
    id: 71,
    sender_id: 65,
    receiver_id: 64,
    message_text: "Handyman LLC shared a Quote.",
    image_url: null,
    message_type: "quote_shared",
    workflow_type: "QUOTE_SHARED",
    workflow_status: "SENT",
    workflow_payload: snapshot,
    quote_id: QUOTE_ID,
    job_id: JOB_ID,
    created_at: ISSUED_AT,
  }, 64);
  assert.equal(message.workflow.payload.quoteId, QUOTE_ID);
  assert.deepEqual(message.reference, { type: "quote", quoteId: QUOTE_ID, jobId: JOB_ID });
  const serialized = JSON.stringify(message);
  for (const forbidden of ["materialCostMinor", "grants", "futureSentinel", "internalProfileId", "relationshipId"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("ordinary text serialization remains unchanged", () => {
  assert.deepEqual(serializeConversationMessage({
    id: 72,
    sender_id: 64,
    receiver_id: 65,
    message_text: "Ordinary message",
    image_url: null,
    message_type: "text",
    workflow_type: null,
    workflow_status: null,
    workflow_payload: {},
    created_at: ISSUED_AT,
  }, 64), {
    id: 72,
    sender: { id: 64, isViewer: true },
    recipient: { id: 65 },
    content: { text: "Ordinary message", imageUrl: null, type: "text" },
    workflow: { type: null, status: null, payload: {} },
    createdAt: ISSUED_AT,
  });
});
