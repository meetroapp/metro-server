"use strict";

const assert = require("node:assert/strict");
const { readFileSync, readdirSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const root = join(__dirname, "..");
const migrationName = "202608100002_create_recommendation_hierarchy_foundation.sql";
const sql = readFileSync(join(root, "migrations", migrationName), "utf8");
const readme = readFileSync(join(root, "migrations", "README.md"), "utf8");

test("Slice 004 is one additive migration after Workstream foundation", () => {
  const migrations = readdirSync(join(root, "migrations"))
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort();
  assert.equal(migrations.length, 45);
  const index = migrations.indexOf(migrationName);
  assert.equal(migrations[index - 1], "202608100001_create_workstream_activity_foundation.sql");
  assert.equal(migrations[index + 1], "202608100003_create_canonical_quote_scope_foundation.sql");
  assert.equal(migrations[index + 2], "202608100004_create_quote_composition_feedback.sql");
  assert.doesNotMatch(sql, /\b(?:DROP TABLE|TRUNCATE|DELETE FROM)\b/i);
  assert.doesNotMatch(
    sql,
    /\b(?:INSERT INTO|UPDATE)\s+(?:jobs|posts|reported_concerns|canonical_evaluations|canonical_evaluation_findings|canonical_workstreams)\b/i
  );
  assert.match(readme, new RegExp(migrationName));
});

test("Recommendation identity, versions, and hierarchy are restrictive", () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS canonical_recommendations/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS canonical_recommendation_versions/i);
  assert.match(sql, /kind IN \('PRIMARY', 'ALTERNATIVE'\)/i);
  assert.match(sql, /primary_recommendation_id <> id/i);
  assert.match(
    sql,
    /FOREIGN KEY \([\s\S]*primary_recommendation_id,[\s\S]*job_id,[\s\S]*finding_id,[\s\S]*primary_recommendation_kind[\s\S]*\)[\s\S]*REFERENCES canonical_recommendations\(id, job_id, finding_id, kind\)/i
  );
  assert.match(
    sql,
    /FOREIGN KEY \(finding_id, evaluation_id, job_id\)[\s\S]*REFERENCES canonical_evaluation_findings\(id, evaluation_id, job_id\)/i
  );
  assert.match(sql, /PRIMARY KEY \(recommendation_id, version\)/i);
  assert.match(sql, /integrity_hash ~ '\^\[0-9a-f\]\{64\}\$'/i);
  assert.doesNotMatch(sql, /ON DELETE CASCADE/i);
});

test("states, constraints, and disposition evidence remain separate", () => {
  for (const status of [
    "ACTIVE",
    "ACCEPTED",
    "DECLINED",
    "DEFERRED",
    "SUPERSEDED",
    "WITHDRAWN",
    "EXCLUDED_FROM_CURRENT_QUOTE",
    "SEPARATE_PROPOSAL_REQUIRED",
  ]) {
    assert.match(sql, new RegExp(`'${status}'`));
  }
  assert.match(sql, /CREATE TABLE IF NOT EXISTS canonical_customer_constraints/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS canonical_recommendation_disposition_events/i);
  assert.match(sql, /PROFESSIONAL_RECORDED_CUSTOMER_DECISION/i);
  assert.match(sql, /recommendation_version = previous_recommendation_version \+ 1/i);
  assert.match(sql, /disposition = 'SUPERSEDED' AND replacement_recommendation_id IS NOT NULL/i);
});

test("capabilities and durable commands are Recommendation-only", () => {
  for (const capability of [
    "recommendation.create",
    "recommendation.read",
    "recommendation.transition",
    "customer_constraint.record",
  ]) {
    assert.match(sql, new RegExp(`'${capability.replaceAll(".", "\\.")}'`));
  }
  assert.match(sql, /CREATE TABLE IF NOT EXISTS canonical_recommendation_command_idempotency/i);
  assert.doesNotMatch(sql, /'(?:quote\.[^']+|procurement\.[^']+|scheduling\.[^']+|job\.complete)'/i);
  assert.doesNotMatch(
    sql,
    /CREATE TABLE IF NOT EXISTS\s+(?:canonical_)?(?:quotes?|procurement|schedules?)\b/i
  );
});

test("Recommendation business history is append-only", () => {
  for (const table of [
    "canonical_recommendations",
    "canonical_recommendation_versions",
    "canonical_customer_constraints",
    "canonical_recommendation_disposition_events",
  ]) {
    assert.match(sql, new RegExp(`'${table}'`));
  }
  assert.match(sql, /prevent_lifecycle_append_only_mutation/i);
});
