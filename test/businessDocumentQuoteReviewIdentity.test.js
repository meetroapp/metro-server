"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  getBusinessDocumentDraftQuoteReview,
  quoteDraftServiceInternals,
} = require("../server/authorization/quoteDraftService");

const DOCUMENT_ID = "11111111-1111-4111-8111-111111111111";
const JOB_ID = "22222222-2222-4222-8222-222222222222";

function identityRow(overrides = {}) {
  return {
    document_id: DOCUMENT_ID,
    document_version: 3,
    job_id: JOB_ID,
    job_request_id: 18,
    relationship_id: 340,
    lifecycle_contract_version: 2,
    job_source_type: "ordinary_request_selection",
    project_title: "Slice 004 Recommendation staging certification",
    relationship_status: "active",
    selected_professional_user_id: 12,
    customer_name: "Meetro Stage B 20260705172957",
    actor_participant_id: "33333333-3333-4333-8333-333333333333",
    actor_is_primary_professional: true,
    actor_can_read_participant: true,
    service_address_line1: "1 Private Street",
    customer_email: "private@example.test",
    ...overrides,
  };
}

function poolWithRow(row = identityRow()) {
  const calls = [];
  const client = {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.startsWith("BEGIN") || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [] };
      }
      if (sql.includes("quote_business_document:load_review_identity")) {
        return { rows: row ? [row] : [] };
      }
      throw new Error(`Unexpected SQL: ${sql.slice(0, 100)}`);
    },
    release() {},
  };
  return {
    calls,
    query(...args) { return client.query(...args); },
    async connect() { return client; },
  };
}

test("owned exact-version Working Quote returns canonical customer and project identity read-only", async () => {
  const pool = poolWithRow();
  const result = await getBusinessDocumentDraftQuoteReview({
    pool,
    authenticatedActor: { id: 12 },
    draftId: DOCUMENT_ID,
    expectedDocumentVersion: 3,
  });

  assert.equal(result.ok, true);
  assert.equal(result.code, "BUSINESS_DOCUMENT_QUOTE_REVIEW_LOADED");
  assert.deepEqual(result.review, {
    documentId: DOCUMENT_ID,
    documentVersion: 3,
    jobId: JOB_ID,
    requestId: 18,
    relationshipId: 340,
    customerName: "Meetro Stage B 20260705172957",
    projectTitle: "Slice 004 Recommendation staging certification",
  });
  const sql = pool.calls.map(({ sql }) => sql).join("\n");
  assert.match(sql, /BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY/);
  assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE)\b/i);
  assert.doesNotMatch(JSON.stringify(result), /Private Street|private@example/i);
});


test("jobless external Quick Quote review uses business-owned document identity without fabricating lifecycle authority", async () => {
  const row = identityRow({
    job_id: null,
    job_request_id: null,
    relationship_id: null,
    lifecycle_contract_version: null,
    job_source_type: null,
    relationship_status: null,
    actor_participant_id: null,
    actor_is_primary_professional: false,
    actor_can_read_participant: true,
    customer_name: "Maggie",
    project_title: "Living room ceiling fan",
  });

  const result = await getBusinessDocumentDraftQuoteReview({
    pool: poolWithRow(row),
    authenticatedActor: { id: 12 },
    draftId: DOCUMENT_ID,
    expectedDocumentVersion: 3,
  });

  assert.equal(result.ok, true);
  assert.equal(result.code, "BUSINESS_DOCUMENT_QUOTE_REVIEW_LOADED");
  assert.deepEqual(result.review, {
    documentId: DOCUMENT_ID,
    documentVersion: 3,
    jobId: null,
    requestId: null,
    relationshipId: null,
    customerName: "Maggie",
    projectTitle: "Living room ceiling fan",
  });
});

test("review projection is bound to the exact saved version", async () => {
  const result = await getBusinessDocumentDraftQuoteReview({
    pool: poolWithRow(identityRow({ document_version: 4 })),
    authenticatedActor: { id: 12 },
    draftId: DOCUMENT_ID,
    expectedDocumentVersion: 3,
  });
  assert.equal(result.status, 409);
  assert.equal(result.code, "STALE_BUSINESS_DOCUMENT_VERSION");
});

test("wrong professional, inactive relationship, missing role, or missing participant read authority fail closed", async () => {
  for (const row of [
    identityRow({ selected_professional_user_id: 99 }),
    identityRow({ relationship_status: "closed" }),
    identityRow({ actor_is_primary_professional: false }),
    identityRow({ actor_can_read_participant: false }),
  ]) {
    const result = await getBusinessDocumentDraftQuoteReview({
      pool: poolWithRow(row),
      authenticatedActor: { id: 12 },
      draftId: DOCUMENT_ID,
      expectedDocumentVersion: 3,
    });
    assert.equal(result.status, 403);
    assert.equal(result.code, "BUSINESS_DOCUMENT_QUOTE_REVIEW_AUTHORITY_REQUIRED");
  }
});

test("review projection exposes only bounded canonical identity fields", () => {
  const projection = quoteDraftServiceInternals.businessDocumentQuoteReviewProjection(
    identityRow()
  );
  assert.deepEqual(Object.keys(projection).sort(), [
    "customerName",
    "documentId",
    "documentVersion",
    "jobId",
    "projectTitle",
    "relationshipId",
    "requestId",
  ]);
});

test("review identity uses canonical lifecycle joins without weakening Quote picker or issue authority", () => {
  const source = String(
    quoteDraftServiceInternals.loadBusinessDocumentQuoteReviewIdentity
  );
  for (const table of [
    "business_document_working_drafts",
    "jobs",
    "posts",
    "request_relationships",
    "request_selections",
    "relationship_participants",
  ]) {
    assert.match(source, new RegExp(table));
  }
  assert.match(source, /grants\.capability = 'participant\.read'/);
  assert.doesNotMatch(source, /quote\.(?:create|read|scope\.manage|issue)/);
});
