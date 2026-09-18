"use strict";

const assert =
  require("node:assert/strict");

const {
  readFileSync,
} = require("node:fs");

const test =
  require("node:test");

const source = readFileSync(
  "server/authorization/findingService.js",
  "utf8"
);


test(
  "Finding authority reuses certified source-aware Evaluation Job resolver",
  () => {
    assert.match(
      source,
      /evaluationJobRuntimeInternals/
    );

    assert.match(
      source,
      /resolveJobEvaluationContext/
    );

    assert.match(
      source,
      /finding:evaluation_job_subject/
    );
  }
);


test(
  "Finding context no longer globally requires Request Selection",
  () => {
    assert.doesNotMatch(
      source,
      /INNER JOIN request_selections/i
    );

    assert.doesNotMatch(
      source,
      /INNER JOIN posts[\s\S]*INNER JOIN request_relationships[\s\S]*INNER JOIN request_selections/i
    );
  }
);


test(
  "Finding context accepts ordinary request and business customer Evaluation subjects",
  () => {
    assert.match(
      source,
      /source_context_type IN \([\s\S]*'ordinary_request'[\s\S]*'business_customer'/i
    );

    assert.match(
      source,
      /canonical_evaluation_job_subjects\.source_context_type =[\s\S]*commercial_authority_aggregates\.source_context_type/i
    );
  }
);


test(
  "exact Job source identity must match resolver truth",
  () => {
    assert.match(
      source,
      /jobContext\.job_source_type !==[\s\S]*subject\.job_source_type/i
    );

    assert.match(
      source,
      /jobContext\.source_context_type !==[\s\S]*subject\.source_context_type/i
    );

    assert.match(
      source,
      /business_customer_job_source_id/i
    );
  }
);


test(
  "Finding projection is nullable for external Request identity",
  () => {
    assert.match(
      source,
      /requestId:[\s\S]*context\.job_request_id == null[\s\S]*\? null/i
    );

    assert.match(
      source,
      /relationshipId:[\s\S]*context\.relationship_id == null[\s\S]*\? null/i
    );

    assert.match(
      source,
      /jobSourceType:[\s\S]*context\.job_source_type/i
    );
  }
);


test(
  "Finding to Reported Concern link remains request-backed only",
  () => {
    const start =
      source.indexOf(
        "async function linkFindingConcern("
      );

    const end =
      source.indexOf(
        "async function addFindingEvidenceReference(",
        start
      );

    const command =
      source.slice(start, end);

    assert.match(
      command,
      /context\.source_context_type !==[\s\S]*"ordinary_request"/i
    );

    assert.match(
      command,
      /context\.job_request_id == null/i
    );

    assert.match(
      command,
      /FINDING_CONCERN_LINK_UNAVAILABLE/i
    );

    assert.match(
      command,
      /FROM reported_concerns/i
    );
  }
);


test(
  "Finding runtime does not fabricate external customer authority",
  () => {
    assert.doesNotMatch(
      source,
      /INSERT INTO relationship_participants/i
    );

    assert.doesNotMatch(
      source,
      /CUSTOMER_REPRESENTATIVE/
    );

    assert.doesNotMatch(
      source,
      /INSERT INTO request_relationships/i
    );

    assert.doesNotMatch(
      source,
      /INSERT INTO request_selections/i
    );
  }
);


test(
  "Finding runtime remains outside Visit Quote and Work execution",
  () => {
    assert.doesNotMatch(
      source,
      /canonical_visit_external_confirmation_evidence/i
    );

    assert.doesNotMatch(
      source,
      /INSERT INTO canonical_quotes/i
    );

    assert.doesNotMatch(
      source,
      /INSERT INTO canonical_work/i
    );
  }
);
