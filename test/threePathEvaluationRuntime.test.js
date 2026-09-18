"use strict";

const assert =
  require("node:assert/strict");
const {
  readFileSync,
} = require("node:fs");
const test =
  require("node:test");

const {
  evaluationJobRuntimeInternals,
} = require(
  "../server/authorization/evaluationService"
);

const source = readFileSync(
  "server/authorization/evaluationService.js",
  "utf8"
);

test(
  "Evaluation exposes one source-aware Job resolver",
  () => {
    assert.equal(
      typeof evaluationJobRuntimeInternals
        .resolveJobEvaluationContext,
      "function"
    );

    assert.equal(
      typeof evaluationJobRuntimeInternals
        .requireJobEvaluationAuthority,
      "function"
    );

    assert.doesNotMatch(
      source,
      /resolveOrdinaryJobContext/
    );
  }
);

test(
  "marketplace Evaluation still requires exact Request Selection",
  () => {
    assert.match(
      source,
      /jobs\.source_type =\s*'ordinary_request_selection'[\s\S]*request_selections\.id IS NOT NULL/i
    );

    assert.match(
      source,
      /source_evidence_type =\s*'request_selection'/i
    );
  }
);

test(
  "repeat Meetro Evaluation explicitly requires no Selection",
  () => {
    assert.match(
      source,
      /jobs\.source_type =\s*'existing_customer_request'[\s\S]*posts\.request_origin =\s*'existing_customer_request'[\s\S]*ordinary_authority_source =\s*'existing_customer_request'[\s\S]*source_request_selection_id IS NULL[\s\S]*request_selections\.id IS NULL/i
    );

    assert.match(
      source,
      /source_evidence_type =\s*'existing_customer_request'/i
    );
  }
);

test(
  "business customer Evaluation has professional-only durable customer authority",
  () => {
    assert.match(
      source,
      /jobs\.source_type =\s*'business_customer'/i
    );

    assert.match(
      source,
      /jobs\.job_request_id IS NULL[\s\S]*jobs\.source_request_selection_id IS NULL[\s\S]*jobs\.source_request_relationship_id IS NULL[\s\S]*jobs\.originating_business_document_id IS NULL/i
    );

    assert.match(
      source,
      /business_contacts\.status = 'ACTIVE'/i
    );

    assert.match(
      source,
      /business_contact_roles\.role = 'CUSTOMER'/i
    );

    assert.match(
      source,
      /business_contact_roles\.ended_at IS NULL/i
    );

    assert.match(
      source,
      /source_evidence_type =\s*'business_customer'/i
    );
  }
);

test(
  "business_document is not admitted to full-workflow Job Evaluation resolver",
  () => {
    const start =
      source.indexOf(
        "async function resolveJobEvaluationContext"
      );

    const end =
      source.indexOf(
        "async function requireJobEvaluationAuthority",
        start
      );

    const resolver =
      source.slice(start, end);

    assert.doesNotMatch(
      resolver,
      /jobs\.source_type =\s*'business_document'/i
    );
  }
);

test(
  "Evaluation subject persists exact Job origin",
  () => {
    assert.match(
      source,
      /INSERT INTO canonical_evaluation_job_subjects[\s\S]*subject_type,[\s\S]*source_context_type,[\s\S]*job_id,[\s\S]*job_source_type,[\s\S]*business_customer_job_source_id/i
    );
  }
);

test(
  "business customer supports remote and governed physical Evaluation completion",
  () => {
    const source = require("node:fs").readFileSync(
      "server/authorization/evaluationService.js",
      "utf8"
    );

    assert.doesNotMatch(
      source,
      /BUSINESS_CUSTOMER_PHYSICAL_EVALUATION_UNAVAILABLE/
    );

    assert.match(
      source,
      /requireCompletedEvaluationVisitEvidence/
    );

    assert.match(
      source,
      /PHYSICAL_EVALUATION_REMOTE_PROVENANCE_CONFLICT/
    );

    assert.match(
      source,
      /REMOTE_EVALUATION_PHYSICAL_PROVENANCE_CONFLICT/
    );
  }
);

test(
  "Evaluation evidence preserves nullable Request Relationship",
  () => {
    assert.match(
      source,
      /context\.relationship_id == null[\s\S]*\? null[\s\S]*Number\(context\.relationship_id\)/i
    );
  }
);

test(
  "009C enables physical business customer Evaluation provenance while Quote remains separate",
  () => {
    const source = require("node:fs").readFileSync(
      "server/authorization/evaluationService.js",
      "utf8"
    );

    assert.doesNotMatch(
      source,
      /BUSINESS_CUSTOMER_EVALUATION_VISIT_UNAVAILABLE/
    );

    assert.match(
      source,
      /loadEvaluationVisitForDraft/
    );

    assert.match(
      source,
      /canonical_visit_evaluation_links/
    );

    assert.doesNotMatch(
      source,
      /INSERT INTO\s+canonical_quotes/i
    );
  }
);
