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
    "professionalScheduleService.js"
  ),
  "utf8"
);

function cte() {
  const a = source.indexOf(
    "const PROFESSIONAL_JOBS_CTE = `"
  );

  const b = source.indexOf(
    "const ACTIVE_GRANT = `",
    a
  );

  assert.notEqual(a, -1);
  assert.notEqual(b, -1);

  return source.slice(a, b);
}

function region(start, end) {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);

  assert.notEqual(a, -1, `missing ${start}`);
  assert.notEqual(b, -1, `missing ${end}`);

  return source.slice(a, b);
}

test("009D-3B-1B professional Job schedule CTE recognizes all four Job origins", () => {
  const body = cte();

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

test("009D-3B-1B Repeat Meetro schedule context keeps fresh Request and Relationship authority", () => {
  const body = cte();

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
    /professional\.source_evidence_type[\s\S]*'existing_customer_request'/
  );

  assert.match(
    body,
    /jobs\.source_request_selection_id IS NULL/
  );

  assert.match(
    body,
    /customer_roles\.id IS NOT NULL/
  );
});

test("009D-3B-1B business_customer schedule context uses exact business customer Job provenance", () => {
  const body = cte();

  assert.match(
    body,
    /professional\.source_evidence_type[\s\S]*'business_customer'/
  );

  assert.match(
    body,
    /LEFT JOIN job_customer_parties/
  );

  assert.match(
    body,
    /LEFT JOIN business_customer_job_sources/
  );

  assert.match(
    body,
    /jobs\.job_request_id IS NULL/
  );

  assert.match(
    body,
    /jobs\.source_request_relationship_id IS NULL/
  );

  assert.match(
    body,
    /jobs\.source_business_customer_job_id IS NOT NULL/
  );
});

test("009D-3B-1B full External Customer display name comes from business_contacts, not a fabricated Quick Quote snapshot", () => {
  const body = cte();

  assert.match(
    body,
    /business_contacts\.display_name/
  );

  assert.match(
    body,
    /business_contacts\.id[\s\S]*jobs\.business_contact_id/
  );

  assert.match(
    body,
    /FROM canonical_quote_customer_snapshots[\s\S]*WHERE jobs\.source_type = 'business_document'/
  );

  const snapshotStart = body.indexOf(
    "SELECT snapshots.customer_name"
  );

  const snapshotEnd = body.indexOf(
    ") customer_snapshot ON TRUE",
    snapshotStart
  );

  assert.notEqual(
    snapshotStart,
    -1,
    "Quick Quote customer snapshot subquery must exist"
  );

  assert.notEqual(
    snapshotEnd,
    -1,
    "Quick Quote customer snapshot subquery must terminate"
  );

  const snapshotBody = body.slice(
    snapshotStart,
    snapshotEnd
  );

  assert.match(
    snapshotBody,
    /FROM canonical_quote_customer_snapshots snapshots/
  );

  assert.match(
    snapshotBody,
    /WHERE jobs\.source_type = 'business_document'/
  );

  assert.doesNotMatch(
    snapshotBody,
    /business_customer/
  );
});

test("009D-3B-1B Approved Work opportunities map both Meetro Job origins to MEETRO_CUSTOMER", () => {
  const body = region(
    "async function loadOpportunities(",
    "async function loadVisits("
  );

  assert.match(
    body,
    /jobs\.source_type IN[\s\S]*'ordinary_request_selection'[\s\S]*'existing_customer_request'/
  );

  assert.match(
    body,
    /approvals\.approval_source[\s\S]*'MEETRO_CUSTOMER'/
  );

  assert.match(
    body,
    /approvals\.customer_decision_id IS NOT NULL/
  );

  assert.match(
    body,
    /approvals\.external_approval_evidence_id IS NULL/
  );

  assert.match(
    body,
    /quotes\.source_context_type[\s\S]*'ordinary_request'/
  );
});

test("009D-3B-1B Quick Quote external scheduling remains business_document plus EXTERNAL_EVIDENCE", () => {
  const body = region(
    "async function loadOpportunities(",
    "async function loadVisits("
  );

  assert.match(
    body,
    /jobs\.source_type[\s\S]*'business_document'/
  );

  assert.match(
    body,
    /approvals\.approval_source[\s\S]*'EXTERNAL_EVIDENCE'/
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

test("009D-3B-1B business_customer Approved Work scheduling binds exact common external approval", () => {
  const body = region(
    "async function loadOpportunities(",
    "async function loadVisits("
  );

  assert.match(
    body,
    /jobs\.source_type[\s\S]*'business_customer'/
  );

  assert.match(
    body,
    /approvals\.approval_source[\s\S]*'EXTERNAL_EVIDENCE'/
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
});

test("009D-3B-1B Approved Work grant completeness remains approval-source based", () => {
  const body = region(
    "async function loadOpportunities(",
    "async function loadVisits("
  );

  assert.match(
    body,
    /CASE WHEN approvals\.approval_source = 'EXTERNAL_EVIDENCE'/
  );

  assert.match(
    body,
    /approvals\.approval_source = 'EXTERNAL_EVIDENCE' OR/
  );
});

test("009D-3B-1B loadVisits remains origin-neutral and approval/grant scoped", () => {
  const body = region(
    "async function loadVisits(",
    "function locationProjection("
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

  assert.match(
    body,
    /visits\.quote_approval_id/
  );

  assert.match(
    body,
    /grants\.scope_quote_approval_id/
  );

  assert.match(
    body,
    /grants\.scope_quote_approval_source/
  );
});

test("009D-3B-1B schedule still delegates payment truth to the frozen deposit gate", () => {
  const body = region(
    "async function getProfessionalSchedule(",
    "module.exports ="
  );

  assert.match(
    body,
    /evaluateApprovedWorkDepositGateWithClient/
  );

  assert.match(
    body,
    /quoteApprovalId:\s*row\.quote_approval_id/
  );

  assert.match(
    body,
    /approvedQuoteDecisionId:\s*row\.approved_quote_decision_id/
  );
});
