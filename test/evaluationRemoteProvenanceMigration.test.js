"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const { getMigrationFiles } = require("../scripts/run-migrations");

const migration56Name =
  "202608250001_correct_evaluation_visit_authority_and_negotiation.sql";
const migration57Name =
  "202608260001_create_evaluation_remote_provenance.sql";
const approvedMigration56Checksum =
  "22329b57c68a1eb54141a68b9662bb7b840c6ef0cba0d649ef6991ff502205f8";
const migrationsDirectory = join(__dirname, "..", "migrations");
const sql = readFileSync(join(migrationsDirectory, migration57Name), "utf8");

test("migration 57 follows frozen migration 56 and remains before migration 58", () => {
  const migrations = getMigrationFiles();
  assert.equal(migrations.length, 59);
  assert.equal(migrations.at(-4).filename, migration56Name);
  assert.equal(migrations.at(-3).filename, migration57Name);
  assert.doesNotMatch(sql, /^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/im);
});

test("migration 56 retains its approved checksum", () => {
  const migration56 = readFileSync(
    join(migrationsDirectory, migration56Name),
    "utf8"
  );
  assert.equal(
    createHash("sha256").update(migration56).digest("hex"),
    approvedMigration56Checksum
  );
});

test("remote provenance is exact-version, exact-Job, participant, and command bound", () => {
  assert.match(
    sql,
    /CREATE TABLE IF NOT EXISTS canonical_evaluation_remote_provenance/i
  );
  assert.match(sql, /UNIQUE \(evaluation_id\)/i);
  assert.match(sql, /UNIQUE \(completion_command_idempotency_id\)/i);
  assert.match(
    sql,
    /FOREIGN KEY \(evaluation_id, evaluation_version\)[\s\S]*REFERENCES canonical_evaluation_versions\(evaluation_id, version\)[\s\S]*ON DELETE RESTRICT/i
  );
  assert.match(
    sql,
    /FOREIGN KEY \(evaluation_id, job_id\)[\s\S]*REFERENCES canonical_evaluation_job_subjects\(evaluation_id, job_id\)[\s\S]*ON DELETE RESTRICT/i
  );
  assert.match(
    sql,
    /FOREIGN KEY \(professional_participant_id, job_id\)[\s\S]*REFERENCES relationship_participants\(id, job_id\)[\s\S]*ON DELETE RESTRICT/i
  );
  assert.match(
    sql,
    /FOREIGN KEY \(completion_command_idempotency_id\)[\s\S]*REFERENCES commercial_command_idempotency\(id\)[\s\S]*ON DELETE RESTRICT/i
  );
});

test("one internal Evaluation claim arbitrates physical and remote provenance", () => {
  assert.match(
    sql,
    /CREATE TABLE IF NOT EXISTS canonical_evaluation_provenance_claims/i
  );
  assert.match(
    sql,
    /evaluation_id UUID PRIMARY KEY[\s\S]*REFERENCES canonical_evaluations\(id\)[\s\S]*ON DELETE RESTRICT/i
  );
  assert.match(sql, /provenance_kind IN \('PHYSICAL', 'REMOTE'\)/i);
  assert.match(
    sql,
    /INSERT INTO canonical_evaluation_provenance_claims[\s\S]*ON CONFLICT \(evaluation_id\) DO NOTHING/i
  );
  assert.match(
    sql,
    /claim_evaluation_provenance\(NEW\.evaluation_id, 'REMOTE'\)/i
  );
  assert.match(
    sql,
    /claim_evaluation_provenance\(NEW\.evaluation_id, 'PHYSICAL'\)/i
  );
  assert.doesNotMatch(
    sql.match(
      /CREATE TABLE IF NOT EXISTS canonical_evaluation_provenance_claims[\s\S]*?\);/i
    )[0],
    /assessment_method|assessment_basis|professional_participant_id/i
  );
});

test("method and professional basis use the bounded approved vocabulary", () => {
  for (const method of [
    "PHONE",
    "VIDEO",
    "CUSTOMER_PHOTOS",
    "DOCUMENT_REVIEW",
    "OTHER_REMOTE",
  ]) {
    assert.match(sql, new RegExp(`'${method}'`));
  }
  assert.match(sql, /assessment_basis = btrim\(assessment_basis\)/i);
  assert.match(
    sql,
    /char_length\(assessment_basis\) BETWEEN 1 AND 2000/i
  );
});

test("database guards current completed authority and exact completion command", () => {
  assert.match(sql, /FOR UPDATE OF evaluations/i);
  assert.match(sql, /evaluation_state <> 'completed'/i);
  assert.match(sql, /aggregate_version <> NEW\.evaluation_version/i);
  assert.match(sql, /versions\.status = 'completed'/i);
  assert.match(sql, /assignments\.role = 'PRIMARY_PROFESSIONAL'/i);
  assert.match(sql, /grants\.capability = 'evaluation\.perform'/i);
  assert.match(sql, /commands\.command_name = 'evaluation\.complete'/i);
  assert.match(
    sql,
    /commands\.command_scope = 'evaluation:' \|\| NEW\.evaluation_id::text/i
  );
  assert.match(sql, /commands\.aggregate_id = NEW\.evaluation_id/i);
  assert.match(sql, /commands\.completed_at IS NOT NULL/i);
  assert.match(sql, /INTO command_completed_at/i);
  assert.match(sql, /participants\.created_at <= command_completed_at/i);
  assert.match(sql, /assignments\.valid_from <= command_completed_at/i);
  assert.match(sql, /assignments\.valid_until > command_completed_at/i);
  assert.match(sql, /revocations\.revoked_at <= command_completed_at/i);
  assert.match(sql, /grants\.valid_from <= command_completed_at/i);
  assert.match(sql, /grants\.valid_until > command_completed_at/i);
  assert.doesNotMatch(sql, /assignments\.valid_from <= CURRENT_TIMESTAMP/i);
  assert.doesNotMatch(sql, /grants\.valid_from <= CURRENT_TIMESTAMP/i);
});

test("physical and remote paths serialize on the Evaluation and reject both orders", () => {
  assert.match(
    sql,
    /assert_evaluation_remote_provenance_insert[\s\S]*FOR UPDATE OF evaluations[\s\S]*canonical_visit_evaluation_links/i
  );
  assert.match(
    sql,
    /assert_visit_evaluation_link_not_remote[\s\S]*canonical_evaluations[\s\S]*FOR UPDATE[\s\S]*canonical_evaluation_remote_provenance/i
  );
  assert.match(
    sql,
    /BEFORE INSERT ON canonical_visit_evaluation_links[\s\S]*assert_visit_evaluation_link_not_remote/i
  );
});

test("remote provenance is append-only and migration performs no backfill", () => {
  assert.match(
    sql,
    /BEFORE UPDATE OR DELETE ON canonical_evaluation_remote_provenance[\s\S]*prevent_lifecycle_append_only_mutation/i
  );
  assert.match(
    sql,
    /BEFORE UPDATE OR DELETE ON canonical_evaluation_provenance_claims[\s\S]*prevent_lifecycle_append_only_mutation/i
  );
  assert.doesNotMatch(
    sql,
    /\bINSERT\s+INTO\s+(?:canonical_evaluation_remote_provenance|canonical_visits|canonical_evaluations|jobs|relationship_participants|lifecycle_authority_grants)\b/i
  );
  assert.doesNotMatch(
    sql,
    /\b(?:UPDATE|DELETE\s+FROM|TRUNCATE)\s+(?:canonical_evaluations|canonical_evaluation_versions|canonical_visits|canonical_visit_versions|lifecycle_authority_grants)\b/i
  );
});
