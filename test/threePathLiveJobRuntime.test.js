"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const source = readFileSync(
  join(
    __dirname,
    "..",
    "server",
    "workflow",
    "liveJobProjectionService.js"
  ),
  "utf8"
);

function region(start, end) {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);

  assert.notEqual(a, -1, `missing ${start}`);
  assert.notEqual(b, -1, `missing ${end}`);

  return source.slice(a, b);
}

test("009D-3B-1C Live Job authorized context recognizes all four Job origins", () => {
  const body = region(
    "async function loadAuthorizedJob(",
    "async function loadCanonicalState("
  );

  for (const value of [
    "ordinary_request_selection",
    "existing_customer_request",
    "business_document",
    "business_customer",
  ]) {
    assert.match(
      body,
      new RegExp(value)
    );
  }
});

test("009D-3B-1C Repeat Meetro keeps exact fresh Request and Relationship provenance", () => {
  const body = region(
    "async function loadAuthorizedJob(",
    "async function loadCanonicalState("
  );

  assert.match(
    body,
    /posts\.request_origin[\s\S]*'existing_customer_request'/
  );

  assert.match(
    body,
    /request_relationships\.ordinary_authority_source[\s\S]*'existing_customer_request'/
  );

  assert.match(
    body,
    /relationship_participants\.source_evidence_type[\s\S]*'existing_customer_request'/
  );

  assert.match(
    body,
    /jobs\.source_request_selection_id IS NULL/
  );
});

test("009D-3B-1C Repeat Meetro resolves canonical conversation from Relationship without fabricating a Selection", () => {
  const body = region(
    "async function loadAuthorizedJob(",
    "async function loadCanonicalState("
  );

  assert.match(
    body,
    /LEFT JOIN conversations relationship_conversations/
  );

  assert.match(
    body,
    /relationship_conversations\.relationship_id[\s\S]*request_relationships\.id/
  );

  assert.match(
    body,
    /COALESCE\([\s\S]*request_selections\.conversation_id,[\s\S]*relationship_conversations\.id[\s\S]*\) AS conversation_id/
  );

  assert.match(
    body,
    /jobs\.source_request_selection_id IS NULL/
  );
});

test("009D-3B-1C business_customer uses exact business-owned Job provenance", () => {
  const body = region(
    "async function loadAuthorizedJob(",
    "async function loadCanonicalState("
  );

  assert.match(
    body,
    /relationship_participants\.source_evidence_type[\s\S]*'business_customer'/
  );

  assert.match(
    body,
    /LEFT JOIN business_contacts business_contacts/
  );

  assert.match(
    body,
    /LEFT JOIN job_customer_parties customer_parties/
  );

  assert.match(
    body,
    /LEFT JOIN business_customer_job_sources business_sources/
  );

  assert.match(
    body,
    /business_sources\.id[\s\S]*jobs\.source_business_customer_job_id/
  );
});

test("009D-3B-1C business_customer has no fabricated Meetro Request or Relationship authority", () => {
  const body = region(
    "async function loadAuthorizedJob(",
    "async function loadCanonicalState("
  );

  assert.match(
    body,
    /jobs\.job_request_id IS NULL/
  );

  assert.match(
    body,
    /jobs\.source_request_selection_id IS NULL/
  );

  assert.match(
    body,
    /jobs\.source_request_relationship_id IS NULL/
  );

  assert.match(
    body,
    /jobs\.originating_business_document_id IS NULL/
  );
});

test("009D-3B-1C Quick Quote business_document admission remains separate", () => {
  const body = region(
    "async function loadAuthorizedJob(",
    "async function loadCanonicalState("
  );

  assert.match(
    body,
    /jobs\.source_type[\s\S]*'business_document'/
  );

  assert.match(
    body,
    /jobs\.originating_business_document_id IS NOT NULL/
  );
});

test("009D-3B-1C top-level admission classifies both business-owned Job origins together", () => {
  const body = region(
    "async function getCanonicalLiveJob(",
    "module.exports ="
  );

  assert.match(
    body,
    /const businessOwnedJob = \[[\s\S]*"business_document"[\s\S]*"business_customer"[\s\S]*\]\.includes\(context\.source_type\)/
  );

  assert.match(
    body,
    /const meetroRelationshipJob = \[[\s\S]*"ordinary_request_selection"[\s\S]*"existing_customer_request"[\s\S]*\]\.includes\(context\.source_type\)/
  );

  assert.match(
    body,
    /!businessOwnedJob[\s\S]*!meetroRelationshipJob[\s\S]*context\.relationship_status !== "active"/
  );
});

test("009D-3B-1C business-owned Live Job read authority uses participant.read plus quote.read", () => {
  const body = region(
    "async function getCanonicalLiveJob(",
    "module.exports ="
  );

  assert.match(
    body,
    /const requiredCapabilities = businessOwnedJob[\s\S]*\["participant\.read", "quote\.read"\][\s\S]*\["participant\.read", "reported_concern\.read"\]/
  );
});

test("009D-3B-1C canonical derivation remains Job-origin neutral", () => {
  const body = region(
    "function deriveCanonicalLiveJob(",
    "async function loadAuthorizedJob("
  );

  for (const value of [
    "ordinary_request_selection",
    "existing_customer_request",
    "business_document",
    "business_customer",
  ]) {
    assert.doesNotMatch(
      body,
      new RegExp(value)
    );
  }
});

test("009D-3B-1C Approved Work scheduling projection remains common-approval based", () => {
  const body = region(
    "async function loadCanonicalState(",
    "async function getCanonicalLiveJob("
  );

  const marker =
    body.indexOf(
      "/* live_job:approved_work_scheduling */"
    );

  assert.notEqual(marker, -1);

  const schedule = body.slice(marker);

  assert.match(
    schedule,
    /canonical_quote_approvals/
  );

  assert.match(
    schedule,
    /deposit_obligations\.quote_approval_id\s*=\s*approvals\.id/
  );

  assert.match(
    schedule,
    /approvals\.approval_source\s*=\s*'EXTERNAL_EVIDENCE'/
  );

  for (const value of [
    "ordinary_request_selection",
    "existing_customer_request",
    "business_document",
    "business_customer",
  ]) {
    assert.doesNotMatch(
      schedule,
      new RegExp(value)
    );
  }
});
