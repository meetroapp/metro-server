"use strict";

const assert = require("node:assert/strict");
const { readFileSync, readdirSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const root = join(__dirname, "..");
const migrationName =
  "202608100001_create_workstream_activity_foundation.sql";
const sql = readFileSync(join(root, "migrations", migrationName), "utf8");
const readme = readFileSync(join(root, "migrations", "README.md"), "utf8");

test("Slice 003 migration is the unique additive migration after Slice 002", () => {
  const migrations = readdirSync(join(root, "migrations"))
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort();

  assert.equal((migrations.at(-1)?.filename || migrations.at(-1)), "202608300007_create_business_job_field_operations_authority.sql");
  const index = migrations.indexOf(migrationName);
  assert.equal(
    migrations[index + 1],
    "202608100002_create_recommendation_hierarchy_foundation.sql"
  );
  assert.equal(
    migrations[index + 2],
    "202608100003_create_canonical_quote_scope_foundation.sql"
  );
  assert.equal(
    migrations[index + 3],
    "202608100004_create_quote_composition_feedback.sql"
  );
  assert.equal(
    migrations.filter((name) => name.startsWith("202608100001_")).length,
    1
  );
  assert.doesNotMatch(sql, /\b(?:DROP TABLE|TRUNCATE|DELETE FROM)\b/i);
  assert.doesNotMatch(
    sql,
    /\b(?:INSERT INTO|UPDATE)\s+(?:jobs|posts|reported_concerns|canonical_evaluation_findings|canonical_evaluation_finding_versions)\b/i
  );
  assert.match(sql, /INSERT INTO lifecycle_capabilities/i);
  assert.match(readme, new RegExp(migrationName));
});

test("Workstream identity and append-only versions preserve independent state", () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS canonical_workstreams/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS canonical_workstream_versions/i);
  assert.match(sql, /UNIQUE \(job_id, sequence\)/i);
  assert.match(
    sql,
    /FOREIGN KEY \(created_by_participant_id, job_id\)[\s\S]*REFERENCES relationship_participants\(id, job_id\)[\s\S]*ON DELETE RESTRICT/i
  );
  assert.match(sql, /PRIMARY KEY \(workstream_id, version\)/i);
  for (const state of [
    "OPEN",
    "ACTIVE",
    "BLOCKED",
    "COMPLETED",
    "DEFERRED",
    "EXCLUDED",
  ]) {
    assert.match(sql, new RegExp(`'${state}'`));
  }
  assert.match(sql, /canonical_workstream_job_order_idx/i);
  assert.match(sql, /canonical_workstream_job_state_idx/i);
});

test("runtime foundation registers only bounded capabilities and durable commands", () => {
  for (const capability of [
    "workstream.create",
    "workstream.read",
    "finding.assign_workstream",
    "work_activity.create",
    "work_activity.progress",
    "work_activity.read",
    "work_obligation.create",
    "work_obligation.read",
    "finding.resolve",
    "work_obligation.transition",
    "workstream.complete",
  ]) {
    assert.match(sql, new RegExp(`'${capability.replace(".", "\\.")}'`));
  }
  assert.doesNotMatch(
    sql,
    /'(?:job\.complete|quote\.[^']+|recommendation\.[^']+)'/i
  );
  assert.match(
    sql,
    /CREATE TABLE IF NOT EXISTS canonical_workflow_command_idempotency/i
  );
  assert.match(sql, /request_fingerprint ~ '\^\[0-9a-f\]\{64\}\$'/i);
  assert.match(sql, /result_reference JSONB/i);
  assert.match(
    sql,
    /UNIQUE \([\s\S]*actor_participant_id,[\s\S]*command_name,[\s\S]*command_scope,[\s\S]*idempotency_key[\s\S]*\)/i
  );
  assert.match(sql, /canonical_workflow_command_job_idx/i);
});

test("Finding assignment is optional, singular, and same-Job constrained", () => {
  assert.match(
    sql,
    /CREATE TABLE IF NOT EXISTS canonical_finding_workstream_assignments/i
  );
  assert.match(sql, /finding_id UUID NOT NULL UNIQUE/i);
  assert.match(
    sql,
    /FOREIGN KEY \(finding_id, job_id\)[\s\S]*REFERENCES canonical_evaluation_findings\(id, job_id\)[\s\S]*ON DELETE RESTRICT/i
  );
  assert.match(
    sql,
    /FOREIGN KEY \(workstream_id, job_id\)[\s\S]*REFERENCES canonical_workstreams\(id, job_id\)[\s\S]*ON DELETE RESTRICT/i
  );
  assert.doesNotMatch(
    sql,
    /ALTER TABLE canonical_evaluation_findings[\s\S]*ADD COLUMN[\s\S]*workstream/i
  );
});

