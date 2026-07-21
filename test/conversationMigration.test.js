"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const migrationPath = path.join(
  __dirname,
  "..",
  "migrations",
  "202607200003_create_conversations.sql"
);

const migrationSql = fs.readFileSync(migrationPath, "utf8");

test("conversation migration creates the canonical conversation table", () => {
  assert.match(
    migrationSql,
    /CREATE TABLE IF NOT EXISTS conversations\s*\(/i
  );

  assert.match(
    migrationSql,
    /relationship_id INTEGER NOT NULL\s+REFERENCES request_relationships\(id\)/i
  );

  assert.match(
    migrationSql,
    /homeowner_id INTEGER NOT NULL\s+REFERENCES users\(id\)/i
  );

  assert.match(
    migrationSql,
    /contractor_id INTEGER NOT NULL\s+REFERENCES contractor_profiles\(id\)/i
  );

  assert.match(
    migrationSql,
    /professional_user_id INTEGER NOT NULL\s+REFERENCES users\(id\)/i
  );
});

test("conversation migration enforces one conversation per relationship", () => {
  assert.match(
    migrationSql,
    /CONSTRAINT conversations_unique_relationship\s+UNIQUE \(relationship_id\)/i
  );
});

test("conversation migration enforces the governed conversation lifecycle", () => {
  assert.match(
    migrationSql,
    /status TEXT NOT NULL DEFAULT 'active'/i
  );

  for (const status of ["active", "closed"]) {
    assert.match(
      migrationSql,
      new RegExp(`'${status}'`, "i")
    );
  }

  for (const unsupportedStatus of [
    "pending",
    "archived",
    "declined",
    "withdrawn",
    "deleted",
  ]) {
    assert.doesNotMatch(
      migrationSql,
      new RegExp(`'${unsupportedStatus}'`, "i")
    );
  }
});

test("conversation migration protects permanent records from cascading deletion", () => {
  const restrictCount =
    migrationSql.match(/ON DELETE RESTRICT/gi)?.length || 0;

  assert.equal(restrictCount, 4);

  assert.doesNotMatch(
    migrationSql,
    /ON DELETE CASCADE/i
  );

  assert.doesNotMatch(
    migrationSql,
    /\bDROP\s+(TABLE|COLUMN|CONSTRAINT|INDEX)\b/i
  );

  assert.doesNotMatch(
    migrationSql,
    /\bDELETE\s+FROM\b/i
  );

  assert.doesNotMatch(
    migrationSql,
    /\bTRUNCATE\b/i
  );
});

test("conversation migration prevents self-conversations", () => {
  assert.match(
    migrationSql,
    /CONSTRAINT conversations_different_users\s+CHECK \(homeowner_id <> professional_user_id\)/i
  );
});

test("conversation migration creates participant and lifecycle lookup indexes", () => {
  assert.match(
    migrationSql,
    /CREATE INDEX IF NOT EXISTS conversations_homeowner_idx\s+ON conversations\(homeowner_id\)/i
  );

  assert.match(
    migrationSql,
    /CREATE INDEX IF NOT EXISTS conversations_professional_idx\s+ON conversations\(professional_user_id\)/i
  );

  assert.match(
    migrationSql,
    /CREATE INDEX IF NOT EXISTS conversations_contractor_idx\s+ON conversations\(contractor_id\)/i
  );

  assert.match(
    migrationSql,
    /CREATE INDEX IF NOT EXISTS conversations_status_idx\s+ON conversations\(status\)/i
  );
});

test("conversation migration preserves participant-specific archive and closure timestamps", () => {
  assert.match(
    migrationSql,
    /homeowner_archived_at TIMESTAMP/i
  );

  assert.match(
    migrationSql,
    /professional_archived_at TIMESTAMP/i
  );

  assert.match(
    migrationSql,
    /closed_at TIMESTAMP/i
  );

  assert.match(
    migrationSql,
    /created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP/i
  );

  assert.match(
    migrationSql,
    /updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP/i
  );
});

test("conversation migration remains transaction-runner compatible", () => {
  assert.doesNotMatch(
    migrationSql,
    /\bBEGIN\s*;/i
  );

  assert.doesNotMatch(
    migrationSql,
    /\bCOMMIT\s*;/i
  );

  assert.doesNotMatch(
    migrationSql,
    /\bROLLBACK\s*;/i
  );
});
