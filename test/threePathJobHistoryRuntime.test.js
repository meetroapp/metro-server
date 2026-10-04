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
    "jobCompletionService.js"
  ),
  "utf8"
);

const shared = readFileSync(
  join(
    __dirname,
    "..",
    "server",
    "relationships",
    "businessJobAuthority.js"
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

test(
  "009D-3C-1C-2B Repeat Meetro History uses Relationship Conversation without fabricated Selection",
  () => {
    const body = region(
      "const HISTORY_BASE_SQL = `",
      "const BUSINESS_DOCUMENT_HISTORY_SQL = `"
    );

    assert.match(
      body,
      /LEFT JOIN request_selections selections/
    );

    assert.match(
      body,
      /LEFT JOIN conversations relationship_conversations/
    );

    assert.match(
      body,
      /'ordinary_request_selection'/
    );

    assert.match(
      body,
      /'existing_customer_request'/
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
      /relationship_conversations\.id IS NOT NULL/
    );
  }
);

test(
  "009D-3C-1C-2B Meetro History totals use canonical Quote approvals",
  () => {
    const body = region(
      "const HISTORY_BASE_SQL = `",
      "const BUSINESS_DOCUMENT_HISTORY_SQL = `"
    );

    assert.match(
      body,
      /canonical_quote_approvals approvals/
    );

    assert.match(
      body,
      /'MEETRO_CUSTOMER'/
    );

    assert.match(
      body,
      /approvals\.issued_quote_version/
    );

    assert.doesNotMatch(
      body,
      /canonical_quote_customer_decisions/
    );
  }
);

test(
  "009D-3C-1C-2B Quick Quote completed History is durable",
  () => {
    const body = region(
      "const BUSINESS_DOCUMENT_HISTORY_SQL = `",
      "const BUSINESS_CUSTOMER_HISTORY_SQL = `"
    );

    assert.match(
      body,
      /'business_document'/
    );

    assert.match(
      body,
      /job_customer_parties parties/
    );

    assert.match(
      body,
      /business_document_working_drafts document/
    );

    assert.match(
      body,
      /'EXTERNAL_EVIDENCE'/
    );

    assert.doesNotMatch(
      body,
      /contacts\.status[\s\S]*'ACTIVE'/
    );

    assert.doesNotMatch(
      body,
      /roles\.ended_at IS NULL/
    );
  }
);

test(
  "009D-3C-1C-2B business_customer completed History uses immutable Job source identity",
  () => {
    const body = region(
      "const BUSINESS_CUSTOMER_HISTORY_SQL = `",
      "async function loadBusinessOwnedHistoryContext("
    );

    assert.match(
      body,
      /business_customer_job_sources sources/
    );

    assert.match(
      body,
      /sources\.id[\s\S]*jobs\.source_business_customer_job_id/
    );

    assert.match(
      body,
      /sources\.created_by_user_id[\s\S]*profiles\.user_id/
    );

    assert.match(
      body,
      /job_customer_parties parties/
    );

    assert.match(
      body,
      /'EXTERNAL_EVIDENCE'/
    );

    assert.doesNotMatch(
      body,
      /contacts\.status[\s\S]*'ACTIVE'/
    );

    assert.doesNotMatch(
      body,
      /roles\.ended_at IS NULL/
    );
  }
);

test(
  "009D-3C-1C-2B business-owned History loader is owner-scoped but not current-action-authority scoped",
  () => {
    const body = region(
      "async function loadBusinessOwnedHistoryContext(",
      "async function listProfessionalJobHistory("
    );

    assert.match(
      body,
      /profiles\.user_id[\s\S]*\$2/
    );

    assert.match(
      body,
      /'business_document'/
    );

    assert.match(
      body,
      /'business_customer'/
    );

    assert.doesNotMatch(
      body,
      /contacts\.status[\s\S]*'ACTIVE'/
    );

    assert.doesNotMatch(
      body,
      /roles\.ended_at IS NULL/
    );

    assert.doesNotMatch(
      body,
      /CURRENT_TIMESTAMP/
    );
  }
);

test(
  "009D-3C-1C-2B professional History list contains all four Job origins",
  () => {
    const body = region(
      "async function listProfessionalJobHistory(",
      "async function getHistoryDetail("
    );

    assert.match(
      body,
      /HISTORY_BASE_SQL/
    );

    assert.match(
      body,
      /BUSINESS_DOCUMENT_HISTORY_SQL/
    );

    assert.match(
      body,
      /BUSINESS_CUSTOMER_HISTORY_SQL/
    );

    assert.match(
      body,
      /loadBusinessOwnedHistoryContext/
    );
  }
);

test(
  "009D-3C-1C-2B professional History detail uses durable business-owned read",
  () => {
    const body = region(
      "async function getHistoryDetail(",
      "const getProfessionalJobHistory"
    );

    assert.match(
      body,
      /loadBusinessOwnedHistoryContext/
    );

    assert.match(
      body,
      /'EXTERNAL_EVIDENCE'/
    );

    assert.match(
      body,
      /approved_total_minor/
    );
  }
);

test(
  "009D-3C-1C-2B null-request business History never reads fabricated Request concern",
  () => {
    const body = region(
      "async function getHistoryDetail(",
      "const getProfessionalJobHistory"
    );

    assert.match(
      body,
      /row\.job_request_id == null[\s\S]*rows: \[\]/
    );

    assert.match(
      body,
      /FROM reported_concerns/
    );
  }
);

test(
  "009D-3C-1C-2B customer History remains Meetro homeowner History",
  () => {
    const body = region(
      "async function getHistoryDetail(",
      "const getProfessionalJobHistory"
    );

    assert.match(
      body,
      /audience === "customer"[\s\S]*relationships\.homeowner_id/
    );

    assert.match(
      body,
      /canMessageProfessional[\s\S]*row\.conversation_id/
    );
  }
);

test(
  "009D-3C-1C-2B History summary uses source-aware completion authority projection",
  () => {
    const body = region(
      "function historySummary(",
      "const HISTORY_BASE_SQL = `"
    );

    assert.match(
      body,
      /\.\.\.completionAuthorityFields\(row\)/
    );
  }
);

test(
  "009D-3C-1C-2B shared business command authority remains strict and untouched",
  () => {
    assert.match(
      shared,
      /WHERE jobs\.source_type='business_document'/
    );

    assert.match(
      shared,
      /contacts\.status='ACTIVE'/
    );

    assert.match(
      shared,
      /roles\.ended_at IS NULL/
    );

    assert.doesNotMatch(
      shared,
      /business_customer_job_sources/
    );
  }
);
