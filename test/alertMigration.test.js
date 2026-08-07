"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const migrationFilename =
  "202608030002_create_canonical_alerts.sql";
const professionalResponseMigrationFilename =
  "202608060001_create_professional_response_foundation.sql";
const migrationPath = path.join(
  __dirname,
  "..",
  "migrations",
  migrationFilename
);
const migrationSql = fs.readFileSync(migrationPath, "utf8");

test("alerts migration creates one canonical recipient-scoped table", () => {
  assert.match(
    migrationSql,
    /CREATE TABLE IF NOT EXISTS alerts\s*\(/i
  );
  assert.match(migrationSql, /id BIGSERIAL PRIMARY KEY/i);
  assert.match(
    migrationSql,
    /recipient_user_id INTEGER NOT NULL\s+REFERENCES users\(id\)\s+ON DELETE CASCADE/i
  );
});

test("alerts migration constrains source, category, priority, and lifecycle", () => {
  for (const value of [
    "communication",
    "emergency",
    "workflow",
    "commercial",
    "review",
    "business",
    "system",
  ]) assert.match(migrationSql, new RegExp(`'${value}'`));
  for (const value of [
    "business_verification",
    "critical",
    "informational",
    "dismissed",
    "resolved",
    "expired",
    "archived",
  ]) assert.match(migrationSql, new RegExp(`'${value}'`));
});

test("alerts migration enforces text and JSONB object contracts", () => {
  for (const field of [
    "source_event_type",
    "source_entity_type",
    "source_entity_id",
    "title_key",
    "message_key",
    "dedupe_key",
  ]) {
    assert.match(
      migrationSql,
      new RegExp(`char_length\\(${field}\\) BETWEEN 1 AND`, "i")
    );
  }
  assert.match(
    migrationSql,
    /source_event_id IS NULL\s+OR char_length\(source_event_id\) BETWEEN 1 AND 120/i
  );
  assert.match(
    migrationSql,
    /jsonb_typeof\(safe_payload\) = 'object'/i
  );
  assert.match(
    migrationSql,
    /jsonb_typeof\(destination_payload\) = 'object'/i
  );
});

test("alerts migration requires lifecycle timestamp consistency", () => {
  assert.match(migrationSql, /lifecycle_state <> 'dismissed'[\s\S]*dismissed_at IS NOT NULL/i);
  assert.match(migrationSql, /lifecycle_state <> 'resolved'[\s\S]*resolved_at IS NOT NULL/i);
  assert.match(migrationSql, /lifecycle_state <> 'expired'[\s\S]*expires_at IS NOT NULL/i);
  assert.match(migrationSql, /lifecycle_state <> 'archived'[\s\S]*archived_at IS NOT NULL/i);
  for (const field of [
    "read_at",
    "dismissed_at",
    "resolved_at",
    "archived_at",
    "expires_at",
  ]) {
    assert.match(
      migrationSql,
      new RegExp(`${field} IS NULL[\\s\\S]*${field} >= created_at`, "i")
    );
  }
});

test("alerts migration creates required indexes and active dedupe uniqueness", () => {
  for (const indexName of [
    "alerts_recipient_active_idx",
    "alerts_recipient_unread_idx",
    "alerts_source_lookup_idx",
    "alerts_resolution_idx",
    "alerts_expiration_idx",
    "alerts_active_dedupe_uidx",
  ]) assert.match(migrationSql, new RegExp(indexName, "i"));
  assert.match(
    migrationSql,
    /CREATE UNIQUE INDEX IF NOT EXISTS alerts_active_dedupe_uidx[\s\S]*recipient_user_id,[\s\S]*dedupe_key[\s\S]*archived_at IS NULL[\s\S]*resolved_at IS NULL[\s\S]*lifecycle_state IN \('active', 'dismissed'\)/i
  );
});

test("alerts migration remains additive and separate from producers", () => {
  assert.doesNotMatch(
    migrationSql,
    /\b(?:DROP TABLE|TRUNCATE|DELETE FROM|UPDATE)\b/i
  );
  assert.doesNotMatch(
    migrationSql,
    /workflow_events|localStorage|sessionStorage|push_token|APNs|FCM|email|SMS/i
  );
  assert.doesNotMatch(
    migrationSql,
    /conversation_participant_state|emergency_requests|request_relationships/i
  );
});

test("alerts migration precedes Professional Response authority and remains documented", () => {
  const migrationFiles = fs
    .readdirSync(path.dirname(migrationPath))
    .filter((filename) => /^\d{12}_[a-z0-9_]+\.sql$/.test(filename))
    .sort();
  assert.ok(migrationFiles.includes(professionalResponseMigrationFilename));
  assert.ok(
    migrationFiles.indexOf(migrationFilename) <
      migrationFiles.indexOf(professionalResponseMigrationFilename)
  );

  const readme = fs.readFileSync(
    path.join(path.dirname(migrationPath), "README.md"),
    "utf8"
  );
  assert.match(
    readme,
    /21\. `202608030002_create_canonical_alerts\.sql`/
  );
  assert.match(readme, /does not import legacy browser notifications/i);
});
