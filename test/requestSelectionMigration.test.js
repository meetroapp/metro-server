"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const migrationFilename =
  "202608060002_create_request_selection_authority.sql";
const migrationPath = path.join(
  __dirname,
  "..",
  "migrations",
  migrationFilename
);
const migrationSql = fs.readFileSync(migrationPath, "utf8");
const executableSql = migrationSql.replace(/^\s*--.*$/gm, "");

function section(startPattern, endPattern) {
  const start = migrationSql.search(startPattern);
  const end = migrationSql.search(endPattern);
  assert.notEqual(start, -1, `Missing section ${startPattern}`);
  assert.ok(end > start, `Invalid section boundary ${endPattern}`);
  return migrationSql.slice(start, end);
}

test("selection migration is the unique latest governed migration and is documented", () => {
  const directory = path.dirname(migrationPath);
  const migrations = fs
    .readdirSync(directory)
    .filter((filename) => /^\d{12}_[a-z0-9_]+\.sql$/.test(filename))
    .sort();

  assert.equal(migrations.at(-1), migrationFilename);
  assert.equal(
    migrations.filter((filename) =>
      filename.startsWith("202608060002_")
    ).length,
    1
  );

  const readme = fs.readFileSync(
    path.join(directory, "README.md"),
    "utf8"
  );
  assert.match(
    readme,
    /23\. `202608060002_create_request_selection_authority\.sql`/
  );
  assert.match(
    readme,
    /does not select a response, create a conversation,[\s\S]*reconcile legacy records, or alter Emergency authority/i
  );
});

