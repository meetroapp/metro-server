"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const migrationFilename =
  "202608060001_create_professional_response_foundation.sql";
const requestSelectionMigrationFilename =
  "202608060002_create_request_selection_authority.sql";
const migrationPath = path.join(
  __dirname,
  "..",
  "migrations",
  migrationFilename
);
const migrationSql = fs.readFileSync(migrationPath, "utf8");
const executableSql = migrationSql.replace(/^\s*--.*$/gm, "");

function sqlSection(startPattern, endPattern, source = migrationSql) {
  const start = source.search(startPattern);
  const end = source.search(endPattern);

  assert.notEqual(start, -1, `Missing SQL section: ${startPattern}`);
  assert.ok(end > start, `Invalid SQL section boundary: ${endPattern}`);

  return source.slice(start, end);
}

test("Professional Response migration precedes the governed selection authority migration", () => {
  const migrationsDirectory = path.dirname(migrationPath);
  const migrationFiles = fs
    .readdirSync(migrationsDirectory)
    .filter((filename) => /^\d{12}_[a-z0-9_]+\.sql$/.test(filename))
    .sort();

  assert.ok(
    migrationFiles.indexOf(migrationFilename) <
      migrationFiles.indexOf(requestSelectionMigrationFilename)
  );
  assert.equal(
    migrationFiles.filter((filename) =>
      filename.startsWith("202608060001_")
    ).length,
    1
  );

  const readme = fs.readFileSync(
    path.join(migrationsDirectory, "README.md"),
    "utf8"
  );

  assert.match(
    readme,
    /22\. `202608060001_create_professional_response_foundation\.sql`/
  );
  assert.match(
    readme,
    /23\. `202608060002_create_request_selection_authority\.sql`/
  );
  assert.match(
    readme,
    /does not backfill legacy relationships, create\s+selection authority, or require a conversation/i
  );
});

test("migration creates the five distinct Professional Response authority tables", () => {
  for (const tableName of [
    "professional_responses",
    "professional_response_versions",
    "professional_response_command_idempotency",
    "professional_response_evidence",
    "professional_response_reconciliations",
  ]) {
    assert.match(
      migrationSql,
      new RegExp(`CREATE TABLE IF NOT EXISTS ${tableName}\\s*\\(`, "i")
    );
  }

  assert.doesNotMatch(
    migrationSql,
    /CREATE TABLE IF NOT EXISTS (?:request_selections|conversations|conversation_participants|messages)\b/i
  );
});

test("response identity is database-generated and bound to ordinary request and server-owned participants", () => {
  const responseTableSql = sqlSection(
    /CREATE TABLE IF NOT EXISTS professional_responses/i,
    /CREATE INDEX IF NOT EXISTS professional_responses_professional_idx/i
  );

  assert.match(responseTableSql, /\bid BIGSERIAL PRIMARY KEY\b/i);
  assert.match(
    responseTableSql,
    /post_id INTEGER NOT NULL[\s\S]*REFERENCES posts\(id\)[\s\S]*ON DELETE RESTRICT/i
  );
  assert.match(
    responseTableSql,
    /contractor_id INTEGER NOT NULL[\s\S]*REFERENCES contractor_profiles\(id\)[\s\S]*ON DELETE RESTRICT/i
  );
  assert.match(
    responseTableSql,
    /professional_user_id INTEGER NOT NULL[\s\S]*REFERENCES users\(id\)[\s\S]*ON DELETE RESTRICT/i
  );
  assert.match(
    responseTableSql,
    /FOREIGN KEY \(post_id, homeowner_id\)[\s\S]*REFERENCES posts\(id, user_id\)/i
  );
  assert.match(
    responseTableSql,
    /FOREIGN KEY \(contractor_id, professional_user_id\)[\s\S]*REFERENCES contractor_profiles\(id, user_id\)/i
  );
  assert.doesNotMatch(responseTableSql, /emergency_request_id/i);
});

