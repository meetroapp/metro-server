"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const migrationsDirectory = path.join(__dirname, "..", "migrations");
const migrationPath = path.join(
  migrationsDirectory,
  "202607210002_allow_dual_message_identity.sql"
);
const priorMigrationPath = path.join(
  migrationsDirectory,
  "202607210001_add_message_conversation_identity.sql"
);
const compatibilityInventoryPath = path.join(
  __dirname,
  "helpers",
  "compatibilityInventory.js"
);

const migrationSql = fs.readFileSync(migrationPath, "utf8");
const priorMigrationSql = fs.readFileSync(priorMigrationPath, "utf8");
const {
  IDENTITY_COMPATIBILITY,
} = require(compatibilityInventoryPath);

test("dual message identity migration exists at the expected path", () => {
  assert.equal(fs.existsSync(migrationPath), true);
});

test("dual message identity migration makes quote-request identity nullable", () => {
  assert.match(
    migrationSql,
    /ALTER\s+TABLE\s+messages\s+ALTER\s+COLUMN\s+quote_request_id\s+DROP\s+NOT\s+NULL\s*;/i
  );
});

test("dual message identity migration preserves the quote-request identity column", () => {
  assert.doesNotMatch(
    migrationSql,
    /DROP\s+COLUMN(?:\s+IF\s+EXISTS)?\s+quote_request_id/i
  );
  assert.doesNotMatch(
    migrationSql,
    /RENAME\s+COLUMN\s+quote_request_id/i
  );
});

test("dual message identity migration preserves the conversation identity column", () => {
  assert.doesNotMatch(
    migrationSql,
    /DROP\s+COLUMN(?:\s+IF\s+EXISTS)?\s+conversation_id/i
  );
  assert.doesNotMatch(
    migrationSql,
    /RENAME\s+COLUMN\s+conversation_id/i
  );
});

test("dual message identity migration adds the named thread identity constraint", () => {
  assert.match(
    migrationSql,
    /ADD\s+CONSTRAINT\s+messages_thread_identity_required/i
  );
  assert.match(
    migrationSql,
    /WHERE\s+conname\s*=\s*'messages_thread_identity_required'[\s\S]*?conrelid\s*=\s*'messages'::regclass/i
  );
});

test("thread identity constraint requires a conversation or quote request", () => {
  assert.match(
    migrationSql,
    /CHECK\s*\(\s*conversation_id\s+IS\s+NOT\s+NULL\s+OR\s+quote_request_id\s+IS\s+NOT\s+NULL\s*\)/i
  );
});

test("dual message identity migration contains no data mutation or destructive schema operation", () => {
  assert.doesNotMatch(migrationSql, /\bUPDATE\s+messages\b/i);
  assert.doesNotMatch(migrationSql, /\bINSERT\s+INTO\s+messages\b/i);
  assert.doesNotMatch(migrationSql, /\bDELETE\s+FROM\s+messages\b/i);
  assert.doesNotMatch(migrationSql, /\bTRUNCATE\b/i);
  assert.doesNotMatch(migrationSql, /\bDROP\s+TABLE\b/i);
  assert.doesNotMatch(migrationSql, /\bDROP\s+COLUMN\b/i);
});

test("dual message identity migration does not add a default identity", () => {
  assert.doesNotMatch(migrationSql, /\bSET\s+DEFAULT\b/i);
  assert.doesNotMatch(migrationSql, /\bDEFAULT\b/i);
});

test("dual message identity migration leaves transaction control to the runner", () => {
  assert.doesNotMatch(migrationSql, /^\s*BEGIN\s*;/im);
  assert.doesNotMatch(migrationSql, /^\s*COMMIT\s*;/im);
  assert.doesNotMatch(migrationSql, /^\s*ROLLBACK\s*;/im);
});

test("prior canonical message identity migration remains unchanged", () => {
  assert.equal(
    crypto.createHash("sha256").update(priorMigrationSql).digest("hex"),
    "885ec19aa0b2ff126c05e2d9c3a20c6110fce2c14dcb1949fb9cb6f9fc68f970"
  );
});

test("legacy quote-request identity remains inventoried", () => {
  assert.equal(
    IDENTITY_COMPATIBILITY.messages.legacyIdentityField,
    "quote_request_id"
  );
  assert.equal(
    IDENTITY_COMPATIBILITY.messages.legacyIdentityRetained,
    true
  );
});

test("canonical conversation identity remains inventoried", () => {
  assert.equal(
    IDENTITY_COMPATIBILITY.messages.canonicalConversationIdentityField,
    "conversation_id"
  );
  assert.equal(
    IDENTITY_COMPATIBILITY.messages.canonicalIdentityNullableDuringTransition,
    true
  );
});

test("automatic identity backfill remains unauthorized", () => {
  assert.equal(
    IDENTITY_COMPATIBILITY.messages.automaticBackfillAuthorized,
    false
  );
  assert.doesNotMatch(migrationSql, /\b(UPDATE|INSERT|DELETE|TRUNCATE)\b/i);
});