test("Work Activity versions separate status, performance, and temporary truth", () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS canonical_work_activities/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS canonical_work_activity_versions/i);
  assert.match(
    sql,
    /status IN \('PLANNED', 'IN_PROGRESS', 'DONE', 'CANCELLED'\)/i
  );
  assert.match(sql, /temporary_intervention BOOLEAN NOT NULL DEFAULT FALSE/i);
  assert.match(
    sql,
    /temporary_intervention = TRUE[\s\S]*temporary_details IS NOT NULL[\s\S]*char_length\(btrim\(temporary_details\)\)/i
  );
  assert.match(sql, /status <> 'DONE' OR performed_at IS NOT NULL/i);
  assert.doesNotMatch(
    sql,
    /(?:TRIGGER|FUNCTION)[\s\S]{0,300}DONE[\s\S]{0,300}RESOLVED/i
  );
});

test("resolution events are evidence for an exact immutable Finding state", () => {
  assert.match(
    sql,
    /CREATE TABLE IF NOT EXISTS canonical_finding_resolution_events/i
  );
  assert.match(
    sql,
    /canonical_evaluation_finding_version_resolution_uidx/i
  );
  assert.match(
    sql,
    /FOREIGN KEY \([\s\S]*finding_id,[\s\S]*finding_version,[\s\S]*job_id,[\s\S]*resolution_state[\s\S]*\)[\s\S]*REFERENCES canonical_evaluation_finding_versions\([\s\S]*finding_id,[\s\S]*version,[\s\S]*job_id,[\s\S]*resolution_state/i
  );
  assert.match(sql, /previous_finding_version INTEGER NOT NULL/i);
  assert.match(sql, /previous_resolution_state TEXT NOT NULL/i);
  assert.match(sql, /finding_version = previous_finding_version \+ 1/i);
  assert.match(
    sql,
    /previous_resolution_state = 'OPEN'[\s\S]*PARTIALLY_RESOLVED[\s\S]*RESOLVED[\s\S]*DEFERRED/i
  );
  for (const state of ["OPEN", "PARTIALLY_RESOLVED", "RESOLVED", "DEFERRED"]) {
    assert.match(sql, new RegExp(`'${state}'`));
  }
  assert.doesNotMatch(
    sql,
    /UPDATE\s+canonical_evaluation_finding_versions/i
  );
});

test("minimal obligations support outstanding work without Quote authority", () => {
  assert.match(
    sql,
    /CREATE TABLE IF NOT EXISTS canonical_workstream_obligations/i
  );
  assert.match(
    sql,
    /CREATE TABLE IF NOT EXISTS canonical_workstream_obligation_versions/i
  );
  assert.match(sql, /status IN \('OPEN', 'SATISFIED', 'DEFERRED', 'EXCLUDED'\)/i);
  assert.match(
    sql,
    /FOREIGN KEY \(source_finding_id, workstream_id, job_id\)[\s\S]*REFERENCES canonical_finding_workstream_assignments/i
  );
  assert.doesNotMatch(sql, /quote_id|quote_request_id|recommendation_id/i);
  assert.match(sql, /canonical_workstream_obligation_state_idx/i);
});

test("all Slice 003 records are restrictive and no state propagation is installed", () => {
  for (const table of [
    "canonical_workstreams",
    "canonical_workstream_versions",
    "canonical_finding_workstream_assignments",
    "canonical_work_activities",
    "canonical_work_activity_versions",
    "canonical_finding_resolution_events",
    "canonical_workstream_obligations",
    "canonical_workstream_obligation_versions",
  ]) {
    assert.match(sql, new RegExp(`'${table}'`));
  }
  assert.doesNotMatch(sql, /ON DELETE CASCADE/i);
  assert.match(sql, /prevent_lifecycle_append_only_mutation/i);
  assert.doesNotMatch(sql, /ALTER TABLE\s+jobs\s+ADD COLUMN[\s\S]*state/i);
  assert.doesNotMatch(sql, /CREATE TABLE[^;]*specialist/i);
  assert.doesNotMatch(sql, /CREATE TABLE[^;]*recommendation/i);
  assert.doesNotMatch(sql, /CREATE TABLE[^;]*quote/i);
});