test("selection identity proves the exact request, response, relationship, parties, version, and conversation", () => {
  const selectionSql = section(
    /CREATE TABLE IF NOT EXISTS request_selections/i,
    /CREATE UNIQUE INDEX IF NOT EXISTS\s+request_selections_one_active_per_post_uidx/i
  );

  assert.match(selectionSql, /\bid BIGSERIAL PRIMARY KEY\b/i);
  for (const field of [
    "post_id INTEGER NOT NULL",
    "professional_response_id BIGINT NOT NULL",
    "request_relationship_id INTEGER NOT NULL",
    "selected_by_user_id INTEGER NOT NULL",
    "contractor_id INTEGER NOT NULL",
    "professional_user_id INTEGER NOT NULL",
    "selected_response_version INTEGER NOT NULL",
    "conversation_id INTEGER NOT NULL",
    "selected_at TIMESTAMPTZ NOT NULL",
  ]) {
    assert.match(selectionSql, new RegExp(field, "i"));
  }

  assert.match(
    selectionSql,
    /request_selections_response_identity_fk[\s\S]*REFERENCES professional_responses\([\s\S]*id,[\s\S]*request_relationship_id,[\s\S]*post_id,[\s\S]*homeowner_id,[\s\S]*contractor_id,[\s\S]*professional_user_id/i
  );
  assert.match(
    selectionSql,
    /request_selections_response_version_fk[\s\S]*REFERENCES professional_response_versions/i
  );
  assert.match(
    selectionSql,
    /request_selections_relationship_identity_fk[\s\S]*REFERENCES request_relationships/i
  );
});

test("database constraints enforce one active selection and one active ordinary relationship", () => {
  assert.match(
    migrationSql,
    /request_selections_one_active_per_post_uidx[\s\S]*ON request_selections\(post_id\)[\s\S]*WHERE ended_at IS NULL/i
  );
  assert.match(
    migrationSql,
    /request_relationships_one_active_ordinary_uidx[\s\S]*ON request_relationships\(post_id\)[\s\S]*post_id IS NOT NULL[\s\S]*emergency_request_id IS NULL[\s\S]*status = 'active'/i
  );
});

test("ordinary conversation provenance is exact while legacy and Emergency rows remain nullable", () => {
  assert.match(
    migrationSql,
    /ALTER TABLE conversations[\s\S]*ADD COLUMN IF NOT EXISTS request_selection_id BIGINT/i
  );
  assert.doesNotMatch(
    migrationSql,
    /ADD COLUMN IF NOT EXISTS request_selection_id BIGINT NOT NULL/i
  );
  assert.match(
    migrationSql,
    /conversations_request_selection_uidx[\s\S]*WHERE request_selection_id IS NOT NULL/i
  );
  assert.match(
    migrationSql,
    /request_selections_conversation_identity_fk[\s\S]*REFERENCES conversations\([\s\S]*id,[\s\S]*relationship_id,[\s\S]*homeowner_id,[\s\S]*contractor_id,[\s\S]*professional_user_id,[\s\S]*request_selection_id[\s\S]*DEFERRABLE INITIALLY DEFERRED/i
  );
  assert.match(
    migrationSql,
    /Emergency conversations cannot use ordinary selection authority/i
  );
  assert.match(
    migrationSql,
    /New ordinary conversations require canonical selection authority/i
  );
});

test("selection idempotency is durable, fingerprinted, exact-result linked, and client-identity independent", () => {
  const commandSql = section(
    /CREATE TABLE IF NOT EXISTS request_selection_command_idempotency/i,
    /CREATE INDEX IF NOT EXISTS request_selection_command_result_idx/i
  );

  assert.match(commandSql, /\bid UUID PRIMARY KEY\b/i);
  assert.match(
    commandSql,
    /command_name TEXT NOT NULL DEFAULT 'request_selection\.select'/i
  );
  assert.match(
    commandSql,
    /request_fingerprint ~ '\^\[0-9a-f\]\{64\}\$'/i
  );
  assert.match(
    commandSql,
    /UNIQUE \([\s\S]*actor_user_id,[\s\S]*command_name,[\s\S]*command_scope,[\s\S]*idempotency_key/i
  );
  assert.match(
    commandSql,
    /request_selection_command_result_fk[\s\S]*REFERENCES request_selections/i
  );
  assert.match(
    commandSql,
    /request_selection_command_completion_check[\s\S]*completed_at IS NULL[\s\S]*completed_at IS NOT NULL/i
  );
});

test("selection evidence is exact, immutable, and attributed only to 001B-3", () => {
  const evidenceSql = section(
    /CREATE TABLE IF NOT EXISTS request_selection_evidence/i,
    /CREATE FUNCTION prevent_request_selection_evidence_mutation/i
  );

  for (const field of [
    "request_selection_id BIGINT NOT NULL",
    "post_id INTEGER NOT NULL",
    "professional_response_id BIGINT NOT NULL",
    "selected_response_version INTEGER NOT NULL",
    "request_relationship_id INTEGER NOT NULL",
    "actor_user_id INTEGER NOT NULL",
    "contractor_id INTEGER NOT NULL",
    "professional_user_id INTEGER NOT NULL",
    "conversation_id INTEGER NOT NULL",
  ]) {
    assert.match(evidenceSql, new RegExp(field, "i"));
  }
  assert.match(
    evidenceSql,
    /previous_response_status TEXT NOT NULL[\s\S]*'submitted'/i
  );
  assert.match(
    evidenceSql,
    /new_response_status TEXT NOT NULL[\s\S]*'selected'/i
  );
  assert.match(
    evidenceSql,
    /implementation_milestone_id TEXT NOT NULL[\s\S]*MC-CONVERSATION-COMMERCIAL-JOB-REQUEST-001B-3/i
  );
  assert.doesNotMatch(
    evidenceSql,
    /implementation_milestone_id TEXT NOT NULL\s+DEFAULT/i
  );
  assert.match(
    migrationSql,
    /CREATE TRIGGER request_selection_evidence_append_only[\s\S]*BEFORE UPDATE OR DELETE ON request_selection_evidence/i
  );
});

test("deferred authority validation requires selected-active-conversation consistency", () => {
  assert.match(
    migrationSql,
    /CREATE FUNCTION validate_request_selection_authority\(\)[\s\S]*response_record\.status <> 'selected'[\s\S]*relationship_record\.status <> 'active'[\s\S]*conversation_record\.request_selection_id <> selection_record\.id/i
  );
  for (const trigger of [
    "request_selections_authority_check",
    "conversations_request_selection_authority_check",
    "professional_responses_selection_authority_check",
    "request_relationships_selection_authority_check",
  ]) {
    assert.match(
      migrationSql,
      new RegExp(
        `CREATE CONSTRAINT TRIGGER ${trigger}[\\s\\S]*DEFERRABLE INITIALLY DEFERRED`,
        "i"
      )
    );
  }
});

test("migration is additive and performs no runtime or legacy mutation", () => {
  assert.doesNotMatch(
    executableSql,
    /\b(?:DROP\s+TABLE|DROP\s+COLUMN|TRUNCATE(?:\s+TABLE)?|DELETE\s+FROM)\b/i
  );
  assert.doesNotMatch(
    executableSql,
    /\b(?:INSERT\s+INTO|UPDATE\s+(?:posts|professional_responses|request_relationships|conversations)\s+SET)\b/i
  );
  assert.doesNotMatch(executableSql, /ALTER TABLE emergency_requests/i);
  assert.doesNotMatch(executableSql, /^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/im);
  assert.match(migrationSql, /Forward-only rollback contract/i);
  assert.match(migrationSql, /Read-only post-migration validation queries/i);
});
