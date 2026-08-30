"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const { getMigrationFiles } = require("../scripts/run-migrations");

const migrationName =
  "202608130002_activate_evaluation_visit_authority.sql";
const sql = readFileSync(
  join(__dirname, "..", "migrations", migrationName),
  "utf8"
);

test("MC-PL-002C retains the governed Evaluation Visit activation migration", () => {
  const migrations = getMigrationFiles();
  assert.equal((migrations.at(-1)?.filename || migrations.at(-1)), "202608300009_add_business_time_settings_authority.sql");
  assert.ok(migrations.some((migration) => migration.filename === migrationName));
  assert.doesNotMatch(sql, /^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/im);
  assert.doesNotMatch(sql, /\b(?:DROP\s+(?:TABLE|COLUMN)|TRUNCATE|DELETE\s+FROM)\b/i);
});

test("Evaluation grants are constrained to the exact canonical Evaluation and Job", () => {
  assert.match(sql, /ADD COLUMN IF NOT EXISTS scope_evaluation_id UUID/i);
  assert.match(
    sql,
    /scope_type IN \('job', 'reported_concern', 'evaluation'\)/i
  );
  assert.match(
    sql,
    /scope_type = 'evaluation'[\s\S]*scope_concern_id IS NULL[\s\S]*scope_evaluation_id IS NOT NULL/i
  );
  assert.match(
    sql,
    /FOREIGN KEY \(scope_evaluation_id, job_id\)[\s\S]*REFERENCES canonical_evaluation_job_subjects\(evaluation_id, job_id\)/i
  );
});

test("activation evidence is immutable, idempotent, and exact-subject scoped", () => {
  assert.match(
    sql,
    /CREATE TABLE IF NOT EXISTS canonical_evaluation_visit_authority_activations/i
  );
  assert.match(sql, /UNIQUE \(evaluation_id, job_id\)/i);
  assert.match(
    sql,
    /UNIQUE \(activated_by_participant_id, job_id, idempotency_key\)/i
  );
  assert.match(
    sql,
    /FOREIGN KEY \(evaluation_id, job_id\)[\s\S]*REFERENCES canonical_evaluation_job_subjects\(evaluation_id, job_id\)/i
  );
  assert.match(
    sql,
    /canonical_evaluation_visit_activations_append_only[\s\S]*BEFORE UPDATE OR DELETE/i
  );
});

test("migration creates no grants, Visits, or adjacent lifecycle records", () => {
  assert.doesNotMatch(
    sql,
    /INSERT\s+INTO\s+(?:lifecycle_authority_grants|canonical_visits|canonical_visit_versions|canonical_visit_events|canonical_evaluations|canonical_evaluation_findings|canonical_recommendations|canonical_quotes|canonical_workstreams|jobs)/i
  );
  assert.match(sql, /creates no activation, capability grant, Visit, Evaluation/i);
});
