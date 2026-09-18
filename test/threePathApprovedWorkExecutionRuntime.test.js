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
    "approvedWorkExecutionService.js"
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

test("009D-3C-1B execution context recognizes all four Job origins", () => {
  const body = region(
    "async function loadProfessionalContext(",
    "function unavailable("
  );

  for (const value of [
    "ordinary_request_selection",
    "existing_customer_request",
    "business_document",
    "business_customer",
  ]) {
    assert.match(body, new RegExp(value));
  }
});

test("009D-3C-1B Repeat Meetro preserves Request Relationship and participant provenance", () => {
  const body = region(
    "async function loadProfessionalContext(",
    "function unavailable("
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
    /professional\.source_evidence_type[\s\S]*'existing_customer_request'/
  );

  assert.match(
    body,
    /jobs\.source_request_selection_id IS NULL/
  );

  assert.match(
    body,
    /customer\.id IS NOT NULL/
  );
});

test("009D-3C-1B business_customer never fabricates Meetro Request Relationship or customer participant authority", () => {
  const body = region(
    "async function loadProfessionalContext(",
    "function unavailable("
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

test("009D-3C-1B business_customer requires exact durable customer Job tuple", () => {
  const body = region(
    "async function loadProfessionalContext(",
    "function unavailable("
  );

  assert.match(
    body,
    /LEFT JOIN job_customer_parties customer_parties/
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
    /LEFT JOIN business_customer_job_sources business_sources/
  );

  assert.match(
    body,
    /business_sources\.id[\s\S]*jobs\.source_business_customer_job_id/
  );

  assert.match(
    body,
    /customer_parties\.job_id IS NOT NULL/
  );

  assert.match(
    body,
    /business_sources\.id IS NOT NULL/
  );
});

test("009D-3C-1B Quick Quote execution path remains business_document", () => {
  const body = region(
    "async function loadProfessionalContext(",
    "function unavailable("
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
});

test("009D-3C-1B execution materialization stays common-approval based", () => {
  const body = region(
    "async function materializeApprovedWorkExecution(",
    "async function loadBindingForWorkstream("
  );

  assert.match(
    body,
    /loadApprovedDecisionSource/
  );

  assert.match(
    body,
    /quoteApprovalId/
  );

  assert.match(
    body,
    /source\.quote_approval_id/
  );

  assert.match(
    body,
    /source\.approval_source/
  );

  assert.match(
    body,
    /nullableInteger\(source\.relationship_id\)[\s\S]*nullableInteger\(context\.relationship_id\)/
  );
});

test("009D-3C-1B execution grants remain common Quote approval scoped", () => {
  const body = region(
    "async function insertExecutionGrants(",
    "async function listApprovedWorkExecutions("
  );

  assert.match(
    body,
    /scope_quote_approval_id/
  );

  assert.match(
    body,
    /scope_quote_approval_source/
  );

  assert.match(
    body,
    /execution\.quote_approval_id/
  );

  assert.match(
    body,
    /execution\.approval_source/
  );
});

test("009D-3C-1B external execution capabilities remain approval-source based", () => {
  const body = region(
    "async function insertExecutionGrants(",
    "async function listApprovedWorkExecutions("
  );

  assert.match(
    body,
    /execution\.approval_source === "EXTERNAL_EVIDENCE"/
  );

  assert.match(
    body,
    /"visit\.start"/
  );

  assert.match(
    body,
    /"visit\.complete"/
  );
});

test("009D-3C-1B Work start keeps canonical deposit and Work Preparation gates", () => {
  const body = region(
    "async function evaluateApprovedWorkStartReadinessWithClient(",
    "async function recordApprovedWorkStartWithClient("
  );

  assert.match(
    body,
    /evaluateApprovedWorkDepositGateWithClient/
  );

  assert.match(
    body,
    /quoteApprovalId: execution\.quote_approval_id/
  );

  assert.match(
    body,
    /PRE_WORK_DEPOSIT_NOT_SATISFIED/
  );

  assert.match(
    body,
    /evaluateWorkPreparationStartWithClient/
  );

  assert.match(
    body,
    /WORK_PREPARATION_NOT_READY/
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

test("009D-3C-1B completion remains exact common-approval lineage", () => {
  const body = region(
    "async function completeApprovedWork(",
    "function childIdempotencyKey("
  );

  assert.match(
    body,
    /loadApprovedDecisionSource/
  );

  assert.match(
    body,
    /quoteApprovalId:execution\.quote_approval_id/
  );

  assert.match(
    body,
    /source\.quote_id !== execution\.quote_id/
  );

  assert.match(
    body,
    /nullableInteger\(source\.relationship_id\)[\s\S]*nullableInteger\(execution\.relationship_id\)/
  );

  assert.match(
    body,
    /source\.customer_participant_id !== execution\.customer_participant_id/
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
