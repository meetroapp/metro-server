"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  quoteDraftServiceInternals,
} = require("../server/authorization/quoteDraftService");

const { customerQuoteDetailProjection } = quoteDraftServiceInternals;

const IDS = Object.freeze({
  quote: "10000000-0000-4000-8000-000000000001",
  job: "20000000-0000-4000-8000-000000000002",
  parent: "30000000-0000-4000-8000-000000000003",
});

function internalQuote(overrides = {}) {
  return {
    id: IDS.quote,
    jobId: IDS.job,
    requestId: 16,
    relationshipId: 21,
    issuerParticipantId: "40000000-0000-4000-8000-000000000004",
    parentQuoteId: null,
    lineageType: null,
    lineageReasonCategory: null,
    status: "ISSUED",
    issuedAt: "2026-08-12T12:00:00.000Z",
    currency: "USD",
    currentVersion: 7,
    materialsSubtotalMinor: 12000,
    laborServiceSubtotalMinor: 18000,
    totalMinor: 30000,
    scopeItemCount: 2,
    conditions: [
      "Customer provides site access.",
      { description: "Hidden damage may require a revised Quote.", grantId: "private" },
      { internalNotes: "professional-only" },
    ],
    exclusions: [
      { sourceType: "RECOMMENDATION", sourceRecommendationId: "private" },
      { description: "Permit fees are excluded.", integrityHash: "private" },
    ],
    scopeItems: [
      {
        scopeItemId: "50000000-0000-4000-8000-000000000005",
        description: "Replace damaged cabinet base",
        quantity: 2,
        unitAmountMinor: 15000,
        lineTotalMinor: 30000,
        includedInTotal: true,
        classification: "LABOR_SERVICE",
        materialResponsibility: "NOT_APPLICABLE",
        source: {
          type: "RECOMMENDATION",
          recommendationId: "60000000-0000-4000-8000-000000000006",
          version: 3,
        },
        sentinelFutureColumn: "private",
      },
      {
        scopeItemId: "70000000-0000-4000-8000-000000000007",
        description: "Wall repair beyond visible water damage",
        quantity: 1,
        unitAmountMinor: 50000,
        lineTotalMinor: 50000,
        includedInTotal: false,
        classification: "LABOR_SERVICE",
        source: { type: "FINDING", findingId: "private", version: 1 },
      },
    ],
    versions: [
      {
        version: 7,
        integrityHash: "private-integrity",
        createdByParticipantId: "private-actor",
      },
    ],
    decisionState: null,
    decisionVersion: null,
    decidedAt: null,
    authoritySource: "authorization_engine",
    idempotencyId: "private-idempotency",
    requestFingerprint: "private-fingerprint",
    markup: 20,
    margin: 15,
    capabilities: ["quote.approve"],
    askMeetroEstimatingAssumptions: "private-advisory-context",
    retailerReferencePricing: { retailer: "Home Depot", amountMinor: 9999 },
    internalNotes: "private",
    futureArbitraryDatabaseField: "private",
    ...overrides,
  };
}

function keysDeep(value, result = new Set()) {
  if (!value || typeof value !== "object") return result;
  if (Array.isArray(value)) {
    value.forEach((item) => keysDeep(item, result));
    return result;
  }
  for (const [key, child] of Object.entries(value)) {
    result.add(key);
    keysDeep(child, result);
  }
  return result;
}

test("customer Quote detail is an exact allowlist with safe pending decision support", () => {
  const detail = customerQuoteDetailProjection(internalQuote(), {
    canApprove: true,
    canDecline: true,
  });

  assert.deepEqual(Object.keys(detail), [
    "quoteId",
    "jobId",
    "status",
    "businessStatus",
    "customerDecision",
    "lineageLabel",
    "totalMinor",
    "currency",
    "scopeItems",
    "conditions",
    "exclusions",
    "issuedAt",
    "decidedAt",
    "decisionCommandVersion",
    "actions",
  ]);
  assert.deepEqual(detail, {
    quoteId: IDS.quote,
    jobId: IDS.job,
    status: "ISSUED",
    businessStatus: "WAITING_ON_CUSTOMER",
    customerDecision: null,
    lineageLabel: "Original",
    totalMinor: 30000,
    currency: "USD",
    scopeItems: [
      {
        description: "Replace damaged cabinet base",
        quantity: 2,
        amountMinor: 30000,
      },
    ],
    conditions: [
      "Customer provides site access.",
      "Hidden damage may require a revised Quote.",
    ],
    exclusions: [
      { description: "Wall repair beyond visible water damage", quantity: 1 },
      { description: "Permit fees are excluded.", quantity: 1 },
    ],
    issuedAt: "2026-08-12T12:00:00.000Z",
    decidedAt: null,
    decisionCommandVersion: 7,
    actions: {
      canViewQuote: true,
      canApprove: true,
      canDecline: true,
    },
  });
});

test("customer Quote detail strips every internal and future sentinel recursively", () => {
  const detail = customerQuoteDetailProjection(internalQuote(), {
    canApprove: true,
    canDecline: true,
  });
  const exposedKeys = keysDeep(detail);
  for (const forbidden of [
    "authoritySource",
    "relationshipId",
    "issuerParticipantId",
    "materialsSubtotalMinor",
    "laborServiceSubtotalMinor",
    "unitAmountMinor",
    "markup",
    "margin",
    "capabilities",
    "askMeetroEstimatingAssumptions",
    "retailerReferencePricing",
    "integrityHash",
    "grantId",
    "grants",
    "idempotencyId",
    "requestFingerprint",
    "createdByParticipantId",
    "versions",
    "source",
    "sourceType",
    "sourceRecommendationId",
    "internalNotes",
    "sentinelFutureColumn",
    "futureArbitraryDatabaseField",
  ]) {
    assert.equal(exposedKeys.has(forbidden), false, forbidden);
  }
});

test("terminal customer decisions disable actions and derived lineage uses safe labels", () => {
  for (const [decision, lineageType, lineageLabel] of [
    ["APPROVED", null, "Original"],
    ["DECLINED", "REVISED_QUOTE", "Revised"],
    ["APPROVED", "SUPPLEMENTAL_QUOTE", "Additional"],
  ]) {
    const detail = customerQuoteDetailProjection(internalQuote({
      parentQuoteId: lineageType ? IDS.parent : null,
      lineageType,
      decisionState: decision,
      decisionVersion: 7,
      decidedAt: "2026-08-13T12:00:00.000Z",
    }), {
      canApprove: true,
      canDecline: true,
    });
    assert.equal(detail.businessStatus, decision);
    assert.equal(detail.customerDecision, decision);
    assert.equal(detail.lineageLabel, lineageLabel);
    assert.deepEqual(detail.actions, {
      canViewQuote: true,
      canApprove: false,
      canDecline: false,
    });
  }
});

test("Draft Quotes cannot be serialized through the customer detail projection", () => {
  assert.equal(
    customerQuoteDetailProjection(internalQuote({
      status: "DRAFT",
      issuedAt: null,
    })),
    null
  );
});
