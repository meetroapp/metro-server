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
    "finance",
    "preWorkDepositService.js"
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

test("009D-3A-1B professional deposit Job authority recognizes all four Job sources", () => {
  const body = region(
    "async function loadProfessionalJobContext(",
    "async function loadApprovedQuoteApprovalSource("
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

test("009D-3A-1B Repeat Meetro keeps exact Request and Relationship provenance", () => {
  const body = region(
    "async function loadProfessionalJobContext(",
    "async function loadApprovedQuoteApprovalSource("
  );

  assert.match(
    body,
    /posts\.request_origin[\s\S]*'existing_customer_request'/
  );

  assert.match(
    body,
    /relationships\.ordinary_authority_source[\s\S]*'existing_customer_request'/
  );

  assert.match(
    body,
    /jobs\.source_request_selection_id IS NULL/
  );

  assert.match(
    body,
    /professional\.request_relationship_id[\s\S]*relationships\.id/
  );

  assert.match(
    body,
    /customer\.request_relationship_id[\s\S]*relationships\.id/
  );
});

test("009D-3A-1B business_customer professional authority has no Request Relationship or fake customer participant", () => {
  const body = region(
    "async function loadProfessionalJobContext(",
    "async function loadApprovedQuoteApprovalSource("
  );

  assert.match(
    body,
    /jobs\.source_type = 'business_customer'/
  );

  assert.match(
    body,
    /professional\.request_relationship_id IS NULL/
  );

  assert.match(
    body,
    /professional\.source_evidence_type[\s\S]*'business_customer'/
  );

  assert.match(
    body,
    /NULL::uuid AS customer_participant_id/
  );

  assert.match(
    body,
    /jobs\.job_request_id IS NULL/
  );

  assert.match(
    body,
    /jobs\.source_request_relationship_id IS NULL/
  );
});

test("009D-3A-1B business_customer professional authority requires exact durable customer Job tuple", () => {
  const body = region(
    "async function loadProfessionalJobContext(",
    "async function loadApprovedQuoteApprovalSource("
  );

  assert.match(
    body,
    /INNER JOIN job_customer_parties/
  );

  assert.match(
    body,
    /customer_parties\.business_contact_id[\s\S]*jobs\.business_contact_id/
  );

  assert.match(
    body,
    /customer_parties\.business_customer_relationship_id[\s\S]*jobs\.business_customer_relationship_id/
  );

  assert.match(
    body,
    /INNER JOIN business_customer_job_sources/
  );

  assert.match(
    body,
    /sources\.id[\s\S]*jobs\.source_business_customer_job_id/
  );
});

test("009D-3A-1B approved Quote loader maps both Meetro sources to MEETRO_CUSTOMER", () => {
  const body = region(
    "async function loadApprovedQuoteApprovalSource(",
    "async function loadApprovedDecisionSource("
  );

  assert.match(
    body,
    /approvals\.approval_source[\s\S]*'MEETRO_CUSTOMER'/
  );

  assert.match(
    body,
    /jobs\.source_type IN[\s\S]*'ordinary_request_selection'[\s\S]*'existing_customer_request'/
  );

  assert.match(
    body,
    /quotes\.source_context_type[\s\S]*'ordinary_request'/
  );

  assert.match(
    body,
    /quotes\.job_source_type[\s\S]*jobs\.source_type/
  );

  assert.match(
    body,
    /approvals\.customer_decision_id IS NOT NULL/
  );

  assert.match(
    body,
    /approvals\.external_approval_evidence_id IS NULL/
  );
});

test("009D-3A-1B approved Quote loader maps both business-owned sources to EXTERNAL_EVIDENCE", () => {
  const body = region(
    "async function loadApprovedQuoteApprovalSource(",
    "async function loadApprovedDecisionSource("
  );

  assert.match(
    body,
    /approvals\.approval_source[\s\S]*'EXTERNAL_EVIDENCE'/
  );

  assert.match(
    body,
    /jobs\.source_type IN[\s\S]*'business_document'[\s\S]*'business_customer'/
  );

  assert.match(
    body,
    /approvals\.customer_decision_id IS NULL/
  );

  assert.match(
    body,
    /approvals\.external_approval_evidence_id IS NOT NULL/
  );

  assert.match(
    body,
    /customer\.id IS NULL/
  );
});

test("009D-3A-1B business_customer approval retains exact Quote and Job source identity", () => {
  const body = region(
    "async function loadApprovedQuoteApprovalSource(",
    "async function loadApprovedDecisionSource("
  );

  assert.match(
    body,
    /quotes\.source_context_type[\s\S]*'business_customer'/
  );

  assert.match(
    body,
    /quotes\.job_source_type[\s\S]*'business_customer'/
  );

  assert.match(
    body,
    /quotes\.business_customer_job_source_id[\s\S]*jobs\.source_business_customer_job_id/
  );

  assert.match(
    body,
    /job_customer_parties\.business_contact_id[\s\S]*jobs\.business_contact_id/
  );

  assert.match(
    body,
    /job_customer_parties\.business_customer_relationship_id[\s\S]*jobs\.business_customer_relationship_id/
  );
});

test("009D-3A-1B Quick Quote business_document approval path remains separate", () => {
  const body = region(
    "async function loadApprovedQuoteApprovalSource(",
    "async function loadApprovedDecisionSource("
  );

  assert.match(
    body,
    /jobs\.source_type[\s\S]*'business_document'/
  );

  assert.match(
    body,
    /jobs\.originating_business_document_id[\s\S]*IS NOT NULL/
  );

  assert.match(
    body,
    /quotes\.source_context_type[\s\S]*'business_document'/
  );

  assert.match(
    body,
    /quotes\.job_source_type[\s\S]*'business_document'/
  );
});

test("009D-3A-1B scheduling gate still unlocks only on SATISFIED", () => {
  const body = region(
    "async function evaluateApprovedWorkDepositGateWithClient(",
    "function schedulingGateFailure("
  );

  assert.match(
    body,
    /obligation\.latest_state === "SATISFIED"/
  );

  assert.match(
    body,
    /"DEPOSIT_REQUIRED_BEFORE_SCHEDULING"/
  );

  assert.doesNotMatch(
    body,
    /business_customer/
  );

  assert.doesNotMatch(
    body,
    /existing_customer_request/
  );
});

test("009D-3A-1B partial payment remains PARTIALLY_SATISFIED and cannot become scheduling authority", () => {
  const body = region(
    "async function confirmDepositReceived(",
    "async function reverseDepositAllocation("
  );

  assert.match(
    body,
    /allocatedMinor = Math\.min\(amountMinor, remainingBefore\)/
  );

  assert.match(
    body,
    /remainingMinor = Number\(obligation\.required_minor\) - appliedMinor/
  );

  assert.match(
    body,
    /remainingMinor === 0 \? "SATISFIED" : "PARTIALLY_SATISFIED"/
  );

  assert.doesNotMatch(
    body,
    /existing_customer_request/
  );

  assert.doesNotMatch(
    body,
    /business_customer/
  );
});
