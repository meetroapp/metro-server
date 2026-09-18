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
    "approvedWorkVisitService.js"
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

test("009D-3B-1A Approved Work Visit context recognizes all four Job origins", () => {
  const body = region(
    "async function loadContext(",
    "async function requireActivationAuthority("
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

test("009D-3B-1A Repeat Meetro preserves fresh Request and Relationship authority", () => {
  const body = region(
    "async function loadContext(",
    "async function requireActivationAuthority("
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
    /professional\.source_evidence_type[\s\S]*'existing_customer_request'/
  );

  assert.match(
    body,
    /approvals\.approval_source[\s\S]*'MEETRO_CUSTOMER'/
  );

  assert.match(
    body,
    /decisions\.id IS NOT NULL/
  );
});

test("009D-3B-1A Repeat Meetro approval remains authenticated customer authority", () => {
  const body = region(
    "async function loadContext(",
    "async function requireActivationAuthority("
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

  assert.match(
    body,
    /quotes\.job_source_type[\s\S]*'existing_customer_request'/
  );

  assert.match(
    body,
    /customer\.id IS NOT NULL/
  );
});

test("009D-3B-1A business_customer uses exact business-owned Job provenance", () => {
  const body = region(
    "async function loadContext(",
    "async function requireActivationAuthority("
  );

  assert.match(
    body,
    /jobs\.source_type[\s\S]*'business_customer'/
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
    /LEFT JOIN job_customer_parties/
  );

  assert.match(
    body,
    /job_customer_parties\.business_contact_id[\s\S]*jobs\.business_contact_id/
  );

  assert.match(
    body,
    /job_customer_parties\.business_customer_relationship_id[\s\S]*jobs\.business_customer_relationship_id/
  );

  assert.match(
    body,
    /LEFT JOIN business_customer_job_sources/
  );

  assert.match(
    body,
    /business_customer_job_sources\.id[\s\S]*jobs\.source_business_customer_job_id/
  );
});

test("009D-3B-1A business_customer never fabricates Meetro Request or customer authority", () => {
  const body = region(
    "async function loadContext(",
    "async function requireActivationAuthority("
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

  assert.match(
    body,
    /customer\.id IS NULL/
  );

  assert.match(
    body,
    /approvals\.customer_decision_id IS NULL/
  );

  assert.match(
    body,
    /approvals\.external_approval_evidence_id IS NOT NULL/
  );
});

test("009D-3B-1A business_customer approval binds exact common Quote source", () => {
  const body = region(
    "async function loadContext(",
    "async function requireActivationAuthority("
  );

  assert.match(
    body,
    /approvals\.approval_source[\s\S]*'EXTERNAL_EVIDENCE'/
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

test("009D-3B-1A Quick Quote business_document activation path remains separate", () => {
  const body = region(
    "async function loadContext(",
    "async function requireActivationAuthority("
  );

  assert.match(
    body,
    /jobs\.source_type[\s\S]*'business_document'/
  );

  assert.match(
    body,
    /jobs\.originating_business_document_id IS NOT NULL/
  );

  assert.match(
    body,
    /profiles\.id IS NOT NULL/
  );

  assert.match(
    body,
    /approvals\.approval_source[\s\S]*'EXTERNAL_EVIDENCE'/
  );
});

test("009D-3B-1A capability policy remains approval-source based rather than Job-source based", () => {
  const body = region(
    "function professionalCapabilitiesFor(",
    "function safeLogger("
  );

  assert.match(
    body,
    /approval_source === "EXTERNAL_EVIDENCE"/
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

test("009D-3B-1A activation still requires common approval, professional role and Meetro customer role only when applicable", () => {
  const body = region(
    "async function requireActivationAuthority(",
    "async function loadActivation("
  );

  assert.match(
    body,
    /!context\.quote_approval_id/
  );

  assert.match(
    body,
    /context\.approval_source !== "EXTERNAL_EVIDENCE"/
  );

  assert.match(
    body,
    /context\.approved_quote_decision !== "APPROVED"/
  );

  assert.match(
    body,
    /context\.customer_role_active !== true/
  );

  assert.match(
    body,
    /context\.professional_role_active !== true/
  );
});

test("009D-3B-1A deposit gate remains the sole scheduling-payment gate", () => {
  const body = region(
    "async function activateApprovedWorkVisitAuthority(",
    "module.exports ="
  );

  assert.match(
    body,
    /evaluateApprovedWorkDepositGateWithClient/
  );

  assert.match(
    body,
    /if \(!depositGate\.allowed\)/
  );

  assert.match(
    body,
    /schedulingGateFailure\(depositGate\)/
  );
});
