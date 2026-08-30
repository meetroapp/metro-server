"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const { getMigrationFiles } = require("../scripts/run-migrations");

const migrationName =
  "202608250001_correct_evaluation_visit_authority_and_negotiation.sql";
const sql = readFileSync(
  join(__dirname, "..", "migrations", migrationName),
  "utf8"
);

test("migration 56 follows the unchanged migration 1-55 prefix", () => {
  const migrations = getMigrationFiles();
  assert.equal((migrations.at(-1)?.filename || migrations.at(-1)), "202608300005_create_business_team_membership_authority.sql");
  assert.equal(
    migrations.at(-15).filename,
    "202608240001_create_customer_party_linkage_foundation.sql"
  );
  assert.equal(migrations.at(-14).filename, migrationName);
  assert.equal(
    migrations.at(-13).filename,
    "202608260001_create_evaluation_remote_provenance.sql"
  );
  assert.doesNotMatch(sql, /^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/im);
});

test("evaluation_visit is an Evaluation-independent exact-Job scope", () => {
  assert.match(
    sql,
    /scope_type IN \([\s\S]*'job'[\s\S]*'reported_concern'[\s\S]*'evaluation'[\s\S]*'approved_work'[\s\S]*'evaluation_visit'[\s\S]*\)/i
  );
  assert.match(
    sql,
    /scope_type = 'evaluation_visit'[\s\S]*scope_job_id = job_id[\s\S]*scope_concern_id IS NULL[\s\S]*scope_evaluation_id IS NULL[\s\S]*scope_approved_quote_decision_id IS NULL[\s\S]*scope_approved_quote_decision IS NULL/i
  );
  assert.match(sql, /evaluation_visit authorizes only canonical Visits whose purpose is[\s\S]*EVALUATION/i);
  assert.match(sql, /must never authorize APPROVED_WORK or FOLLOW_UP/i);
});

test("constraint replacements validate before dropping the restrictive checks", () => {
  for (const [temporary, current] of [
    [
      "lifecycle_authority_grants_scope_type_r2_check",
      "lifecycle_authority_grants_scope_type_check",
    ],
    [
      "lifecycle_authority_grants_scope_shape_r2_check",
      "lifecycle_authority_grants_scope_shape_check",
    ],
    [
      "canonical_visit_command_idempotency_command_name_r2_check",
      "canonical_visit_command_idempotency_command_name_check",
    ],
    [
      "canonical_visit_events_event_type_r2_check",
      "canonical_visit_events_event_type_check",
    ],
    [
      "canonical_visit_event_transition_shape_r2_check",
      "canonical_visit_event_transition_shape_check",
    ],
  ]) {
    const add = sql.indexOf(`ADD CONSTRAINT ${temporary}`);
    const validate = sql.indexOf(`VALIDATE CONSTRAINT ${temporary}`);
    const drop = sql.indexOf(`DROP CONSTRAINT ${current}`);
    const rename = sql.indexOf(`RENAME CONSTRAINT ${temporary}`);
    assert.ok(add >= 0, `${temporary} is added`);
    assert.ok(validate > add, `${temporary} is validated after creation`);
    assert.ok(drop > validate, `${current} is dropped only after validation`);
    assert.ok(rename > drop, `${temporary} is renamed after replacement`);
  }
});

test("alternate schedules use the immutable sequential PROPOSED transition", () => {
  assert.match(
    sql,
    /event_type = 'VISIT_SCHEDULE_PROPOSED'[\s\S]*visit_version >= 2[\s\S]*previous_visit_version = visit_version - 1[\s\S]*visit_state = 'PROPOSED'/i
  );
  assert.match(
    sql,
    /event_type = 'VISIT_CHANGE_REQUESTED'[\s\S]*previous_visit_version = visit_version[\s\S]*visit_state IN \('PROPOSED', 'SCHEDULED'\)/i
  );
  assert.match(sql, /'visit\.link_evaluation'/i);
});

test("the approved active evaluation-visit lookup is partial and Job-scoped", () => {
  assert.match(
    sql,
    /CREATE INDEX IF NOT EXISTS lifecycle_authority_grants_evaluation_visit_scope_idx[\s\S]*grantee_participant_id,[\s\S]*job_id,[\s\S]*capability,[\s\S]*valid_from ASC,[\s\S]*id ASC[\s\S]*WHERE scope_type = 'evaluation_visit' AND valid_until IS NULL/i
  );
});

test("migration adds no storage model, backfill, grant, or business row", () => {
  assert.doesNotMatch(sql, /\bCREATE\s+TABLE\b/i);
  assert.doesNotMatch(sql, /\bADD\s+COLUMN\b/i);
  assert.doesNotMatch(sql, /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE)\b/i);
  assert.doesNotMatch(sql, /\bDROP\s+(?:TABLE|COLUMN)\b/i);
  assert.match(sql, /creates no authority grant, Visit, Visit version\/event, Evaluation, link/i);
  assert.match(sql, /performs no backfill/i);
});

test("one canonical Visit remains shared across scheduling surfaces and devices", () => {
  assert.match(sql, /Communication Center coordinates scheduling/i);
  assert.match(sql, /Work Center \/ Schedule manages[\s\S]*canonical operational Visit/i);
  assert.match(sql, /Business Dashboard derives attention/i);
  assert.match(sql, /same Visit identity, version, and state/i);
  assert.match(sql, /No surface- or[\s\S]*device-specific scheduling authority/i);
});
