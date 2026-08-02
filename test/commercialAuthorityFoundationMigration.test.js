"use strict";

const assert = require("node:assert/strict");
const { readFileSync, readdirSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const repositoryRoot = join(__dirname, "..");
const migrationName =
  "202608010001_create_commercial_authority_foundation.sql";
const migrationPath = join(repositoryRoot, "migrations", migrationName);
const sql = readFileSync(migrationPath, "utf8");
const serviceSource = readFileSync(
  join(
    repositoryRoot,
    "server",
    "authorization",
    "commercialAuthorityService.js"
  ),
  "utf8"
);
const indexSource = readFileSync(join(repositoryRoot, "index.js"), "utf8");

test("commercial authority foundation remains the first unique authority migration", () => {
  const migrations = readdirSync(join(repositoryRoot, "migrations"))
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort();

  assert.ok(migrations.includes(migrationName));
  assert.ok(
    migrations.indexOf(migrationName) <
      migrations.indexOf("202608010002_create_canonical_evaluations.sql")
  );
  assert.equal(
    migrations.filter((name) => name.startsWith("202608010001_")).length,
    1
  );
  assert.doesNotMatch(sql, /\b(?:DROP TABLE|TRUNCATE|DELETE FROM)\b/i);
  assert.doesNotMatch(
    sql,
    /\b(?:INSERT INTO|UPDATE|DELETE FROM)\s+workflow_events\b/i
  );
});

test("migration keeps aggregate, idempotency, and evidence identities distinct", () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS commercial_authority_aggregates/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS commercial_command_idempotency/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS commercial_authority_evidence/i);
  assert.match(sql, /\bid UUID PRIMARY KEY\b/i);
  assert.match(sql, /owning_engine = 'authorization_engine'/i);
  assert.match(sql, /current_version INTEGER NOT NULL DEFAULT 1/i);
  assert.match(sql, /current_version >= 1/i);
  assert.doesNotMatch(sql, /CREATE TABLE IF NOT EXISTS workflow_events/i);
});

test("source constraints keep ordinary and Emergency identity contradictory states impossible", () => {
  assert.match(sql, /source_context_type = 'ordinary_request'[\s\S]*ordinary_request_id IS NOT NULL[\s\S]*emergency_request_id IS NULL/i);
  assert.match(sql, /source_context_type = 'emergency_request'[\s\S]*ordinary_request_id IS NULL[\s\S]*emergency_request_id IS NOT NULL/i);
  assert.match(sql, /ordinary_request_id INTEGER[\s\S]*REFERENCES posts\(id\)[\s\S]*ON DELETE RESTRICT/i);
  assert.match(sql, /emergency_request_id INTEGER[\s\S]*REFERENCES emergency_requests\(id\)[\s\S]*ON DELETE RESTRICT/i);
  assert.match(sql, /relationship_id INTEGER[\s\S]*REFERENCES request_relationships\(id\)[\s\S]*ON DELETE RESTRICT/i);
  assert.doesNotMatch(sql, /project_id|source_id TEXT|source_table/i);
});

test("idempotency scope, fingerprint, completion, and uniqueness are constrained", () => {
  assert.match(sql, /request_fingerprint ~ '\^\[0-9a-f\]\{64\}\$'/i);
  assert.match(sql, /commercial_command_completion_check/i);
  assert.match(sql, /UNIQUE \([\s\S]*actor_user_id,[\s\S]*command_name,[\s\S]*command_scope,[\s\S]*idempotency_key[\s\S]*\)/i);
  assert.match(sql, /result_reference IS NULL[\s\S]*completed_at IS NULL/i);
  assert.match(sql, /result_reference IS NOT NULL[\s\S]*completed_at IS NOT NULL/i);
});

test("evidence is version-linked, ordered, governed, and retained", () => {
  assert.match(sql, /resulting_version = previous_version \+ 1/i);
  assert.match(sql, /UNIQUE \(aggregate_id, resulting_version\)/i);
  assert.match(sql, /commercial_authority_evidence_order_idx/i);
  assert.match(sql, /resulting_version ASC,[\s\S]*persisted_at ASC,[\s\S]*id ASC/i);
  assert.match(sql, /evidence_type IN \([\s\S]*commercial\.aggregate\.created[\s\S]*commercial\.aggregate\.version_advanced/i);
  assert.match(sql, /governing_charter_id = 'MC-WORKFLOW-001C'/i);
  assert.match(sql, /governing_program_id = 'MC-WORKFLOW-001D'/i);
  assert.match(sql, /implementation_milestone_id = 'MC-WORKFLOW-002A'/i);
  assert.match(sql, /certification_target = 'MC-WORKFLOW-002R'/i);
  assert.match(sql, /REFERENCES commercial_authority_aggregates[\s\S]*ON DELETE RESTRICT/i);
});

test("application service exposes no evidence update or legacy-event authority path", () => {
  assert.doesNotMatch(
    serviceSource,
    /UPDATE\s+commercial_authority_evidence/i
  );
  assert.doesNotMatch(
    serviceSource,
    /(?:INSERT INTO|UPDATE|DELETE FROM|SELECT[\s\S]*FROM)\s+workflow_events/i
  );
  assert.match(
    serviceSource,
    /ORDER BY resulting_version ASC, persisted_at ASC, id ASC/i
  );
  assert.doesNotMatch(
    indexSource,
    /(?:app\.(?:get|post|put|patch|delete)|require)\([^\n]*commercial[-_/]authority/i
  );
});
