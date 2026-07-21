"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const migrationPath = join(
  __dirname,
  "../migrations/202607200002_create_request_relationships.sql"
);

const sql = readFileSync(migrationPath, "utf8");

test("request relationship migration creates the canonical relationship table", () => {
  assert.match(
    sql,
    /CREATE TABLE IF NOT EXISTS request_relationships/i
  );

  assert.match(
    sql,
    /post_id INTEGER NOT NULL\s+REFERENCES posts\(id\)\s+ON DELETE CASCADE/i
  );

  assert.match(
    sql,
    /homeowner_id INTEGER NOT NULL\s+REFERENCES users\(id\)\s+ON DELETE CASCADE/i
  );

  assert.match(
    sql,
    /contractor_id INTEGER NOT NULL\s+REFERENCES contractor_profiles\(id\)\s+ON DELETE CASCADE/i
  );

  assert.match(
    sql,
    /professional_user_id INTEGER NOT NULL\s+REFERENCES users\(id\)\s+ON DELETE CASCADE/i
  );
});

test("request relationship migration enforces governed lifecycle states", () => {
  assert.match(
    sql,
    /status TEXT NOT NULL DEFAULT 'pending'/i
  );

  for (const status of [
    "pending",
    "active",
    "declined",
    "withdrawn",
    "closed",
  ]) {
    assert.match(sql, new RegExp(`'${status}'`, "i"));
  }

  assert.match(
    sql,
    /CHECK\s*\(\s*status IN\s*\(/i
  );
});

test("request relationship migration prevents self-relationships and duplicates", () => {
  assert.match(
    sql,
    /UNIQUE\s*\(\s*post_id\s*,\s*contractor_id\s*\)/i
  );

  assert.match(
    sql,
    /CHECK\s*\(\s*homeowner_id\s*<>\s*professional_user_id\s*\)/i
  );
});

test("request relationship migration creates lookup indexes", () => {
  assert.match(
    sql,
    /request_relationships_homeowner_idx[\s\S]*homeowner_id/i
  );

  assert.match(
    sql,
    /request_relationships_professional_idx[\s\S]*professional_user_id/i
  );

  assert.match(
    sql,
    /request_relationships_post_idx[\s\S]*post_id/i
  );
});

test("request relationship migration remains additive and transaction-runner compatible", () => {
  assert.doesNotMatch(sql, /\bDROP\s+(TABLE|COLUMN|CONSTRAINT|INDEX)\b/i);
  assert.doesNotMatch(sql, /\bTRUNCATE\b/i);
  assert.doesNotMatch(sql, /\bDELETE\s+FROM\b/i);
  assert.doesNotMatch(sql, /\bBEGIN\s*;/i);
  assert.doesNotMatch(sql, /\bCOMMIT\s*;/i);
  assert.doesNotMatch(sql, /\bROLLBACK\s*;/i);
});
