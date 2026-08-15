"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const { getMigrationFiles } = require("../scripts/run-migrations");

const root = join(__dirname, "..");
const migrationName =
  "202608130001_create_canonical_visit_persistence_foundation.sql";
const sql = readFileSync(join(root, "migrations", migrationName), "utf8");
const readme = readFileSync(join(root, "migrations", "README.md"), "utf8");

test("MC-PL-002A remains the sole Visit persistence-foundation migration", () => {
  const migrations = getMigrationFiles();
  const filenames = migrations.map(({ filename }) => filename);

  assert.equal(filenames.length, 39);
  const index = filenames.indexOf(migrationName);
  assert.equal(
    filenames[index + 1],
    "202608130002_activate_evaluation_visit_authority.sql"
  );
  assert.equal(
    filenames[index + 2],
    "202608130003_activate_approved_work_visit_authority.sql"
  );
  assert.equal(
    filenames.filter((filename) => filename.startsWith("202608130001_")).length,
    1
  );
  assert.match(readme, new RegExp(migrationName.replaceAll(".", "\\.")));
  assert.doesNotMatch(sql, /^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/im);
  assert.doesNotMatch(
    sql,
    /\b(?:DROP\s+(?:TABLE|COLUMN)|TRUNCATE|DELETE\s+FROM)\b/i
  );
});

test("migration creates no Visit backfill or adjacent-domain mutation", () => {
  assert.doesNotMatch(
    sql,
    /\bINSERT\s+INTO\s+(?:canonical_visits|canonical_visit_versions|canonical_visit_events|canonical_visit_evaluation_links|canonical_visit_workstream_links)\b/i
  );
  assert.doesNotMatch(
    sql,
    /\b(?:INSERT\s+INTO|UPDATE)\s+(?:jobs|posts|canonical_evaluations|canonical_evaluation_job_subjects|canonical_quotes|canonical_quote_customer_decisions|canonical_workstreams|canonical_work_activity_versions|workflow_events)\b/i
  );
  assert.doesNotMatch(sql, /meetro_business_schedule/i);
  assert.match(sql, /creates no[\s\S]*Visit rows/i);
});

test("future Visit capabilities are registered without role or system grants", () => {
  for (const capability of [
    "visit.read",
    "visit.propose",
    "visit.confirm",
    "visit.change_request",
    "visit.reschedule",
    "visit.cancel",
    "visit.complete",
  ]) {
    assert.match(sql, new RegExp(`'${capability.replaceAll(".", "\\.")}'`));
  }
  assert.doesNotMatch(
    sql,
    /INSERT\s+INTO\s+(?:lifecycle_authority_grants|participant_role_assignments)/i
  );
  assert.doesNotMatch(sql, /(?:ai|companion)\.visit/i);
});

test("immutable Visit identity supports Job to many typed Visits", () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS canonical_visits/i);
  assert.match(sql, /job_id UUID NOT NULL[\s\S]*REFERENCES jobs\(id\)/i);
  assert.match(
    sql,
    /purpose IN \([\s\S]*'EVALUATION',[\s\S]*'APPROVED_WORK',[\s\S]*'FOLLOW_UP'[\s\S]*\)/i
  );
  assert.doesNotMatch(sql, /purpose IN \([^;]*'COMPLETION'/i);
  assert.doesNotMatch(sql, /purpose IN \([^;]*'OTHER'/i);
  assert.doesNotMatch(sql, /UNIQUE \(job_id\)/i);
  assert.match(sql, /UNIQUE \(id, job_id\)/i);
  assert.match(
    sql,
    /FOREIGN KEY \(created_by_participant_id, job_id\)[\s\S]*REFERENCES relationship_participants\(id, job_id\)/i
  );
});

test("approved-work identity requires exact approved customer-decision evidence", () => {
  assert.match(
    sql,
    /canonical_quote_customer_decision_visit_evidence_uidx[\s\S]*canonical_quote_customer_decisions\(id, job_id, decision\)/i
  );
  assert.match(
    sql,
    /purpose = 'APPROVED_WORK'[\s\S]*approved_quote_decision_id IS NOT NULL[\s\S]*approved_quote_decision = 'APPROVED'/i
  );
  assert.match(
    sql,
    /FOREIGN KEY \([\s\S]*approved_quote_decision_id,[\s\S]*job_id,[\s\S]*approved_quote_decision[\s\S]*\)[\s\S]*REFERENCES canonical_quote_customer_decisions\([\s\S]*id,[\s\S]*job_id,[\s\S]*decision/i
  );
  assert.doesNotMatch(sql, /REFERENCES canonical_quote_versions[^;]*APPROVED/i);
});

test("versions are append-only, positive unique identities with bounded state", () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS canonical_visit_versions/i);
  assert.match(sql, /PRIMARY KEY \(visit_id, version\)/i);
  assert.match(sql, /version INTEGER NOT NULL[\s\S]*CHECK \(version >= 1\)/i);
  assert.match(
    sql,
    /state IN \([\s\S]*'PROPOSED',[\s\S]*'SCHEDULED',[\s\S]*'CANCELLED',[\s\S]*'COMPLETED'[\s\S]*\)/i
  );
  assert.doesNotMatch(sql, /state IN \([^;]*'RESCHEDULED'/i);
  assert.match(sql, /integrity_hash ~ '\^\[0-9a-f\]\{64\}\$'/i);
  assert.match(sql, /canonical_visit_latest_version_idx/i);
});

