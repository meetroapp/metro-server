"use strict";

const assert =
  require("node:assert/strict");

const fs =
  require("node:fs");

const path =
  require("node:path");

const test =
  require("node:test");

const filename =
  "202609190002_generalize_emergency_job_evaluation_quote.sql";

const migration =
  fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "migrations",
      filename
    ),
    "utf8"
  );

test(
  "Emergency commercial bridge migration is additive and creates no lifecycle records",
  () => {
    assert.match(
      migration,
      /canonical_evaluation_job_subjects[\s\S]*emergency_request_id INTEGER/
    );

    assert.match(
      migration,
      /canonical_quotes[\s\S]*emergency_request_id INTEGER/
    );

    assert.match(
      migration,
      /job_source_type[\s\S]*'emergency_request'/
    );

    assert.match(
      migration,
      /source_context_type[\s\S]*'emergency_request'/
    );

    assert.doesNotMatch(
      migration,
      /\bINSERT\s+INTO\s+(?:jobs|canonical_evaluations|canonical_quotes|emergency_requests)\b/i
    );

    assert.doesNotMatch(
      migration,
      /\bUPDATE\s+(?:jobs|canonical_evaluations|canonical_quotes|emergency_requests)\b/i
    );

    assert.doesNotMatch(
      migration,
      /\bDELETE\s+FROM\b/i
    );
  }
);

test(
  "Emergency Evaluation subject proves both exact Job and aggregate identity",
  () => {
    assert.match(
      migration,
      /canonical_evaluation_job_subject_emergency_aggregate_fkey/
    );

    assert.match(
      migration,
      /FOREIGN KEY\s*\(\s*evaluation_id,\s*source_context_type,\s*emergency_request_id,\s*relationship_id\s*\)/
    );

    assert.match(
      migration,
      /canonical_evaluation_job_subject_emergency_job_fkey/
    );

    assert.match(
      migration,
      /FOREIGN KEY\s*\(\s*job_id,\s*job_source_type,\s*emergency_request_id\s*\)/
    );

    assert.match(
      migration,
      /jobs\.source_request_relationship_id =\s*NEW\.relationship_id/
    );

    assert.match(
      migration,
      /jobs\.source_emergency_request_id =\s*NEW\.emergency_request_id/
    );
  }
);

test(
  "Emergency Quote source requires exact request, relationship and canonical Job origin",
  () => {
    assert.match(
      migration,
      /canonical_quote_emergency_job_source_fkey/
    );

    assert.match(
      migration,
      /canonical_quote_emergency_aggregate_source_fkey/
    );

    assert.match(
      migration,
      /source_context_type =\s*'emergency_request'[\s\S]*job_source_type =\s*'emergency_request'/
    );

    assert.match(
      migration,
      /job_request_id IS NULL/
    );

    assert.match(
      migration,
      /relationship_id IS NOT NULL/
    );

    assert.match(
      migration,
      /emergency_request_id IS NOT NULL/
    );

    assert.match(
      migration,
      /canonical_quote_emergency_source_immutable/
    );
  }
);

test(
  "Emergency commercial bridge contains no Start Work, approval, deposit, payment or Invoice authority",
  () => {
    for (const forbidden of [
      "approved_work",
      "deposit_request",
      "invoice_payment",
      "canonical_invoices",
      "startEmergencyWork",
      "work_activity",
    ]) {
      assert.doesNotMatch(
        migration,
        new RegExp(forbidden, "i")
      );
    }
  }
);

test(
  "Emergency Job source composite foreign keys use a non-partial referenced unique key",
  () => {
    const match =
      migration.match(
        /CREATE UNIQUE INDEX IF NOT EXISTS\s+jobs_emergency_request_source_identity_fk_uidx\s+ON jobs\s*\(\s*id,\s*source_type,\s*source_emergency_request_id\s*\)\s*;/i
      );

    assert.ok(
      match,
      "Emergency Job source needs a non-partial composite unique key for PostgreSQL foreign keys."
    );

    assert.doesNotMatch(
      match[0],
      /\bWHERE\b/i
    );

    assert.match(
      migration,
      /FOREIGN KEY\s*\(\s*job_id,\s*job_source_type,\s*emergency_request_id\s*\)[\s\S]*REFERENCES jobs\s*\(\s*id,\s*source_type,\s*source_emergency_request_id\s*\)/i
    );
  }
);
