"use strict";

const assert = require("node:assert/strict");
const { readFileSync, readdirSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const repositoryRoot = join(__dirname, "..");
const migrationName =
  "202608070002_create_intelligence_operation_idempotency.sql";
const migrationPath = join(repositoryRoot, "migrations", migrationName);
const sql = readFileSync(migrationPath, "utf8");
const readme = readFileSync(join(repositoryRoot, "migrations", "README.md"), "utf8");

test("Intelligence idempotency migration is additive, ordered, and inventoried", () => {
  const migrations = readdirSync(join(repositoryRoot, "migrations"))
    .filter((filename) => filename.endsWith(".sql"))
    .sort();

  assert.equal(migrations.at(-1), migrationName);
  assert.equal(
    migrations.filter((filename) => filename.startsWith("202608070002_")).length,
    1
  );
  assert.match(
    readme,
    /25\. `202608070002_create_intelligence_operation_idempotency\.sql`/
  );
  assert.doesNotMatch(
    sql,
    /^\s*(?:DROP\b|TRUNCATE\b|DELETE\s+FROM\b|UPDATE\s+\S+\s+SET\b)/im
  );
});

test("schema owns scoped identity, lifecycle, bounded replay, and usage state", () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS intelligence_operation_idempotency/i);
  assert.match(sql, /actor_user_id INTEGER NOT NULL[\s\S]*REFERENCES users\(id\)/i);
  assert.match(sql, /authority_scope = 'user:' \|\| actor_user_id::TEXT/i);
  assert.match(
    sql,
    /UNIQUE \([\s\S]*actor_user_id,[\s\S]*authority_scope,[\s\S]*operation,[\s\S]*idempotency_key[\s\S]*\)/i
  );
  assert.match(sql, /request_fingerprint ~ '\^\[0-9a-f\]\{64\}\$'/i);
  assert.match(sql, /status IN \('reserved', 'executing', 'completed', 'failed'\)/i);
  assert.match(
    sql,
    /provider_execution_state IN \('not_started', 'started', 'succeeded', 'failed'\)/i
  );
  assert.match(sql, /octet_length\(result_payload::TEXT\) <= 65536/i);
  assert.match(sql, /usage_state IN \([\s\S]*'finalized'[\s\S]*'ambiguous'/i);
  assert.match(sql, /correlation_id UUID NOT NULL UNIQUE/i);
  assert.match(sql, /intelligence_operation_lifecycle_check/i);
});

test("schema remains generic and stores no raw request or commercial authority", () => {
  assert.doesNotMatch(
    sql,
    /job_request_title|job_request_description|job_request_category|raw_prompt|raw_request|auth_token|access_token/i
  );
  assert.doesNotMatch(
    sql,
    /CREATE TABLE[^;]*(relationship|conversation|evaluation|quote|invoice|payment|project)/i
  );
});