test("timezone-safe timing and location modes are explicit", () => {
  assert.match(sql, /scheduled_start_at TIMESTAMPTZ NOT NULL/i);
  assert.match(sql, /scheduled_end_at TIMESTAMPTZ/i);
  assert.match(
    sql,
    /scheduled_end_at IS NULL[\s\S]*scheduled_end_at > scheduled_start_at/i
  );
  assert.match(
    sql,
    /time_zone TEXT NOT NULL[\s\S]*char_length\(btrim\(time_zone\)\) BETWEEN 1 AND 100/i
  );
  assert.match(
    sql,
    /location_mode IN \('JOB_SERVICE_LOCATION', 'REMOTE'\)/i
  );
  assert.doesNotMatch(sql, /all_day|alternate_address|latitude|longitude/i);
  assert.match(sql, /MC-PL-002B owns IANA membership and DST ambiguity validation/i);
});

test("terminal timestamps cannot claim adjacent lifecycle completion", () => {
  assert.match(
    sql,
    /state = 'CANCELLED'[\s\S]*cancelled_at IS NOT NULL[\s\S]*completed_at IS NULL/i
  );
  assert.match(
    sql,
    /state = 'COMPLETED'[\s\S]*cancelled_at IS NULL[\s\S]*completed_at IS NOT NULL/i
  );
  assert.doesNotMatch(
    sql,
    /(?:UPDATE|INSERT INTO)\s+(?:canonical_evaluations|canonical_workstreams|canonical_work_activity_versions|jobs|canonical_quotes)/i
  );
});

test("typed events distinguish change request from version transitions", () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS canonical_visit_events/i);
  for (const eventType of [
    "VISIT_PROPOSED",
    "VISIT_CONFIRMED",
    "VISIT_CHANGE_REQUESTED",
    "VISIT_RESCHEDULED",
    "VISIT_CANCELLED",
    "VISIT_COMPLETED",
  ]) {
    assert.match(sql, new RegExp(`'${eventType}'`));
  }
  assert.match(
    sql,
    /event_type = 'VISIT_CHANGE_REQUESTED'[\s\S]*previous_visit_version = visit_version/i
  );
  assert.match(
    sql,
    /event_type = 'VISIT_RESCHEDULED'[\s\S]*previous_visit_version = visit_version - 1[\s\S]*visit_state = 'SCHEDULED'/i
  );
  assert.doesNotMatch(sql, /event_payload JSONB|workflow_payload/i);
});

test("Evaluation association is optional, many-to-one, purpose- and Job-contained", () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS canonical_visit_evaluation_links/i);
  assert.match(sql, /visit_id UUID PRIMARY KEY/i);
  assert.match(sql, /visit_purpose TEXT NOT NULL DEFAULT 'EVALUATION'/i);
  assert.match(
    sql,
    /FOREIGN KEY \(visit_id, job_id, visit_purpose\)[\s\S]*REFERENCES canonical_visits\(id, job_id, purpose\)/i
  );
  assert.match(
    sql,
    /FOREIGN KEY \(evaluation_id, job_id\)[\s\S]*REFERENCES canonical_evaluation_job_subjects\(evaluation_id, job_id\)/i
  );
  assert.doesNotMatch(
    sql,
    /ALTER TABLE\s+canonical_evaluations[\s\S]*ADD COLUMN[\s\S]*visit/i
  );
});

test("Workstream association is many-to-many and Job-contained", () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS canonical_visit_workstream_links/i);
  assert.match(sql, /PRIMARY KEY \(visit_id, workstream_id\)/i);
  assert.match(
    sql,
    /FOREIGN KEY \(visit_id, job_id\)[\s\S]*REFERENCES canonical_visits\(id, job_id\)/i
  );
  assert.match(
    sql,
    /FOREIGN KEY \(workstream_id, job_id\)[\s\S]*REFERENCES canonical_workstreams\(id, job_id\)/i
  );
  assert.doesNotMatch(
    sql,
    /ALTER TABLE\s+canonical_workstreams[\s\S]*ADD COLUMN[\s\S]*visit/i
  );
});

test("command identity follows actor, type, scope, and key conventions", () => {
  assert.match(
    sql,
    /CREATE TABLE IF NOT EXISTS canonical_visit_command_idempotency/i
  );
  assert.match(sql, /request_fingerprint ~ '\^\[0-9a-f\]\{64\}\$'/i);
  assert.match(
    sql,
    /UNIQUE \([\s\S]*actor_participant_id,[\s\S]*command_name,[\s\S]*command_scope,[\s\S]*idempotency_key[\s\S]*\)/i
  );
  assert.match(
    sql,
    /FOREIGN KEY \(actor_participant_id, job_id\)[\s\S]*REFERENCES relationship_participants\(id, job_id\)/i
  );
});

test("Visit identity, versions, events, and durable links are protected", () => {
  for (const table of [
    "canonical_visit_versions",
    "canonical_visit_events",
    "canonical_visit_evaluation_links",
    "canonical_visit_workstream_links",
  ]) {
    assert.match(sql, new RegExp(`'${table}'`));
  }
  assert.match(sql, /prevent_canonical_visit_history_mutation/i);
  assert.match(sql, /prevent_canonical_visit_identity_mutation/i);
  assert.match(
    sql,
    /CREATE TRIGGER canonical_visits_immutable[\s\S]*BEFORE UPDATE OR DELETE ON canonical_visits/i
  );
  assert.doesNotMatch(sql, /ON DELETE CASCADE/i);
});

test("002A exposes no route, DTO, live-state, or command implementation", () => {
  assert.doesNotMatch(sql, /\/jobs\/:jobId|\/visits\/:visitId|live-state/i);
  assert.doesNotMatch(sql, /CREATE\s+(?:VIEW|MATERIALIZED VIEW)/i);
  assert.doesNotMatch(sql, /CREATE\s+OR\s+REPLACE\s+PROCEDURE/i);
});
