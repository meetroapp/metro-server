"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const service = require("../server/authorization/quoteDraftService");
const { quoteDeliveryInternals } = require("../server/authorization/quoteDeliveryService");

const { quoteDraftServiceInternals: internals } = service;
const quoteId = "11111111-1111-4111-8111-111111111111";
const jobId = "22222222-2222-4222-8222-222222222222";
const issuedAt = "2026-08-14T14:00:00.000Z";
const scope = [{
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
}];
const totals = {
  materialsSubtotalMinor: 0,
  laborServiceSubtotalMinor: 92000,
  totalMinor: 92000,
};
const rawTerms = {
  schemaVersion: 1,
  paymentTerms: " 50% deposit, balance on completion. ",
  estimatedDuration: " 3 days ",
  customerNotes: " Protect the existing landscaping. ",
  agreement: {
    exclusions: [" Permit fees ", " Hidden damage "],
    additionalWorkTerms: " Written approval required. ",
    warrantyTerms: " One-year workmanship warranty. ",
  },
};
const normalizedTerms = {
  schemaVersion: 1,
  paymentTerms: "50% deposit, balance on completion.",
  estimatedDuration: "3 days",
  customerNotes: "Protect the existing landscaping.",
  agreement: {
    exclusions: ["Permit fees", "Hidden damage"],
    additionalWorkTerms: "Written approval required.",
    hiddenConditionsTerms: "",
    diagnosticTerms: "",
    customerResponsibilities: "",
    warrantyTerms: "One-year workmanship warranty.",
    cancellationTerms: "",
    acceptanceTerms: "",
    preauthorizedAdditionalWorkLimit: "",
  },
};

function hash(customerTermsSnapshot = null, integrityVersion = 1) {
  return internals.integrityHash({
    quoteId,
    version: 3,
    currency: "USD",
    status: "ISSUED",
    issuedAt,
    totals,
    snapshots: scope,
    conditions: [],
    exclusions: [],
    integrityVersion,
    customerTermsSnapshot,
  });
}

test("legacy Quote v1 integrity hash remains byte-for-byte compatible", () => {
  assert.equal(
    hash(),
    "c62d98ad0a8edcf5ea156621ca564ce97fb9200b22d9f32dc1cb2fc70f4adf74"
  );
  assert.equal(hash(), internals.integrityHash({
    quoteId,
    version: 3,
    currency: "USD",
    status: "ISSUED",
    issuedAt,
    totals,
    snapshots: scope,
    conditions: [],
    exclusions: [],
  }));
});

test("customer terms normalize to one deterministic strict snapshot", () => {
  assert.deepEqual(internals.normalizeCustomerTermsSnapshot(rawTerms), {
    snapshot: normalizedTerms,
  });
  assert.deepEqual(
    internals.normalizeCustomerTermsSnapshot(normalizedTerms),
    { snapshot: normalizedTerms }
  );
  assert.equal(hash(rawTerms, 2), hash(normalizedTerms, 2));
});

test("unknown authority fields and malformed supplied terms fail closed", async () => {
  for (const candidate of [
    { ...rawTerms, approvalState: "APPROVED" },
    { ...rawTerms, paymentState: "PAID" },
    { ...rawTerms, agreement: { ...rawTerms.agreement, lifecycleStatus: "COMPLETE" } },
    { ...rawTerms, estimatedDuration: 3 },
    { ...rawTerms, agreement: { ...rawTerms.agreement, exclusions: "Permit fees" } },
  ]) {
    assert.equal(
      internals.normalizeCustomerTermsSnapshot(candidate).error,
      "INVALID_QUOTE_CUSTOMER_TERMS_SNAPSHOT"
    );
  }
  const pool = { query() { throw new Error("database should not be reached"); } };
  const result = await service.createDraftQuote({
    pool,
    authenticatedActor: { id: 7 },
    idempotencyKey: "strict-terms",
    jobId,
    currency: "USD",
    customerTermsSnapshot: { ...rawTerms, issued: true },
  });
  assert.equal(result.code, "INVALID_QUOTE_CUSTOMER_TERMS_SNAPSHOT");
});

test("v2 integrity changes with material Agreement terms and is deterministic", () => {
  const base = hash(normalizedTerms, 2);
  const changed = hash({
    ...normalizedTerms,
    agreement: {
      ...normalizedTerms.agreement,
      warrantyTerms: "Two-year workmanship warranty.",
    },
  }, 2);
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.notEqual(changed, base);
  assert.equal(hash(normalizedTerms, 2), base);
  assert.throws(() => hash(normalizedTerms, 1), /integrity contract is invalid/i);
  assert.throws(() => hash(null, 2), /integrity contract is invalid/i);
});

test("customer and delivery projections expose only normalized frozen terms", () => {
  const integrityHash = hash(normalizedTerms, 2);
  const quote = {
    id: quoteId,
    jobId,
    status: "ISSUED",
    issuedAt,
    currency: "USD",
    currentVersion: 3,
    totalMinor: 92000,
    scopeItems: scope,
    conditions: [],
    exclusions: [],
    customerTermsSnapshot: normalizedTerms,
    decisionState: null,
    decidedAt: null,
    versions: [{
      version: 3,
      status: "ISSUED",
      issuedAt,
      integrityHash,
      integrityVersion: 2,
      customerTermsSnapshot: normalizedTerms,
      materialsSubtotalMinor: 0,
      laborServiceSubtotalMinor: 92000,
      totalMinor: 92000,
      scopeItemCount: 1,
      conditions: [],
      exclusions: [],
    }],
  };
  const issuance = {
    quote_version: 3,
    issued_at: issuedAt,
    source_snapshot_integrity_hash: integrityHash,
  };
  assert.equal(quoteDeliveryInternals.validIssuedQuote(quote, issuance), true);
  const delivery = quoteDeliveryInternals.buildSafeSnapshot(quote, {
    business_name: "Handyman LLC",
    job_title: "Repair",
    job_service: "handyman",
  });
  assert.deepEqual(delivery.customerTermsSnapshot, normalizedTerms);
  assert.equal(JSON.stringify(delivery).includes("approvalState"), false);
  assert.equal(internals.customerQuoteDetailProjection({
    ...quote,
    customerTermsSnapshot: { ...normalizedTerms, paid: true },
  }), null);
});

test("terms snapshot adds no competing decision, numbering, lifecycle, or AI authority", () => {
  const root = join(__dirname, "..");
  const serviceSource = readFileSync(
    join(root, "server", "authorization", "quoteDraftService.js"),
    "utf8"
  );
  const quoteComposeSource = readFileSync(
    join(root, "server", "intelligence", "operations", "quoteCompose.js"),
    "utf8"
  );
  const workflowAssistSource = readFileSync(
    join(root, "server", "intelligence", "operations", "workflowAssist.js"),
    "utf8"
  );
  assert.doesNotMatch(serviceSource, /canonical_quote_(?:approvals|acceptances)/i);
  assert.doesNotMatch(serviceSource, /allocateDocumentNumber|business_document_number_sequences/i);
  assert.match(serviceSource, /canonical_quote_business_document_sources/);
  for (const source of [quoteComposeSource, workflowAssistSource]) {
    assert.match(source, /prohibitedCanonicalCommands[\s\S]*quote\.customer\.approve[\s\S]*quote\.customer\.decline/i);
  }
});
