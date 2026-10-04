"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");

const migration = readFileSync(
  "migrations/202609160013_generalize_approved_work_root_job_origins.sql",
  "utf8"
);

test(
  "013 replaces only the shared Approved Work root approval function",
  () => {
    assert.match(
      migration,
      /CREATE OR REPLACE FUNCTION\s+bind_common_execution_root_approval\(\)/i
    );

    assert.doesNotMatch(
      migration,
      /\bCREATE\s+TRIGGER\b/i
    );

    assert.doesNotMatch(
      migration,
      /\bALTER\s+TABLE\b/i
    );

    assert.doesNotMatch(
      migration,
      /\b(?:INSERT\s+INTO|UPDATE\s+\S+\s+SET|DELETE\s+FROM|TRUNCATE)\b/i
    );
  }
);

test(
  "013 maps both authenticated Meetro Job origins to MEETRO_CUSTOMER",
  () => {
    assert.match(
      migration,
      /approval\.approval_source\s*=\s*'MEETRO_CUSTOMER'[\s\S]*origin\.source_type\s+NOT\s+IN\s*\([\s\S]*'ordinary_request_selection'[\s\S]*'existing_customer_request'/i
    );

    assert.match(
      migration,
      /NEW\.approved_customer_decision\s*:=\s*COALESCE[\s\S]*'APPROVED'/i
    );

    assert.doesNotMatch(
      migration,
      /Meetro approval requires marketplace origin/i
    );
  }
);

test(
  "013 maps both business-owned Job origins to EXTERNAL_EVIDENCE",
  () => {
    assert.match(
      migration,
      /approval\.approval_source\s*=\s*'EXTERNAL_EVIDENCE'[\s\S]*origin\.source_type\s+NOT\s+IN\s*\([\s\S]*'business_document'[\s\S]*'business_customer'/i
    );

    assert.match(
      migration,
      /NEW\.customer_participant_id[\s\S]*IS NOT NULL/i
    );

    assert.match(
      migration,
      /NEW\.approved_customer_decision[\s\S]*IS NOT NULL/i
    );

    assert.match(
      migration,
      /actor\.request_relationship_id[\s\S]*IS NULL/i
    );
  }
);

test(
  "013 preserves exact common approval and Job provenance binding",
  () => {
    assert.match(
      migration,
      /FROM canonical_quote_approvals/i
    );

    assert.match(
      migration,
      /a\.job_id\s*=\s*NEW\.job_id/i
    );

    assert.match(
      migration,
      /a\.quote_id\s*=\s*NEW\.quote_id/i
    );

    assert.match(
      migration,
      /a\.issued_quote_version[\s\S]*NEW\.issued_quote_version/i
    );

    assert.match(
      migration,
      /a\.issued_integrity_hash[\s\S]*NEW\.source_integrity_hash/i
    );

    assert.match(
      migration,
      /NEW\.job_request_id[\s\S]*IS DISTINCT FROM[\s\S]*origin\.job_request_id/i
    );

    assert.match(
      migration,
      /NEW\.relationship_id[\s\S]*IS DISTINCT FROM[\s\S]*origin\.source_request_relationship_id/i
    );

    assert.match(
      migration,
      /NEW\.approved_customer_decision_id[\s\S]*IS DISTINCT FROM[\s\S]*approval\.customer_decision_id/i
    );
  }
);
