"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  businessCustomerRelationshipInternals,
} = require("../server/relationships/businessCustomerRelationshipService");

const JOB_ID = "33333333-3333-4333-8333-333333333333";
const QUOTE_ID = "44444444-4444-4444-8444-444444444444";
const INVOICE_ID = "55555555-5555-4555-8555-555555555555";
const MEDIA_ID = "meetro/users/101/request-photos/kitchen";

function mediaRow(overrides = {}) {
  return {
    job_id: JOB_ID,
    job_title: "Kitchen repair",
    media_id: MEDIA_ID,
    secure_url: "https://res.cloudinary.com/meetro/image/upload/v1/meetro/users/101/request-photos/kitchen.jpg",
    format: "jpg",
    uploaded_at: "2026-08-21T11:00:00.000Z",
    ...overrides,
  };
}

function quoteRow(overrides = {}) {
  return {
    quote_id: QUOTE_ID,
    job_id: JOB_ID,
    job_title: "Kitchen repair",
    document_number: "Q-0001020",
    status: "ISSUED",
    created_at: "2026-08-21T13:00:00.000Z",
    issued_at: "2026-08-21T15:00:00.000Z",
    last_activity_at: "2026-08-22T15:00:00.000Z",
    ...overrides,
  };
}

function invoiceRow(overrides = {}) {
  return {
    invoice_id: INVOICE_ID,
    invoice_number: "INV-ABCDEF123456",
    job_id: JOB_ID,
    job_title: "Kitchen repair",
    status: "PARTIALLY_PAID",
    created_at: "2026-08-23T13:00:00.000Z",
    issued_at: "2026-08-23T14:00:00.000Z",
    last_activity_at: "2026-08-24T13:00:00.000Z",
    ...overrides,
  };
}

test("Job request photo projection preserves stable identity, URL, and canonical parent", () => {
  const projected = businessCustomerRelationshipInternals.mediaActivityProjection(mediaRow());
  assert.deepEqual(projected, {
    mediaId: MEDIA_ID,
    kind: "PHOTO",
    mediaType: "IMAGE",
    format: "jpg",
    secureUrl: mediaRow().secure_url,
    parentType: "JOB",
    parentId: JOB_ID,
    jobTitle: "Kitchen repair",
    provenance: "JOB_REQUEST",
    category: "REQUEST_PHOTO",
    createdAt: "2026-08-21T11:00:00.000Z",
  });
});

test("canonical Quote document projection retains Quote and Job provenance", () => {
  const projected = businessCustomerRelationshipInternals.documentActivityProjection(
    quoteRow(),
    "QUOTE"
  );
  assert.equal(projected.documentId, QUOTE_ID);
  assert.equal(projected.documentNumber, "Q-0001020");
  assert.equal(projected.parentId, JOB_ID);
  assert.equal(projected.provenance, "CANONICAL_QUOTE");
});

test("canonical Invoice document projection retains Invoice and Job provenance", () => {
  const projected = businessCustomerRelationshipInternals.documentActivityProjection(
    invoiceRow(),
    "INVOICE"
  );
  assert.equal(projected.documentId, INVOICE_ID);
  assert.equal(projected.documentNumber, "INV-ABCDEF123456");
  assert.equal(projected.parentId, JOB_ID);
  assert.equal(projected.provenance, "CANONICAL_INVOICE");
});

test("combined canonical documents are deterministic newest-first", () => {
  const projected = businessCustomerRelationshipInternals.documentActivityProjections(
    [quoteRow()],
    [invoiceRow()]
  );
  assert.deepEqual(projected.map(({ documentId }) => documentId), [INVOICE_ID, QUOTE_ID]);
});

test("document ordering uses stable identity when authoritative dates tie", () => {
  const date = "2026-08-24T13:00:00.000Z";
  const projected = businessCustomerRelationshipInternals.documentActivityProjections(
    [quoteRow({ last_activity_at: date })],
    [invoiceRow({ last_activity_at: date })]
  );
  assert.deepEqual(projected.map(({ documentId }) => documentId), [QUOTE_ID, INVOICE_ID]);
});

test("media reaches a relationship only through the exact customer-party-linked Job", () => {
  const source = String(businessCustomerRelationshipInternals.sqlStore.getActivity);
  assert.match(source, /FROM job_customer_parties parties[\s\S]*INNER JOIN jobs ON jobs\.id = parties\.job_id/);
  assert.match(source, /INNER JOIN posts ON posts\.id = jobs\.job_request_id/);
  assert.match(source, /parties\.contractor_profile_id = \$1/);
  assert.match(source, /parties\.business_contact_id = \$2/);
  assert.match(source, /parties\.business_customer_relationship_id = \$3/);
});

test("media association never uses customer fields, Meetro identity, or request relationships", () => {
  const source = String(businessCustomerRelationshipInternals.sqlStore.getActivity);
  assert.doesNotMatch(source, /request_relationships/);
  assert.doesNotMatch(source, /users\./);
  assert.doesNotMatch(source, /contacts\.(?:display_name|email|phone)/);
  assert.doesNotMatch(source, /(?:customer|contact).*(?:name|email|phone).*=/i);
});

test("only governed attached request-photo images with secure URLs are projected", () => {
  const source = String(businessCustomerRelationshipInternals.sqlStore.getActivity);
  assert.match(source, /photo\.item->>'purpose' = 'request-photo'/);
  assert.match(source, /photo\.item->>'resource_type' = 'image'/);
  assert.match(source, /photo\.item->>'lifecycle_state' = 'attached'/);
  assert.match(source, /photo\.item->>'secure_url' LIKE 'https:\/\/res\.cloudinary\.com\/%'/);
});

test("working-draft, analysis, and opaque evidence media are deliberately excluded", () => {
  const source = String(businessCustomerRelationshipInternals.sqlStore.getActivity);
  assert.doesNotMatch(source, /business_document_draft_media/);
  assert.doesNotMatch(source, /business_document_working_drafts/);
  assert.doesNotMatch(source, /quick_quote|analysis_session|finding_evidence/i);
});

test("projection preserves request provenance without inventing before, progress, or completion labels", () => {
  const serialized = JSON.stringify(
    businessCustomerRelationshipInternals.mediaActivityProjection(mediaRow())
  );
  assert.match(serialized, /"category":"REQUEST_PHOTO"/);
  assert.doesNotMatch(serialized, /before|progress|completion/i);
});

test("Documents and Photos history remains read-only and contains no AI analysis path", () => {
  const source = String(businessCustomerRelationshipInternals.sqlStore.getActivity);
  assert.doesNotMatch(source, /\b(?:INSERT|UPDATE|DELETE|UPSERT)\b/i);
  assert.doesNotMatch(source, /openai|provider|vision_model|photo_analysis/i);
});
