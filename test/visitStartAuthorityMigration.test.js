"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const { getMigrationFiles } = require("../scripts/run-migrations");

const migrationsDirectory = join(__dirname, "..", "migrations");
const migration56Name =
  "202608250001_correct_evaluation_visit_authority_and_negotiation.sql";
const migration57Name =
  "202608260001_create_evaluation_remote_provenance.sql";
const migration58Name =
  "202608270001_add_canonical_visit_start_authority.sql";
const approvedMigration56Checksum =
  "22329b57c68a1eb54141a68b9662bb7b840c6ef0cba0d649ef6991ff502205f8";
const approvedMigration57Checksum =
  "2e0a9de0120bda1ad6426c9fcd12f9783338d8c4e058de20bfd916634ef73363";
const sql = readFileSync(join(migrationsDirectory, migration58Name), "utf8");

function checksum(filename) {
  return createHash("sha256")
    .update(readFileSync(join(migrationsDirectory, filename), "utf8"))
    .digest("hex");
}

test("migration 58 follows frozen migrations 56 and 57", () => {
  const migrations = getMigrationFiles();
  assert.equal(migrations.length, 63);
  assert.deepEqual(
    migrations.slice(-8, -5).map(({ filename }) => filename),
    [migration56Name, migration57Name, migration58Name]
  );
  assert.doesNotMatch(sql, /^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/im);
});

test("frozen Visit and remote-provenance migrations retain approved checksums", () => {
  assert.equal(checksum(migration56Name), approvedMigration56Checksum);
  assert.equal(checksum(migration57Name), approvedMigration57Checksum);
});

test("migration 58 registers only Visit Start capability vocabulary", () => {
  assert.match(
    sql,
    /INSERT INTO lifecycle_capabilities \(capability\)\s+VALUES \('visit\.start'\)\s+ON CONFLICT \(capability\) DO NOTHING/i
  );
  assert.doesNotMatch(sql, /INSERT INTO lifecycle_authority_grants/i);
  assert.doesNotMatch(sql, /INSERT INTO canonical_(?:visits|visit_versions|visit_events|visit_command_idempotency)/i);
});

test("STARTED is additive immutable Visit-version evidence", () => {
  assert.match(
    sql,
    /ALTER TABLE canonical_visit_versions\s+ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ/i
  );
  for (const state of ["PROPOSED", "SCHEDULED", "STARTED", "CANCELLED", "COMPLETED"]) {
    assert.match(sql, new RegExp(`'${state}'`));
  }
  assert.match(sql, /state = 'STARTED'[\s\S]*started_at IS NOT NULL[\s\S]*cancelled_at IS NULL[\s\S]*completed_at IS NULL/i);
  assert.match(sql, /state = 'CANCELLED'[\s\S]*started_at IS NULL OR started_at <= cancelled_at/i);
  assert.match(sql, /state = 'COMPLETED'[\s\S]*started_at IS NULL OR started_at <= completed_at/i);
});

test("visit.start command vocabulary preserves every existing command", () => {
  for (const command of [
    "visit.propose",
    "visit.confirm",
    "visit.change_request",
    "visit.reschedule",
    "visit.cancel",
    "visit.start",
    "visit.complete",
    "visit.link_evaluation",
  ]) {
    assert.match(sql, new RegExp(`'${command.replace(".", "\\.")}'`));
  }
  assert.match(sql, /canonical_visit_command_idempotency_command_name_r3_check/i);
});

test("VISIT_STARTED preserves exact adjacent-version lineage", () => {
  assert.match(sql, /'VISIT_STARTED'/);
  assert.match(
    sql,
    /event_type = 'VISIT_STARTED'[\s\S]*visit_version >= 2[\s\S]*previous_visit_version = visit_version - 1[\s\S]*visit_state = 'STARTED'/i
  );
  assert.match(
    sql,
    /event_type = 'VISIT_COMPLETED'[\s\S]*previous_visit_version = visit_version - 1[\s\S]*visit_state = 'COMPLETED'/i
  );
});

test("Visit Start acknowledgment evidence uses only the approved bounded matrix", () => {
  assert.match(sql, /start_timing_classification TEXT/i);
  assert.match(sql, /schedule_variance_acknowledged BOOLEAN/i);
  for (const classification of [
    "WITHIN_EARLY_WINDOW",
    "SAME_DATE_ON_OR_AFTER_SCHEDULE",
    "EARLY_OUTSIDE_WINDOW",
    "DIFFERENT_LOCAL_DATE",
  ]) {
    assert.match(sql, new RegExp(`'${classification}'`));
  }
  assert.match(
    sql,
    /event_type = 'VISIT_STARTED'[\s\S]*start_timing_classification IS NOT NULL[\s\S]*schedule_variance_acknowledged IS NOT NULL/i
  );
  assert.match(sql, /EARLY_OUTSIDE_WINDOW'[\s\S]*'DIFFERENT_LOCAL_DATE'[\s\S]*schedule_variance_acknowledged = TRUE/i);
  assert.match(sql, /event_type <> 'VISIT_STARTED'[\s\S]*start_timing_classification IS NULL[\s\S]*schedule_variance_acknowledged IS NULL/i);
});

test("constraint replacement follows additive validate-drop-rename convention", () => {
  for (const replacement of [
    "canonical_visit_versions_state_r2_check",
    "canonical_visit_version_terminal_state_r2_check",
    "canonical_visit_command_idempotency_command_name_r3_check",
    "canonical_visit_events_event_type_r3_check",
    "canonical_visit_events_visit_state_r2_check",
    "canonical_visit_event_transition_shape_r3_check",
  ]) {
    assert.match(sql, new RegExp(`ADD CONSTRAINT ${replacement}[\\s\\S]*NOT VALID`, "i"));
    assert.match(sql, new RegExp(`VALIDATE CONSTRAINT ${replacement}`, "i"));
  }
});

test("migration 58 adds no speculative index, function, trigger, or business backfill", () => {
  assert.doesNotMatch(sql, /CREATE\s+(?:UNIQUE\s+)?INDEX/i);
  assert.doesNotMatch(sql, /CREATE(?: OR REPLACE)? FUNCTION/i);
  assert.doesNotMatch(sql, /CREATE TRIGGER/i);
  assert.doesNotMatch(sql, /\bUPDATE\b|\bDELETE\s+FROM\b/i);
  assert.doesNotMatch(
    sql,
    /INSERT INTO (?:canonical_visits|canonical_visit_versions|canonical_visit_events|canonical_visit_command_idempotency|canonical_evaluations|canonical_quotes|relationship_participants|canonical_evaluation_visit_authority_activations|canonical_approved_work_visit_authority_activations)/i
  );
});

test("README records migration 58 without claiming runtime or release", () => {
  const readme = readFileSync(join(migrationsDirectory, "README.md"), "utf8");
  assert.match(readme, /58\. `202608270001_add_canonical_visit_start_authority\.sql`/);
  assert.match(readme, /canonical\s+`STARTED` Visit state/i);
  assert.match(readme, /performs no backfill/i);
  assert.match(readme, /Runtime and\s+client Visit-start behavior remain separately governed work/i);
});
