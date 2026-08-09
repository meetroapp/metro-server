"use strict";

const assert = require("node:assert/strict");
const { readFileSync, readdirSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const repositoryRoot = join(__dirname, "..");
const migrationOne = "202608090001_create_job_lifecycle_concern_foundation.sql";
const migrationTwo = "202608090002_create_job_participant_authority_foundation.sql";
const sqlOne = readFileSync(join(repositoryRoot, "migrations", migrationOne), "utf8");
const sqlTwo = readFileSync(join(repositoryRoot, "migrations", migrationTwo), "utf8");

test("Slice 001 migrations are ordered, additive, and inventoried", () => {
  const migrations = readdirSync(join(repositoryRoot, "migrations"))
    .filter((filename) => filename.endsWith(".sql"))
    .sort();
  const readme = readFileSync(join(repositoryRoot, "migrations", "README.md"), "utf8");

  assert.ok(migrations.indexOf(migrationOne) > migrations.indexOf("202608070003_add_job_request_service_location.sql"));
  assert.equal(migrations.indexOf(migrationTwo), migrations.indexOf(migrationOne) + 1);
  assert.match(readme, new RegExp(migrationOne.replaceAll(".", "\\.")));
  assert.match(readme, new RegExp(migrationTwo.replaceAll(".", "\\.")));
  assert.doesNotMatch(sqlOne, /\b(?:TRUNCATE|DELETE\s+FROM|UPDATE\s+posts\s+SET)\b/i);
  assert.doesNotMatch(sqlTwo, /\b(?:TRUNCATE|DELETE\s+FROM|UPDATE\s+\S+\s+SET)\b/i);
});

test("v1 default and exact canonical Job source prevent fabricated legacy Jobs", () => {
  assert.match(sqlOne, /lifecycle_contract_version SMALLINT NOT NULL[\s\S]*DEFAULT 1/i);
  assert.match(sqlOne, /CHECK \(lifecycle_contract_version IN \(1, 2\)\)/i);
  assert.match(sqlOne, /CREATE TABLE IF NOT EXISTS jobs/i);
  assert.match(sqlOne, /source_request_selection_id BIGINT NOT NULL/i);
  assert.match(sqlOne, /source_request_relationship_id INTEGER NOT NULL/i);
  assert.match(sqlOne, /jobs_canonical_selection_source_fk/i);
  assert.match(sqlOne, /REFERENCES request_selections\([\s\S]*id,[\s\S]*request_relationship_id,[\s\S]*post_id,[\s\S]*selected_by_user_id/i);
  assert.match(sqlOne, /jobs_job_request_key UNIQUE \(job_request_id\)/i);
  assert.doesNotMatch(sqlOne, /INSERT INTO jobs/i);
});

test("Reported Concern and clarification truth is append-only and integrity guarded", () => {
  assert.match(sqlOne, /CREATE TABLE IF NOT EXISTS reported_concerns/i);
  assert.match(sqlOne, /original_text TEXT NOT NULL/i);
  assert.match(sqlOne, /source_evidence_id UUID NOT NULL[\s\S]*REFERENCES job_request_create_command_idempotency/i);
  assert.match(sqlOne, /integrity_hash ~ '\^\[0-9a-f\]\{64\}\$'/i);
  assert.match(sqlOne, /CREATE TABLE IF NOT EXISTS concern_clarifications/i);
  for (const semantics of [
    "CLARIFIES",
    "CORRECTS_INTERPRETATION",
    "WITHDRAWS",
    "SUPERSEDES_INTERPRETATION",
  ]) {
    assert.match(sqlOne, new RegExp(`'${semantics}'`));
  }
  assert.match(sqlOne, /reported_concerns_append_only[\s\S]*BEFORE UPDATE OR DELETE/i);
  assert.match(sqlOne, /concern_clarifications_append_only[\s\S]*BEFORE UPDATE OR DELETE/i);
});

test("participants, temporal roles, and grants remain separate authorities", () => {
  assert.match(sqlTwo, /CREATE TABLE IF NOT EXISTS relationship_participants/i);
  assert.match(sqlTwo, /UNIQUE \(job_id, user_id\)/i);
  assert.match(sqlTwo, /identity_type = 'authenticated_user'/i);
  assert.match(sqlTwo, /CREATE TABLE IF NOT EXISTS participant_role_assignments/i);
  assert.match(sqlTwo, /valid_from TIMESTAMPTZ NOT NULL/i);
  assert.match(sqlTwo, /valid_until TIMESTAMPTZ/i);
  assert.match(sqlTwo, /CREATE TABLE IF NOT EXISTS participant_role_revocations/i);
  assert.match(sqlTwo, /CREATE TABLE IF NOT EXISTS lifecycle_authority_grants/i);
  assert.match(sqlTwo, /CREATE TABLE IF NOT EXISTS lifecycle_authority_grant_revocations/i);
  assert.match(sqlTwo, /scope_type IN \('job', 'reported_concern'\)/i);
  assert.match(sqlTwo, /lifecycle_authority_grants_scope_shape_check/i);
  assert.match(sqlTwo, /idempotency_key TEXT NOT NULL/i);
});

test("Slice 001 capability registry contains no commercial authority", () => {
  for (const capability of [
    "reported_concern.read",
    "reported_concern.clarify",
    "participant.read",
  ]) {
    assert.match(sqlTwo, new RegExp(`'${capability.replace(".", "\\.")}'`));
  }
  assert.doesNotMatch(
    sqlTwo,
    /'quote\.(?:issue|approve)'|'procurement\.authorize'|'change\.approve'|'commercial_scope\.close'/i
  );
});
