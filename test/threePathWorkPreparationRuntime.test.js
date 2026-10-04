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
    "workPreparationService.js"
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

test("009D-3C-1A Work Preparation professional context recognizes all four Job origins", () => {
  const body = region(
    "async function loadProfessionalContext(",
    "function requireCapability("
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

test("009D-3C-1A Repeat Meetro preserves fresh Request and Relationship authority", () => {
  const body = region(
    "async function loadProfessionalContext(",
    "function requireCapability("
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

test("009D-3C-1A business_customer uses no fake Meetro Request or customer participant", () => {
  const body = region(
    "async function loadProfessionalContext(",
    "function requireCapability("
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

test("009D-3C-1A business_customer requires exact durable Job customer tuple", () => {
  const body = region(
    "async function loadProfessionalContext(",
    "function requireCapability("
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

test("009D-3C-1A Quick Quote business_document professional context remains separate", () => {
  const body = region(
    "async function loadProfessionalContext(",
    "function requireCapability("
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

test("009D-3C-1A Work Preparation materialization delegates exact approval identity to frozen common approval loader", () => {
  const body = region(
    "async function materializeWorkPreparation(",
    "function validateRevisionItem("
  );

  assert.match(
    body,
    /preWorkDepositServiceInternals\.loadApprovedQuoteApprovalSource/
  );

  assert.match(
    body,
    /approvalId:quoteApprovalId/
  );

  assert.match(
    body,
    /customerDecisionId:decisionId/
  );

  assert.match(
    body,
    /source\.quote_approval_id/
  );

  assert.match(
    body,
    /source\.approval_source/
  );
});

test("009D-3C-1A relationship comparison remains null-safe for both business-owned origins", () => {
  const body = region(
    "async function materializeWorkPreparation(",
    "function validateRevisionItem("
  );

  assert.match(
    body,
    /nullableInteger\(source\.relationship_id\)[\s\S]*nullableInteger\(context\.relationship_id\)/
  );
});

test("009D-3C-1A plan authority remains common Quote approval scoped", () => {
  const body = region(
    "async function grantPlanCapabilities(",
    "function depositProjection("
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
    /quoteApprovalId/
  );

  assert.match(
    body,
    /approvalSource/
  );
});

test("009D-3C-1A deposit commitment still requires SATISFIED canonical evidence", () => {
  const body = region(
    "function depositEvidence(",
    "function commitmentGateFailure("
  );

  assert.match(
    body,
    /gate\.state !== "SATISFIED"/
  );

  assert.match(
    body,
    /gate\.obligation\.latest_state !== "SATISFIED"/
  );

  assert.match(
    body,
    /obligationState: "SATISFIED"/
  );
});

test("009D-3C-1A Work Preparation start evaluator remains exact common-approval and execution scoped", () => {
  const body = region(
    "async function evaluateWorkPreparationStartWithClient(",
    "function workStartFailure("
  );

  assert.match(
    body,
    /loadPlanByApproval\(client, jobId, quoteApprovalId, decisionId/
  );

  assert.match(
    body,
    /plan\.quote_approval_id !== execution\.quote_approval_id/
  );

  assert.match(
    body,
    /plan\.approved_customer_decision_id !== execution\.approved_customer_decision_id/
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
