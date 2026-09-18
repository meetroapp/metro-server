"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const service =
  require("../server/authorization/quoteDraftService");

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

function region(start, end) {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);

  assert.notEqual(a, -1, `missing ${start}`);
  assert.notEqual(b, -1, `missing ${end}`);

  return source.slice(a, b);
}

test("009D-2C-1 Quote capabilities retain authenticated customer approve and decline authority", () => {
  assert.equal(
    service.QUOTE_CAPABILITIES.APPROVE,
    "quote.approve"
  );

  assert.equal(
    service.QUOTE_CAPABILITIES.DECLINE,
    "quote.decline"
  );
});

test("009D-2C-1 customer Quote context is Request-Relationship backed and does not require Request Selection", () => {
  const body = region(
    "async function loadCustomerQuoteContext(",
    "async function requireSavedEvaluation("
  );

  assert.match(
    body,
    /posts\.id = jobs\.job_request_id/
  );

  assert.match(
    body,
    /posts\.id = quotes\.job_request_id/
  );

  assert.match(
    body,
    /relationships\.id = quotes\.relationship_id/
  );

  assert.match(
    body,
    /relationships\.id = jobs\.source_request_relationship_id/
  );

  assert.match(
    body,
    /participants\.request_relationship_id = quotes\.relationship_id/
  );

  assert.match(
    body,
    /participants\.user_id = \$2/
  );

  assert.match(
    body,
    /roles\.role = 'CUSTOMER_REPRESENTATIVE'/
  );

  assert.doesNotMatch(
    body,
    /\brequest_selections\b/
  );

  assert.doesNotMatch(
    body,
    /source_request_selection_id/
  );
});

test("009D-2C-1 customer authority requires active Relationship, CUSTOMER_REPRESENTATIVE, and lifecycle capability", () => {
  const body = region(
    "async function requireCustomerQuoteAuthority(",
    "async function loadQualifyingCustomerQuoteDelivery("
  );

  assert.match(
    body,
    /context\.relationship_status !== "active"/
  );

  assert.match(
    body,
    /context\.actor_participant_id/
  );

  assert.match(
    body,
    /context\.actor_is_customer_representative !== true/
  );

  assert.match(
    body,
    /hasActiveLifecycleGrant/
  );

  assert.match(
    body,
    /participantId: context\.actor_participant_id/
  );

  assert.match(
    body,
    /capability/
  );

  assert.match(
    body,
    /jobId: context\.job_id/
  );
});

test("009D-2C-1 authenticated customer decision selects quote.approve or quote.decline and never uses external evidence recorder", () => {
  const body = region(
    "async function decideIssuedQuote(",
    "function approveIssuedQuote("
  );

  assert.match(
    body,
    /decision === "APPROVED"[\s\S]*QUOTE_CAPABILITIES\.APPROVE[\s\S]*QUOTE_CAPABILITIES\.DECLINE/
  );

  assert.match(
    body,
    /QUOTE_COMMANDS\.APPROVE/
  );

  assert.match(
    body,
    /QUOTE_COMMANDS\.DECLINE/
  );

  assert.match(
    body,
    /loadCustomerQuoteContext/
  );

  assert.match(
    body,
    /requireCustomerQuoteAuthority/
  );

  assert.match(
    body,
    /loadActiveQuoteGrant/
  );

  assert.match(
    body,
    /canonical_quote_customer_decisions/
  );

  assert.doesNotMatch(
    body,
    /recordExternalQuoteApproval/
  );

  assert.doesNotMatch(
    body,
    /canonical_quote_external_approval_evidence/
  );
});

test("009D-2C-1 approved Meetro customer decision creates common MEETRO_CUSTOMER approval", () => {
  const body = region(
    "async function insertCanonicalQuoteApprovalFromCustomerDecision(",
    "async function decideIssuedQuote("
  );

  assert.match(
    body,
    /INSERT INTO canonical_quote_approvals/
  );

  assert.match(
    body,
    /'MEETRO_CUSTOMER'/
  );

  assert.match(
    body,
    /decisions\.decision = 'APPROVED'/
  );

  assert.match(
    body,
    /decisions\.id/
  );

  assert.match(
    body,
    /external_approval_evidence_id/
  );

  assert.match(
    body,
    /NULL/
  );
});

test("009D-2C-1 approve and decline wrappers stay on authenticated customer decision path", () => {
  const wrappers = region(
    "function approveIssuedQuote(",
    "async function recordExternalQuoteApproval("
  );

  assert.match(
    wrappers,
    /return decideIssuedQuote\(input, "APPROVED"\)/
  );

  assert.match(
    wrappers,
    /return decideIssuedQuote\(input, "DECLINED"\)/
  );

  assert.doesNotMatch(
    wrappers,
    /recordExternalQuoteApproval/
  );
});

test("009D-2C-1 Repeat Meetro remains separate from external business_customer evidence authority", () => {
  const customerPath = region(
    "async function loadCustomerQuoteContext(",
    "async function recordExternalQuoteApproval("
  );

  assert.match(
    source,
    /existing_customer_request/
  );

  assert.match(
    customerPath,
    /CUSTOMER_REPRESENTATIVE/
  );

  assert.match(
    customerPath,
    /canonical_quote_customer_decisions/
  );

  assert.match(
    customerPath,
    /MEETRO_CUSTOMER/
  );

  assert.doesNotMatch(
    customerPath,
    /INSERT INTO canonical_quote_external_approval_evidence/
  );
});
