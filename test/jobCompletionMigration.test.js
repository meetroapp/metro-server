"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const { getMigrationFiles } = require("../scripts/run-migrations");

const migrationName = "202608150003_create_job_completion_history.sql";
const sql = readFileSync(join(__dirname, "..", "migrations", migrationName), "utf8");

test("migration 42 is the additive Job completion and history foundation", () => {
  const migrations = getMigrationFiles();
  assert.equal((migrations.at(-1)?.filename || migrations.at(-1)), "202608300008_create_business_time_evidence_authority.sql");
  assert.equal(migrations[41].filename, migrationName);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS canonical_job_completion_records/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS canonical_job_completion_command_idempotency/i);
  assert.match(sql, /command_name = 'job\.complete'/i);
  assert.match(sql, /UNIQUE \(actor_participant_id, job_id, command_name, idempotency_key\)/i);
  assert.match(sql, /canonical_job_completion_records_append_only/i);
});
test("migration records durable operational truth without financial or adjacent-domain authority", () => {
  assert.match(sql, /evidence_snapshot JSONB NOT NULL/i);
  assert.match(sql, /integrity_hash TEXT NOT NULL/i);
  assert.match(sql, /completed_at TIMESTAMPTZ NOT NULL/i);
  assert.doesNotMatch(sql, /\b(?:UPDATE|DELETE FROM)\s+(?:jobs|canonical_quotes|canonical_visits)\b/i);
  assert.doesNotMatch(sql, /\b(?:invoice|payment|portfolio)\b/i);
});