test("semantic uniqueness is exact Job Request plus backend-owned business", () => {
  assert.match(
    migrationSql,
    /professional_responses_request_business_key[\s\S]*UNIQUE \(post_id, contractor_id\)/i
  );
  assert.match(
    migrationSql,
    /request_relationships_unique_post_response|request_relationships_professional_response_party_uidx/i
  );

  const uniqueDefinitions = [
    ...migrationSql.matchAll(/(?:UNIQUE\s*\([^;]*?\)|CREATE UNIQUE INDEX[^;]*;)/gis),
  ].map((match) => match[0]);

  assert.equal(
    uniqueDefinitions.some((definition) =>
      /introduction_text|content_fingerprint/.test(definition)
    ),
    false
  );
});

test("response lifecycle and authoritative timestamps are constrained independently", () => {
  for (const state of [
    "submitted",
    "withdrawn",
    "declined",
    "selected",
    "not_selected",
    "expired",
    "cancelled",
    "closed",
  ]) {
    assert.match(migrationSql, new RegExp(`'${state}'`, "i"));
  }

  assert.match(migrationSql, /status TEXT NOT NULL DEFAULT 'submitted'/i);
  assert.match(
    migrationSql,
    /professional_responses_status_timestamps_check[\s\S]*status = 'submitted'[\s\S]*status = 'selected'[\s\S]*terminal_at IS NOT NULL/i
  );
  assert.match(
    migrationSql,
    /submitted_at TIMESTAMPTZ NOT NULL[\s\S]*last_transition_at TIMESTAMPTZ NOT NULL[\s\S]*terminal_at TIMESTAMPTZ/i
  );
});

test("response versions are unique, sequential, current-row linked, and immutable", () => {
  assert.match(
    migrationSql,
    /PRIMARY KEY \(professional_response_id, version\)/i
  );
  assert.match(
    migrationSql,
    /version = 1[\s\S]*previous_version IS NULL[\s\S]*version > 1[\s\S]*previous_version = version - 1/i
  );
  assert.match(
    migrationSql,
    /professional_responses_current_version_fk[\s\S]*FOREIGN KEY \(id, current_version\)[\s\S]*REFERENCES professional_response_versions[\s\S]*DEFERRABLE INITIALLY DEFERRED/i
  );
  assert.match(
    migrationSql,
    /content_fingerprint ~ '\^\[0-9a-f\]\{64\}\$'/i
  );
  assert.match(
    migrationSql,
    /CREATE TRIGGER professional_response_versions_append_only[\s\S]*BEFORE UPDATE OR DELETE ON professional_response_versions/i
  );
});

test("durable idempotency supports scoped retries, fingerprint conflicts, and exact pair results", () => {
  const idempotencySql = sqlSection(
    /CREATE TABLE IF NOT EXISTS professional_response_command_idempotency/i,
    /CREATE INDEX IF NOT EXISTS professional_response_command_result_idx/i
  );

  assert.match(idempotencySql, /\bid UUID PRIMARY KEY\b/i);
  assert.match(
    idempotencySql,
    /command_name TEXT NOT NULL DEFAULT 'professional_response\.submit'/i
  );
  assert.match(
    idempotencySql,
    /request_fingerprint ~ '\^\[0-9a-f\]\{64\}\$'/i
  );
  assert.match(
    idempotencySql,
    /UNIQUE \([\s\S]*actor_user_id,[\s\S]*command_name,[\s\S]*command_scope,[\s\S]*idempotency_key[\s\S]*\)/i
  );
  assert.match(
    idempotencySql,
    /command_scope =[\s\S]*'post:' \|\| post_id::TEXT \|\| ':business:' \|\| contractor_id::TEXT/i
  );
  assert.match(
    idempotencySql,
    /FOREIGN KEY \(contractor_id, actor_user_id\)[\s\S]*REFERENCES contractor_profiles\(id, user_id\)/i
  );
  assert.match(
    idempotencySql,
    /result_classification IN \('created', 'existing'\)/i
  );
  assert.match(
    idempotencySql,
    /professional_response_command_result_fk[\s\S]*professional_response_id,[\s\S]*request_relationship_id,[\s\S]*post_id,[\s\S]*contractor_id,[\s\S]*actor_user_id[\s\S]*REFERENCES professional_responses/i
  );
  assert.match(
    idempotencySql,
    /professional_response_command_completion_check[\s\S]*professional_response_id IS NULL[\s\S]*completed_at IS NULL[\s\S]*professional_response_id IS NOT NULL[\s\S]*completed_at IS NOT NULL/i
  );
});

