"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const migrationPath = path.join(
  __dirname,
  "..",
  "migrations",
  "202609160002_create_homeowner_saved_professionals.sql"
);

const sql = fs.readFileSync(migrationPath, "utf8");

test("creates exact homeowner-owned Saved Professional state", () => {
  assert.match(
    sql,
    /CREATE TABLE IF NOT EXISTS homeowner_saved_professionals/
  );

  for (const field of [
    "homeowner_user_id",
    "contractor_profile_id",
    "professional_user_id",
    "status",
    "version",
    "saved_at",
    "removed_at",
  ]) {
    assert.match(sql, new RegExp(`\\b${field}\\b`));
  }

  assert.match(
    sql,
    /UNIQUE\s*\(\s*homeowner_user_id,\s*contractor_profile_id\s*\)/s
  );

  assert.match(
    sql,
    /FOREIGN KEY\s*\(\s*contractor_profile_id,\s*professional_user_id\s*\)[\s\S]*REFERENCES contractor_profiles/s
  );

  assert.match(
    sql,
    /CHECK\s*\(\s*homeowner_user_id\s*<>\s*professional_user_id\s*\)/s
  );
});

test("Save and Remove are explicit reversible preference states", () => {
  assert.match(sql, /status IN \('SAVED', 'REMOVED'\)/);

  assert.match(
    sql,
    /status = 'SAVED'[\s\S]*removed_at IS NULL/s
  );

  assert.match(
    sql,
    /status = 'REMOVED'[\s\S]*removed_at IS NOT NULL/s
  );

  assert.match(
    sql,
    /OLD\.status = 'SAVED'[\s\S]*NEW\.status = 'REMOVED'/s
  );

  assert.match(
    sql,
    /OLD\.status = 'REMOVED'[\s\S]*NEW\.status = 'SAVED'/s
  );

  assert.match(
    sql,
    /Saved Professional updates require the next version/
  );
});

test("creates an idempotent homeowner Save Remove command ledger", () => {
  assert.match(
    sql,
    /CREATE TABLE IF NOT EXISTS homeowner_saved_professional_commands/
  );

  assert.match(
    sql,
    /operation IN \('SAVE', 'REMOVE'\)/
  );

  assert.match(
    sql,
    /UNIQUE\s*\(\s*homeowner_user_id,\s*operation,\s*idempotency_key\s*\)/s
  );

  assert.match(sql, /request_hash/);
  assert.match(sql, /response_json/);
  assert.match(sql, /completed_at/);
});

test("Saved Professionals grants no relationship or work authority", () => {
  assert.doesNotMatch(sql, /INSERT\s+INTO\s+request_relationships/i);
  assert.doesNotMatch(sql, /INSERT\s+INTO\s+professional_responses/i);
  assert.doesNotMatch(sql, /INSERT\s+INTO\s+request_selections/i);
  assert.doesNotMatch(sql, /INSERT\s+INTO\s+conversations/i);
  assert.doesNotMatch(sql, /INSERT\s+INTO\s+jobs/i);
  assert.doesNotMatch(sql, /INSERT\s+INTO\s+business_customer_relationships/i);
  assert.doesNotMatch(sql, /INSERT\s+INTO\s+job_customer_parties/i);
  assert.doesNotMatch(sql, /INSERT\s+INTO\s+lifecycle_authority_grants/i);
});
