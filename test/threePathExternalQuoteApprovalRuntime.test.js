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
    "authorization",
    "quoteDraftService.js"
  ),
  "utf8"
);

function body() {
  const start = source.indexOf(
    "async function recordExternalQuoteApproval("
  );

  const end = source.indexOf(
    "async function createDerivedDraftQuote(",
    start
  );

  assert.notEqual(start, -1);
  assert.notEqual(end, -1);

  return source.slice(start, end);
}

test("009D-2C-2B external approval accepts Quick Quote and business_customer as distinct sources", () => {
  const text = body();

  assert.match(
    text,
    /context\.job_source_type === "business_document"[\s\S]*context\.source_context_type === "business_document"/
  );

  assert.match(
    text,
    /context\.job_source_type === "business_customer"[\s\S]*context\.source_context_type === "business_customer"/
  );

  assert.match(
    text,
    /!quickQuoteOrigin && !businessCustomerOrigin/
  );

  assert.doesNotMatch(
    text,
    /context\.job_source_type !== "business_document"\s*\|\|[\s\S]*context\.source_context_type !== "business_document"/
  );
});

test("009D-2C-2B Quick Quote preserves immutable customer snapshot approval identity", () => {
  const text = body();

  assert.match(
    text,
    /if \(quickQuoteOrigin\)/
  );

  assert.match(
    text,
    /quote_external_approval:load_customer_snapshot/
  );

  assert.match(
    text,
    /FROM canonical_quote_customer_snapshots/
  );

  assert.match(
    text,
    /QUOTE_EXTERNAL_APPROVAL_CUSTOMER_SNAPSHOT_REQUIRED/
  );

  assert.match(
    text,
    /customerSnapshot[\s\S]*customerSnapshot\.snapshot_hash/
  );
});

test("009D-2C-2B business_customer approval uses exact immutable Quote customer party", () => {
  const text = body();

  assert.match(
    text,
    /if \(businessCustomerOrigin\)/
  );

  assert.match(
    text,
    /context\.customer_party_contractor_profile_id/
  );

  assert.match(
    text,
    /context\.job_contractor_profile_id/
  );

  assert.match(
    text,
    /context\.business_contact_id/
  );

  assert.match(
    text,
    /context\.job_business_contact_id/
  );

  assert.match(
    text,
    /context\.business_customer_relationship_id/
  );

  assert.match(
    text,
    /context\.job_business_customer_relationship_id/
  );

  assert.match(
    text,
    /context\.business_customer_job_source_id[\s\S]*context\.job_business_customer_job_source_id/
  );

  assert.match(
    text,
    /quote_external_approval:load_customer_party/
  );

  assert.match(
    text,
    /FROM canonical_quote_customer_parties/
  );

  assert.match(
    text,
    /business_contact_id = \$4/
  );

  assert.match(
    text,
    /business_customer_relationship_id = \$5/
  );

  assert.match(
    text,
    /QUOTE_EXTERNAL_APPROVAL_CUSTOMER_PARTY_REQUIRED/
  );
});

test("009D-2C-2B never fabricates a Quick Quote customer snapshot for business_customer", () => {
  const text = body();

  assert.doesNotMatch(
    text,
    /insertCanonicalQuoteCustomerSnapshot/
  );

  assert.doesNotMatch(
    text,
    /resolveBusinessDocumentQuoteCustomerSnapshot/
  );

  assert.doesNotMatch(
    text,
    /INSERT INTO canonical_quote_customer_snapshots/
  );
});

test("009D-2C-2B external evidence insert carries mutually exclusive source identity columns", () => {
  const text = body();

  assert.match(
    text,
    /INSERT INTO canonical_quote_external_approval_evidence/
  );

  assert.match(
    text,
    /customer_snapshot_hash,[\s\S]*business_contact_id,[\s\S]*business_customer_relationship_id/
  );

  assert.match(
    text,
    /customerSnapshot[\s\S]*\? customerSnapshot\.snapshot_hash[\s\S]*: null/
  );

  assert.match(
    text,
    /customerParty[\s\S]*\? customerParty\.business_contact_id[\s\S]*: null/
  );

  assert.match(
    text,
    /customerParty[\s\S]*\? customerParty\.business_customer_relationship_id[\s\S]*: null/
  );
});

test("009D-2C-2B both external sources still converge on common EXTERNAL_EVIDENCE approval", () => {
  const text = body();

  assert.match(
    text,
    /INSERT INTO canonical_quote_approvals/
  );

  assert.match(
    text,
    /'EXTERNAL_EVIDENCE'/
  );

  assert.match(
    text,
    /'APPROVED'/
  );

  assert.match(
    text,
    /externalEvidence\.id/
  );

  assert.match(
    text,
    /materializeApprovedQuoteApprovalDepositWithClient/
  );
});

test("009D-2C-2B external approval remains professional-recorded evidence, not Meetro customer authority", () => {
  const text = body();

  assert.match(
    text,
    /QUOTE_CAPABILITIES\.EXTERNAL_APPROVAL_RECORD/
  );

  assert.match(
    text,
    /context\.actor_participant_id/
  );

  assert.doesNotMatch(
    text,
    /CUSTOMER_REPRESENTATIVE/
  );

  assert.doesNotMatch(
    text,
    /canonical_quote_customer_decisions/
  );

  assert.doesNotMatch(
    text,
    /quote\.approve/
  );

  assert.doesNotMatch(
    text,
    /quote\.decline/
  );
});