test("response evidence is version-linked, governed, ordered, and append-only", () => {
  const evidenceSql = sqlSection(
    /CREATE TABLE IF NOT EXISTS professional_response_evidence/i,
    /CREATE INDEX IF NOT EXISTS professional_response_evidence_order_idx/i
  );

  for (const eventType of [
    "professional_response_submitted",
    "professional_response_withdrawn",
    "professional_response_declined",
    "professional_response_selected",
    "professional_response_not_selected",
    "professional_response_expired",
    "professional_response_cancelled",
    "professional_response_closed",
    "legacy_professional_response_reconciled",
  ]) {
    assert.match(migrationSql, new RegExp(`'${eventType}'`, "i"));
  }

  assert.match(
    migrationSql,
    /professional_response_evidence_version_check[\s\S]*resulting_version = previous_version \+ 1/i
  );
  assert.match(
    migrationSql,
    /UNIQUE \(professional_response_id, resulting_version\)/i
  );
  assert.match(
    migrationSql,
    /professional_response_evidence_version_fk[\s\S]*REFERENCES professional_response_versions/i
  );
  assert.match(
    migrationSql,
    /CREATE TRIGGER professional_response_evidence_append_only[\s\S]*BEFORE UPDATE OR DELETE ON professional_response_evidence/i
  );
  const milestoneSql = sqlSection(
    /implementation_milestone_id TEXT NOT NULL/i,
    /CONSTRAINT professional_response_evidence_version_check/i,
    evidenceSql
  );
  const milestonePatternSource = milestoneSql.match(
    /implementation_milestone_id\s*~\s*'([^']+)'/i
  )?.[1];

  assert.ok(milestonePatternSource);
  assert.doesNotMatch(milestoneSql, /\bDEFAULT\b/i);
  assert.match(
    milestoneSql,
    /char_length\(implementation_milestone_id\)\s*<=\s*160/i
  );

  const milestonePattern = new RegExp(milestonePatternSource);
  for (const milestoneId of [
    "MC-CONVERSATION-COMMERCIAL-JOB-REQUEST-001B-2B",
    "MC-CONVERSATION-COMMERCIAL-JOB-REQUEST-001B-2C",
    "MC-CONVERSATION-COMMERCIAL-JOB-REQUEST-001B-3",
    "MC-CONVERSATION-COMMERCIAL-JOB-REQUEST-001B-2B-CORR-1",
  ]) {
    assert.match(milestoneId, milestonePattern);
  }

  for (const milestoneId of [
    "",
    "MC-WORKFLOW-002B",
    "MC-CONVERSATION-COMMERCIAL-JOB-REQUEST-001B",
    "MC-CONVERSATION-COMMERCIAL-JOB-REQUEST-001B-0",
    "MC-CONVERSATION-COMMERCIAL-JOB-REQUEST-001B-runtime",
    "MC-CONVERSATION-COMMERCIAL-JOB-REQUEST-001C-2C",
  ]) {
    assert.doesNotMatch(milestoneId, milestonePattern);
  }
});

