"use strict";

const assert = require("node:assert/strict");
const { readFileSync, readdirSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const root = join(__dirname, "..");
const migrationName =
  "202608090003_create_ordinary_evaluation_finding_foundation.sql";
const migrationPath = join(root, "migrations", migrationName);
const sql = readFileSync(migrationPath, "utf8");
const migrationReadme = readFileSync(
  join(root, "migrations", "README.md"),
  "utf8"
);
const routesSource = readFileSync(
  join(root, "server", "authorization", "evaluations.js"),
  "utf8"
);

test("Slice 002 migration remains the unique additive migration after Slice 001", () => {
  const migrations = readdirSync(join(root, "migrations"))
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort();

  assert.equal((migrations.at(-1)?.filename || migrations.at(-1)), "202608300007_create_business_job_field_operations_authority.sql");
  const index = migrations.indexOf(migrationName);
  assert.equal(
    migrations[index + 1],
    "202608100001_create_workstream_activity_foundation.sql"
  );
  assert.equal(
    migrations[index + 2],
    "202608100002_create_recommendation_hierarchy_foundation.sql"
  );
  assert.equal(
    migrations[index + 3],
    "202608100003_create_canonical_quote_scope_foundation.sql"
  );
  assert.equal(
    migrations[index + 4],
    "202608100004_create_quote_composition_feedback.sql"
  );
  assert.equal(
    migrations.filter((name) => name.startsWith("202608090003_")).length,
    1
  );
  assert.doesNotMatch(sql, /\b(?:DROP TABLE|TRUNCATE|DELETE FROM)\b/i);
  assert.doesNotMatch(
    sql,
    /\bINSERT INTO\s+(?:canonical_evaluations|canonical_evaluation_findings|canonical_finding_concern_links)\b/i
  );
  for (const capability of [
    "evaluation.perform",
    "finding.submit",
    "finding.confirm",
  ]) {
    assert.match(sql, new RegExp(`'${capability.replaceAll(".", "\\.")}'`));
  }
  for (const command of [
    "finding.submit",
    "finding.concern.link",
    "finding.evidence.add",
    "finding.confirm",
  ]) {
    assert.match(sql, new RegExp(`'${command.replaceAll(".", "\\.")}'`));
  }
  assert.doesNotMatch(sql, /\bUPDATE\s+(?:emergency_requests|reported_concerns|posts)\b/i);
});

test("ordinary Job subjects extend canonical Evaluation identity without changing Emergency rows", () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS canonical_evaluation_job_subjects/i);
  assert.match(sql, /subject_type = 'ordinary_job'/i);
  assert.match(sql, /source_context_type = 'ordinary_request'/i);
  assert.match(
    sql,
    /FOREIGN KEY \(evaluation_id, relationship_id\)[\s\S]*REFERENCES canonical_evaluations\(id, relationship_id\)[\s\S]*ON DELETE RESTRICT/i
  );
  assert.match(
    sql,
    /FOREIGN KEY \([\s\S]*evaluation_id,[\s\S]*source_context_type,[\s\S]*job_request_id,[\s\S]*relationship_id[\s\S]*\)[\s\S]*REFERENCES commercial_authority_aggregates/i
  );
  assert.match(
    sql,
    /FOREIGN KEY \(job_id, job_request_id, relationship_id\)[\s\S]*REFERENCES jobs\(id, job_request_id, source_request_relationship_id\)[\s\S]*ON DELETE RESTRICT/i
  );
  assert.doesNotMatch(sql, /ALTER TABLE canonical_evaluation_versions\s+DROP/i);
  assert.doesNotMatch(sql, /INSERT INTO canonical_evaluation_job_subjects/i);
});

test("Finding identity and versions keep confirmation separate from resolution", () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS canonical_evaluation_findings/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS canonical_evaluation_finding_versions/i);
  assert.match(sql, /PRIMARY KEY \(finding_id, version\)/i);
  assert.match(sql, /REFERENCES canonical_evaluation_versions\(evaluation_id, version\)/i);
  assert.match(sql, /REFERENCES relationship_participants\(id, job_id\)/i);
  for (const state of ["PROPOSED", "CONFIRMED", "SUPERSEDED"]) {
    assert.match(sql, new RegExp(`'${state}'`));
  }
  for (const state of ["OPEN", "PARTIALLY_RESOLVED", "RESOLVED", "DEFERRED"]) {
    assert.match(sql, new RegExp(`'${state}'`));
  }
  assert.match(sql, /integrity_hash ~ '\^\[0-9a-f\]\{64\}\$'/i);
  assert.doesNotMatch(
    sql,
    /confirmation_state\s*=\s*'CONFIRMED'[\s\S]{0,200}resolution_state\s*=\s*'RESOLVED'/i
  );
});

test("Finding-to-concern linkage is many-to-many, typed, and restrictive", () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS canonical_finding_concern_links/i);
  assert.match(sql, /relationship_type IN \('EXPLAINS', 'RELATED', 'CONTRADICTS'\)/i);
  assert.match(sql, /UNIQUE \(finding_id, concern_id, relationship_type\)/i);
  assert.match(
    sql,
    /FOREIGN KEY \(concern_id, job_request_id\)[\s\S]*REFERENCES reported_concerns\(id, job_request_id\)[\s\S]*ON DELETE RESTRICT/i
  );
  assert.doesNotMatch(sql, /ON DELETE CASCADE/i);
});

test("Finding evidence stores typed references rather than duplicate media payloads", () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS canonical_finding_evidence_references/i);
  for (const evidenceType of [
    "PROFESSIONAL_OBSERVATION",
    "PHOTO_MEDIA",
    "SPECIALIST_CONTRIBUTION",
    "MEASUREMENT",
    "COMMUNICATION",
    "AI_PROPOSAL_LINEAGE",
  ]) {
    assert.match(sql, new RegExp(`'${evidenceType}'`));
  }
  assert.match(sql, /reference_namespace TEXT NOT NULL/i);
  assert.match(sql, /reference_id TEXT NOT NULL/i);
  assert.doesNotMatch(sql, /(?:BYTEA|media_blob|image_data|file_data)/i);
});

test("new lifecycle records are append-only and future domains remain deferred", () => {
  for (const table of [
    "canonical_evaluation_job_subjects",
    "canonical_evaluation_findings",
    "canonical_evaluation_finding_versions",
    "canonical_finding_concern_links",
    "canonical_finding_evidence_references",
  ]) {
    assert.match(sql, new RegExp(`'${table}'`));
  }
  assert.match(sql, /prevent_lifecycle_append_only_mutation/i);
  assert.doesNotMatch(sql, /\bworkstream_id\b|CREATE TABLE[^;]*workstreams/i);
  assert.doesNotMatch(sql, /CREATE TABLE[^;]*recommendations/i);
  assert.match(routesSource, /\/jobs\/:jobId\/evaluations/i);
  assert.match(routesSource, /\/evaluations\/:evaluationId\/findings/i);
  assert.match(routesSource, /\/findings\/:findingId\/confirm/i);
  assert.match(migrationReadme, new RegExp(migrationName));
  assert.match(migrationReadme, /Workstream linkage is implemented separately/i);
});
