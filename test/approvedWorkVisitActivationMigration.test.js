"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const { getMigrationFiles } = require("../scripts/run-migrations");

const migrationName =
  "202608130003_activate_approved_work_visit_authority.sql";
const sql = readFileSync(
  join(__dirname, "..", "migrations", migrationName),
  "utf8"
);

test("MC-PL-002D retains the governed Approved Work Visit activation migration", () => {
  const migrations = getMigrationFiles();
  assert.equal((migrations[74]?.filename || migrations[74]), "202608310001_create_business_job_customer_message_authority.sql");
  assert.equal((migrations.at(-1)?.filename || migrations.at(-1)), "202609020006_generalize_work_preparation_execution_approval.sql");
  assert.ok(migrations.some((migration) => migration.filename === migrationName));
  assert.doesNotMatch(sql, /^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/im);
  assert.doesNotMatch(sql, /\b(?:DROP\s+(?:TABLE|COLUMN)|TRUNCATE|DELETE\s+FROM)\b/i);
});

test("Approved Work grants are bound to the exact approved Quote decision and Job", () => {
  assert.match(sql, /ADD COLUMN IF NOT EXISTS scope_approved_quote_decision_id UUID/i);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS scope_approved_quote_decision TEXT/i);
  assert.match(
    sql,
    /scope_type IN \('job', 'reported_concern', 'evaluation', 'approved_work'\)/i
  );
  assert.match(
    sql,
    /scope_type = 'approved_work'[\s\S]*scope_evaluation_id IS NULL[\s\S]*scope_approved_quote_decision_id IS NOT NULL[\s\S]*scope_approved_quote_decision = 'APPROVED'/i
  );
  assert.match(
    sql,
    /FOREIGN KEY \([\s\S]*scope_approved_quote_decision_id,[\s\S]*job_id,[\s\S]*scope_approved_quote_decision[\s\S]*\)[\s\S]*REFERENCES canonical_quote_customer_decisions\(id, job_id, decision\)/i
  );
});

test("Approved Work activation evidence is immutable and exact-decision scoped", () => {
  assert.match(
    sql,
    /CREATE TABLE IF NOT EXISTS canonical_approved_work_visit_authority_activations/i
  );
  assert.match(sql, /UNIQUE \(approved_quote_decision_id, job_id\)/i);
  assert.match(sql, /UNIQUE \(quote_id, job_id\)/i);
  assert.match(
    sql,
    /FOREIGN KEY \([\s\S]*approved_quote_decision_id,[\s\S]*quote_id,[\s\S]*job_id,[\s\S]*approved_quote_decision[\s\S]*\)[\s\S]*REFERENCES canonical_quote_customer_decisions/i
  );
  assert.match(
    sql,
    /canonical_approved_work_visit_activations_append_only[\s\S]*BEFORE UPDATE OR DELETE/i
  );
});

test("migration performs no authority activation or business-row inference", () => {
  assert.doesNotMatch(
    sql,
    /INSERT\s+INTO\s+(?:lifecycle_authority_grants|canonical_approved_work_visit_authority_activations|canonical_visits|canonical_visit_versions|canonical_visit_events|canonical_quotes|canonical_quote_customer_decisions|canonical_workstreams|canonical_work_activities|jobs)/i
  );
  assert.match(sql, /creates no activation, capability grant, Visit, Quote/i);
  assert.match(sql, /no historical inference or backfill/i);
});