test("legacy reconciliation is constrained, idempotent, append-only, and non-authoritative by itself", () => {
  const reconciliationSql = sqlSection(
    /CREATE TABLE IF NOT EXISTS professional_response_reconciliations/i,
    /CREATE INDEX IF NOT EXISTS professional_response_reconciliation_status_idx/i
  );

  for (const status of [
    "unresolved",
    "quarantined",
    "eligible",
    "reconciled",
    "excluded",
    "rejected",
  ]) {
    assert.match(reconciliationSql, new RegExp(`'${status}'`, "i"));
  }

  assert.match(
    reconciliationSql,
    /UNIQUE \(request_relationship_id, decision_version\)/i
  );
  assert.match(
    reconciliationSql,
    /UNIQUE \(request_relationship_id, idempotency_key\)/i
  );
  assert.match(
    reconciliationSql,
    /UNIQUE \(request_relationship_id, evidence_fingerprint\)/i
  );
  assert.match(
    reconciliationSql,
    /reconciliation_status = 'reconciled'[\s\S]*source_kind = 'ordinary'[\s\S]*professional_response_id IS NOT NULL/i
  );
  assert.match(
    reconciliationSql,
    /source_kind = 'ordinary'[\s\S]*post_id IS NOT NULL[\s\S]*emergency_request_id IS NULL[\s\S]*relationship_classification <> 'emergency_excluded'[\s\S]*reconciliation_status <> 'excluded'[\s\S]*evidence_classification <> 'emergency_source'/i
  );
  assert.match(
    reconciliationSql,
    /source_kind = 'emergency'[\s\S]*post_id IS NULL[\s\S]*emergency_request_id IS NOT NULL[\s\S]*relationship_classification = 'emergency_excluded'[\s\S]*reconciliation_status = 'excluded'[\s\S]*evidence_classification = 'emergency_source'[\s\S]*professional_response_id IS NULL/i
  );
  assert.match(
    reconciliationSql,
    /FOREIGN KEY \([\s\S]*request_relationship_id,[\s\S]*post_id,[\s\S]*emergency_request_id[\s\S]*\)[\s\S]*REFERENCES request_relationships\([\s\S]*id,[\s\S]*post_id,[\s\S]*emergency_request_id/i
  );
  assert.match(
    migrationSql,
    /CREATE TRIGGER professional_response_reconciliations_append_only[\s\S]*BEFORE UPDATE OR DELETE ON professional_response_reconciliations/i
  );
  assert.match(
    migrationSql,
    /professional_response_reconciliation_resolved_uidx[\s\S]*ON professional_response_reconciliations\(request_relationship_id\)[\s\S]*WHERE reconciliation_status = 'reconciled'/i
  );
});

test("request relationship additions preserve legacy nullability and isolate Emergency authority", () => {
  for (const column of [
    "professional_response_id BIGINT",
    "ordinary_authority_source TEXT",
    "current_version INTEGER",
    "closure_reason TEXT",
  ]) {
    assert.match(
      migrationSql,
      new RegExp(`ADD COLUMN IF NOT EXISTS ${column}`, "i")
    );
  }

  assert.doesNotMatch(
    migrationSql,
    /ADD COLUMN IF NOT EXISTS (?:professional_response_id|ordinary_authority_source|current_version|closure_reason)[^,;]*NOT NULL/i
  );
  assert.match(
    migrationSql,
    /emergency_request_id IS NOT NULL[\s\S]*professional_response_id IS NULL[\s\S]*ordinary_authority_source IS NULL[\s\S]*current_version IS NULL/i
  );
  assert.match(
    migrationSql,
    /post_id IS NOT NULL[\s\S]*professional_response_id IS NULL[\s\S]*ordinary_authority_source IS NULL[\s\S]*current_version IS NULL/i
  );
  assert.doesNotMatch(migrationSql, /ALTER TABLE emergency_requests/i);
});

test("reciprocal deferred constraints enforce one exact response and relationship pair", () => {
  assert.match(
    migrationSql,
    /professional_responses_relationship_key[\s\S]*UNIQUE \(request_relationship_id\)/i
  );
  assert.match(
    migrationSql,
    /request_relationships_professional_response_uidx[\s\S]*ON request_relationships\(professional_response_id\)[\s\S]*WHERE professional_response_id IS NOT NULL/i
  );
  assert.match(
    migrationSql,
    /request_relationships_professional_response_reciprocal_fk[\s\S]*FOREIGN KEY \(professional_response_id, id\)[\s\S]*REFERENCES professional_responses\(id, request_relationship_id\)[\s\S]*DEFERRABLE INITIALLY DEFERRED/i
  );
  assert.match(
    migrationSql,
    /professional_responses_relationship_reciprocal_fk[\s\S]*FOREIGN KEY \(request_relationship_id, id\)[\s\S]*REFERENCES request_relationships\(id, professional_response_id\)[\s\S]*DEFERRABLE INITIALLY DEFERRED/i
  );
  assert.match(
    migrationSql,
    /professional_responses_relationship_identity_fk[\s\S]*request_relationship_id,[\s\S]*post_id,[\s\S]*homeowner_id,[\s\S]*contractor_id,[\s\S]*professional_user_id[\s\S]*REFERENCES request_relationships/i
  );
});

test("every composite identity foreign key has an exact supporting unique key", () => {
  assert.match(
    migrationSql,
    /posts_id_user_id_uidx[\s\S]*ON posts\(id, user_id\)/i
  );
  assert.match(
    migrationSql,
    /contractor_profiles_id_user_id_uidx[\s\S]*ON contractor_profiles\(id, user_id\)/i
  );
  assert.match(
    migrationSql,
    /request_relationships_professional_response_party_uidx[\s\S]*id,[\s\S]*post_id,[\s\S]*homeowner_id,[\s\S]*contractor_id,[\s\S]*professional_user_id/i
  );
  assert.match(
    migrationSql,
    /request_relationships_reconciliation_source_uidx[\s\S]*id,[\s\S]*post_id,[\s\S]*emergency_request_id/i
  );
  assert.match(
    migrationSql,
    /professional_responses_command_result_tuple_key[\s\S]*UNIQUE \([\s\S]*id,[\s\S]*request_relationship_id,[\s\S]*post_id,[\s\S]*contractor_id,[\s\S]*professional_user_id/i
  );
  assert.match(
    migrationSql,
    /professional_responses_evidence_tuple_key[\s\S]*UNIQUE \([\s\S]*id,[\s\S]*request_relationship_id,[\s\S]*post_id,[\s\S]*contractor_id/i
  );
});

test("deferred pair trigger enforces exact parties and submitted-pending lifecycle", () => {
  assert.match(
    migrationSql,
    /CREATE FUNCTION validate_professional_response_relationship_pair\(\)[\s\S]*RETURNS TRIGGER[\s\S]*LANGUAGE plpgsql/i
  );
  assert.match(
    migrationSql,
    /relationship_record\.emergency_request_id IS NOT NULL[\s\S]*relationship_record\.post_id <>[\s\S]*relationship_record\.homeowner_id <>[\s\S]*relationship_record\.contractor_id <>[\s\S]*relationship_record\.professional_user_id <>/i
  );
  assert.match(
    migrationSql,
    /response_record\.status = 'submitted'[\s\S]*relationship_record\.status <> 'pending'/i
  );
  assert.match(
    migrationSql,
    /response_record\.status = 'selected'[\s\S]*relationship_record\.status <> 'active'/i
  );
  assert.match(
    migrationSql,
    /CREATE CONSTRAINT TRIGGER professional_responses_relationship_pair_check[\s\S]*DEFERRABLE INITIALLY DEFERRED/i
  );
  assert.match(
    migrationSql,
    /CREATE CONSTRAINT TRIGGER request_relationships_professional_response_pair_check[\s\S]*DEFERRABLE INITIALLY DEFERRED/i
  );
});

test("migration creates no selection or conversation dependency", () => {
  assert.doesNotMatch(
    executableSql,
    /\b(?:conversation_id|conversation_participant_id|message_id|thread_id|selection_id|request_selection_id)\b/i
  );
  assert.doesNotMatch(
    executableSql,
    /\b(?:conversations|conversation_participants|messages|request_selections)\b/i
  );
});

test("migration is additive, forward-only, and contains no legacy data mutation or backfill", () => {
  assert.doesNotMatch(
    executableSql,
    /\b(?:DROP\s+TABLE|DROP\s+COLUMN|TRUNCATE(?:\s+TABLE)?|DELETE\s+FROM)\b/i
  );
  assert.doesNotMatch(
    executableSql,
    /\bUPDATE\s+(?:posts|request_relationships|emergency_requests|conversations|professional_responses)\s+SET\b/i
  );
  assert.doesNotMatch(executableSql, /\bINSERT\s+INTO\b/i);
  assert.doesNotMatch(executableSql, /^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/im);
  assert.doesNotMatch(
    executableSql,
    /ALTER TABLE (?:posts|contractor_profiles|users|emergency_requests|conversations)\s+(?:DROP|ALTER COLUMN)/i
  );
  assert.match(migrationSql, /Forward-only rollback contract/i);
  assert.match(migrationSql, /Read-only post-migration validation queries/i);
});
