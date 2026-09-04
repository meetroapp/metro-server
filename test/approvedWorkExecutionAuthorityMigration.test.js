"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const { getMigrationFiles } = require("../scripts/run-migrations");

const migrationsDirectory = join(__dirname, "..", "migrations");
const migration60Name =
  "202608280002_create_canonical_materials_work_preparation_authority.sql";
const migration61Name =
  "202608280003_create_canonical_approved_work_execution_authority.sql";
const sql = readFileSync(join(migrationsDirectory, migration61Name), "utf8");

test("migration 61 follows frozen Migration 60 and advances inventory only once", () => {
  const migrations = getMigrationFiles();
  assert.equal((migrations[74]?.filename || migrations[74]), "202608310001_create_business_job_customer_message_authority.sql");
  assert.equal((migrations.at(-1)?.filename || migrations.at(-1)), "202609040001_add_evaluation_revision_authority.sql");
  assert.deepEqual(
    migrations.slice(59, 61).map(({ filename }) => filename),
    [migration60Name, migration61Name]
  );
  assert.doesNotMatch(sql, /^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/im);
});

test("migration 61 creates exactly the approved execution authority tables", () => {
  for (const table of [
    "canonical_approved_work_execution_command_idempotency",
    "canonical_approved_work_executions",
    "canonical_approved_work_execution_versions",
    "canonical_approved_work_execution_workstreams",
    "canonical_work_activity_execution_classifications",
    "canonical_approved_work_execution_start_events",
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`, "i"));
  }
  assert.doesNotMatch(
    sql,
    /^\s*(?:DROP\s+(?:TABLE|COLUMN)|TRUNCATE|DELETE\s+FROM|UPDATE\s+\S+)/im
  );
});

test("execution identity carries exact APPROVED commercial lineage", () => {
  assert.match(sql, /approved_customer_decision TEXT NOT NULL DEFAULT 'APPROVED'/i);
  assert.match(sql, /approved_customer_decision_id UUID NOT NULL UNIQUE/i);
  assert.match(
    sql,
    /FOREIGN KEY \(\s*approved_customer_decision_id, quote_id, issued_quote_version, job_id,[\s\S]*relationship_id, approved_customer_decision, source_integrity_hash,[\s\S]*customer_participant_id[\s\S]*REFERENCES canonical_quote_customer_decisions/i
  );
  assert.match(
    sql,
    /FOREIGN KEY \(\s*quote_id, issued_quote_version, job_id, commercial_currency,[\s\S]*source_integrity_hash[\s\S]*REFERENCES canonical_quote_versions/i
  );
  assert.doesNotMatch(sql, /latest approved|ORDER BY[^;]*decision.*DESC/i);
});

test("execution versions are append-only, contiguous, and explicit about supersession", () => {
  assert.match(sql, /state IN \('ACTIVE', 'SUPERSEDED', 'CLOSED'\)/i);
  assert.match(sql, /successor_execution_id <> execution_id/i);
  assert.match(sql, /enforce_approved_work_execution_version_sequence/i);
  assert.match(sql, /versions must be contiguous/i);
  assert.match(sql, /supersession cannot be circular/i);
  assert.match(sql, /terminal state cannot transition/i);
});

test("Workstream bindings and Activity classifications enforce forward execution lineage", () => {
  assert.match(sql, /workstream_id UUID NOT NULL UNIQUE/i);
  assert.match(
    sql,
    /UNIQUE \(execution_id, workstream_id, job_id, relationship_id\)/i
  );
  assert.match(sql, /classification IN \('EXECUTION', 'NON_EXECUTION'\)/i);
  assert.match(
    sql,
    /classification = 'NON_EXECUTION'[\s\S]*execution_id IS NULL[\s\S]*scope_basis IS NULL/i
  );
  assert.match(
    sql,
    /classification = 'EXECUTION'[\s\S]*execution_id IS NOT NULL/i
  );
  assert.doesNotMatch(sql, /ALTER TABLE canonical_work_(?:activities|activity_versions)/i);
  assert.doesNotMatch(sql, /ALTER TABLE canonical_workstreams/i);
});

test("DECISION_WIDE and exact included Quote scope are distinct", () => {
  assert.match(sql, /scope_basis IN \('DECISION_WIDE', 'QUOTE_SCOPE_ITEM'\)/i);
  assert.match(
    sql,
    /scope_basis = 'DECISION_WIDE'[\s\S]*source_scope_item_id IS NULL/i
  );
  assert.match(
    sql,
    /scope_basis = 'QUOTE_SCOPE_ITEM'[\s\S]*source_scope_item_id IS NOT NULL[\s\S]*source_scope_included_in_total = TRUE/i
  );
  assert.match(
    sql,
    /REFERENCES canonical_quote_scope_item_snapshots\([\s\S]*included_in_total/i
  );
});

test("start events require exact EXECUTION Activity or APPROVED_WORK Visit sources", () => {
  assert.match(sql, /source_type IN \('EXECUTION_ACTIVITY', 'APPROVED_WORK_VISIT'\)/i);
  assert.match(
    sql,
    /source_type = 'EXECUTION_ACTIVITY'[\s\S]*source_activity_classification = 'EXECUTION'[\s\S]*source_activity_status = 'IN_PROGRESS'/i
  );
  assert.match(
    sql,
    /source_type = 'APPROVED_WORK_VISIT'[\s\S]*source_visit_purpose = 'APPROVED_WORK'[\s\S]*source_visit_state = 'STARTED'/i
  );
  assert.match(sql, /canonical_approved_work_execution_start_activity_source_uidx/i);
  assert.match(sql, /canonical_approved_work_execution_start_visit_source_uidx/i);
  assert.match(sql, /canonical_approved_work_execution_start_first_idx/i);
});

test("Migration 61 adds deferred Migration 60 policy consistency without editing Migration 60", () => {
  assert.match(sql, /work preparation policy NONE cannot contain required Work-start items/i);
  assert.match(sql, /CREATE CONSTRAINT TRIGGER canonical_work_preparation_policy_version_consistency_guard/i);
  assert.match(sql, /CREATE CONSTRAINT TRIGGER canonical_work_preparation_policy_item_consistency_guard/i);
  assert.match(sql, /DEFERRABLE INITIALLY DEFERRED/gi);
  const migration60 = readFileSync(join(migrationsDirectory, migration60Name));
  assert.equal(
    createHash("sha256").update(migration60).digest("hex"),
    "6ad53d9af8400617d5ff3d8cbdf18a407b21931107542d4a72784e7793331f27"
  );
});

test("capabilities and append-only guards add no business authority rows", () => {
  assert.match(sql, /approved_work\.execution\.manage/);
  assert.match(sql, /approved_work\.execute/);
  assert.match(sql, /prevent_lifecycle_append_only_mutation\(\)/i);
  assert.doesNotMatch(sql, /INSERT INTO lifecycle_authority_grants/i);
  assert.doesNotMatch(
    sql,
    /INSERT INTO (?:canonical_approved_work_execution|canonical_work_activity_execution)/i
  );
});

test("README records Migration 61 as schema-only execution authority", () => {
  const readme = readFileSync(join(migrationsDirectory, "README.md"), "utf8");
  assert.match(
    readme,
    /61\. `202608280003_create_canonical_approved_work_execution_authority\.sql`/
  );
  assert.match(readme, /creates no\s+execution business rows/i);
  assert.match(
    readme,
    /legacy Workstreams\s+and Activities remain unbound and unclassified/i
  );
});
