"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const migrationPath = path.join(
  __dirname,
  "..",
  "migrations",
  "202607210001_add_message_conversation_identity.sql"
);

const migrationSql = fs.readFileSync(migrationPath, "utf8");

test("message conversation identity migration adds one nullable canonical foreign key", () => {
  assert.match(
    migrationSql,
    /ALTER TABLE messages/i
  );

  assert.match(
    migrationSql,
    /ADD COLUMN IF NOT EXISTS conversation_id INTEGER/i
  );

  assert.match(
    migrationSql,
    /REFERENCES conversations\(id\)/i
  );

  assert.match(
    migrationSql,
    /ON DELETE RESTRICT/i
  );

  assert.doesNotMatch(
    migrationSql,
    /conversation_id INTEGER NOT NULL/i
  );

  assert.doesNotMatch(
    migrationSql,
    /\bDEFAULT\b/i
  );
});

test("message conversation identity migration adds deterministic forward ordering", () => {
  assert.match(
    migrationSql,
    /CREATE INDEX IF NOT EXISTS messages_conversation_id_created_at_id_idx/i
  );

  assert.match(
    migrationSql,
    /ON messages\s*\(\s*conversation_id\s*,\s*created_at ASC\s*,\s*id ASC\s*\)/i
  );
});

test("message conversation identity migration preserves legacy quote-request identity", () => {
  assert.doesNotMatch(
    migrationSql,
    /DROP\s+COLUMN\s+quote_request_id/i
  );

  assert.doesNotMatch(
    migrationSql,
    /ALTER\s+COLUMN\s+quote_request_id/i
  );

  assert.doesNotMatch(
    migrationSql,
    /RENAME\s+COLUMN\s+quote_request_id/i
  );

  assert.doesNotMatch(
    migrationSql,
    /UPDATE\s+messages/i
  );

  assert.doesNotMatch(
    migrationSql,
    /INSERT\s+INTO\s+messages/i
  );
});

test("message conversation identity migration is additive and non-destructive", () => {
  assert.equal(
    (migrationSql.match(/ALTER TABLE/gi) || []).length,
    1
  );

  assert.equal(
    (migrationSql.match(/CREATE INDEX/gi) || []).length,
    1
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

test("message conversation identity migration remains runner transaction compatible", () => {
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
