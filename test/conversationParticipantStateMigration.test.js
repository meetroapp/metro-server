"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const migrationFilename =
  "202608030001_create_conversation_participant_state.sql";
const migrationPath = path.join(
  __dirname,
  "..",
  "migrations",
  migrationFilename
);
const migrationSql = fs.readFileSync(
  migrationPath,
  "utf8"
);

test("participant-state migration creates the canonical table and compound key", () => {
  assert.match(
    migrationSql,
    /CREATE TABLE IF NOT EXISTS conversation_participant_state\s*\(/i
  );
  assert.match(
    migrationSql,
    /conversation_id INTEGER NOT NULL\s+REFERENCES conversations\(id\)\s+ON DELETE CASCADE/i
  );
  assert.match(
    migrationSql,
    /user_id INTEGER NOT NULL\s+REFERENCES users\(id\)\s+ON DELETE CASCADE/i
  );
  assert.match(
    migrationSql,
    /last_read_message_id INTEGER\s+REFERENCES messages\(id\)\s+ON DELETE SET NULL/i
  );
  assert.match(
    migrationSql,
    /PRIMARY KEY \(conversation_id, user_id\)/i
  );
});
test("participant-state migration constrains canonical participant roles", () => {
  assert.match(
    migrationSql,
    /participant_role TEXT NOT NULL[\s\S]*?participant_role IN\s*\(\s*'homeowner',\s*'professional'\s*\)/i
  );
});

test("participant-state migration creates the approved lookup indexes", () => {
  assert.match(
    migrationSql,
    /CREATE INDEX IF NOT EXISTS conversation_participant_state_user_idx\s+ON conversation_participant_state\(user_id\)/i
  );
  assert.match(
    migrationSql,
    /CREATE INDEX IF NOT EXISTS conversation_participant_state_last_read_message_idx\s+ON conversation_participant_state\(last_read_message_id\)\s+WHERE last_read_message_id IS NOT NULL/i
  );
});

test("backfill creates exactly the two canonical participant roles", () => {
  assert.match(
    migrationSql,
    /conversations\.homeowner_id, 'homeowner'/i
  );
  assert.match(
    migrationSql,
    /conversations\.professional_user_id,\s*'professional'/i
  );
  assert.doesNotMatch(
    migrationSql,
    /request_relationships|contractor_profiles/i
  );
});

test("backfill marks existing canonical history read without inferring legacy identity", () => {
  assert.match(
    migrationSql,
    /WHERE messages\.conversation_id = conversations\.id\s+ORDER BY messages\.id DESC\s+LIMIT 1/i
  );
  assert.match(
    migrationSql,
    /LEFT JOIN LATERAL[\s\S]*?AS latest_message ON TRUE/i
  );
  assert.match(
    migrationSql,
    /COALESCE\(\s*latest_message\.created_at,\s*CURRENT_TIMESTAMP\s*\)/i
  );
  assert.doesNotMatch(migrationSql, /quote_request_id/i);
});

test("participant-state migration is additive and leaves canonical records unchanged", () => {
  assert.doesNotMatch(
    migrationSql,
    /\b(?:UPDATE|DELETE FROM|TRUNCATE|DROP TABLE|DROP COLUMN)\b/i
  );
  assert.doesNotMatch(
    migrationSql,
    /INSERT INTO\s+(?:messages|conversations|request_relationships)\b/i
  );
  assert.match(
    migrationSql,
    /ON CONFLICT \(conversation_id, user_id\)\s+DO NOTHING/i
  );
});

test("participant-state migration remains governed-runner compatible and ordered", () => {
  assert.doesNotMatch(migrationSql, /^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/im);

  const migrationFiles = fs
    .readdirSync(path.dirname(migrationPath))
    .filter((filename) => /^\d{12}_[a-z0-9_]+\.sql$/.test(filename))
    .sort();

  assert.equal(migrationFiles.at(-1), migrationFilename);

  const readme = fs.readFileSync(
    path.join(path.dirname(migrationPath), "README.md"),
    "utf8"
  );
  assert.match(
    readme,
    /20\. `202608030001_create_conversation_participant_state\.sql`/
  );
});
