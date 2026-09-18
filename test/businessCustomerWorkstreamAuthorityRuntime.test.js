"use strict";

const assert = require("node:assert/strict");
const {
  readFileSync,
} = require("node:fs");
const {
  join,
} = require("node:path");
const test = require("node:test");

const workflow = readFileSync(
  join(
    __dirname,
    "..",
    "server",
    "workflow",
    "workstreamService.js"
  ),
  "utf8"
);

const sharedBusiness = readFileSync(
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
  const a = workflow.indexOf(start);
  const b = workflow.indexOf(end, a);

  assert.notEqual(
    a,
    -1,
    `missing ${start}`
  );

  assert.notEqual(
    b,
    -1,
    `missing ${end}`
  );

  return workflow.slice(a, b);
}

test(
  "full business_customer Workstream context uses exact local durable authority",
  () => {
    const body = region(
      "async function loadBusinessCustomerWorkflowContext(",
      "async function loadJobContext("
    );

    assert.match(
      body,
      /jobs\.source_type\s*=\s*[\s\S]*'business_customer'/
    );

    assert.match(
      body,
      /business_customer_job_sources/
    );

    assert.match(
      body,
      /job_customer_parties/
    );

    assert.match(
      body,
      /sources\.id[\s\S]*jobs\.source_business_customer_job_id/
    );

    assert.match(
      body,
      /professional\.source_evidence_type[\s\S]*'business_customer'/
    );

    assert.match(
      body,
      /contacts\.status\s*=\s*'ACTIVE'/
    );

    assert.match(
      body,
      /roles\.role\s*=\s*'CUSTOMER'[\s\S]*roles\.ended_at IS NULL/
    );

    assert.match(
      body,
      /roles\.role[\s\S]*'PRIMARY_PROFESSIONAL'/
    );

    assert.match(
      body,
      /participant_role_revocations/
    );

    assert.match(
      body,
      /revoked\.id IS NULL/
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

    assert.doesNotMatch(
      body,
      /business_document_working_drafts/
    );

    assert.doesNotMatch(
      body,
      /\bposts\b/
    );

    assert.doesNotMatch(
      body,
      /\brequest_relationships\b/
    );
  }
);

test(
  "Workstream context preserves all four normal Job-origin resolvers without conflating them",
  () => {
    const body = region(
      "async function loadJobContext(",
      "async function requireAuthority("
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
      /loadBusinessCustomerWorkflowContext/
    );

    assert.match(
      body,
      /loadBusinessJobContext/
    );

    assert.ok(
      body.indexOf(
        "loadBusinessCustomerWorkflowContext"
      ) <
      body.indexOf(
        "loadBusinessJobContext"
      ),
      "business_customer must resolve locally before Quick Quote fallback"
    );
  }
);

test(
  "shared Quick Quote command authority remains strict and untouched",
  () => {
    assert.match(
      sharedBusiness,
      /WHERE jobs\.source_type='business_document'/
    );

    assert.match(
      sharedBusiness,
      /business_document_working_drafts/
    );

    assert.match(
      sharedBusiness,
      /contacts\.status='ACTIVE'/
    );

    assert.match(
      sharedBusiness,
      /roles\.ended_at IS NULL/
    );

    assert.doesNotMatch(
      sharedBusiness,
      /business_customer_job_sources/
    );
  }
);
