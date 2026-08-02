"use strict";

const assert = require("node:assert/strict");
const { readFileSync, readdirSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const migrationFilename =
  "202607250001_add_emergency_dispatch_lifecycle.sql";
const migrationsDirectory = join(__dirname, "../migrations");
const migrationPath = join(migrationsDirectory, migrationFilename);
const originalMigrationPath = join(
  migrationsDirectory,
  "202607230001_create_emergency_requests.sql"
);
const sql = readFileSync(migrationPath, "utf8");
const originalSql = readFileSync(originalMigrationPath, "utf8");

function columnDefinition(columnName) {
  const match = sql.match(
    new RegExp(
      `ADD\\s+COLUMN\\s+IF\\s+NOT\\s+EXISTS\\s+${columnName}\\s+TIMESTAMP([^,;]*)`,
      "i"
    )
  );

  assert.ok(match, `${columnName} must be added as TIMESTAMP.`);
  return match[0];
}

test("dispatch lifecycle migration is separate from the Emergency foundation", () => {
  assert.match(
    migrationFilename,
    /^\d{12}_[a-z0-9_]+\.sql$/
  );
  assert.match(
    sql,
    /ALTER TABLE emergency_requests/i
  );
  assert.match(
    originalSql,
    /CREATE TABLE IF NOT EXISTS emergency_requests/i
  );

  for (const addition of [
    "en_route_at",
    "arrived_at",
    "work_started_at",
    "completed_at",
    "professional_en_route",
    "professional_arrived",
    "work_in_progress",
    "completed",
  ]) {
    assert.doesNotMatch(
      originalSql,
      new RegExp(`\\b${addition}\\b`, "i")
    );
  }
});

test("dispatch timestamps are nullable, default-free plain TIMESTAMP columns", () => {
  for (const columnName of [
    "en_route_at",
    "arrived_at",
    "work_started_at",
    "completed_at",
  ]) {
    const definition = columnDefinition(columnName);
    assert.doesNotMatch(definition, /\bNOT\s+NULL\b/i);
    assert.doesNotMatch(definition, /\bDEFAULT\b/i);
    assert.doesNotMatch(definition, /\bGENERATED\b/i);
  }

  assert.doesNotMatch(sql, /\bCREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\b/i);
});

test("dispatch lifecycle preserves every existing and approved status", () => {
  assert.match(
    sql,
    /DROP CONSTRAINT IF EXISTS emergency_requests_status_check/i
  );
  assert.match(
    sql,
    /ADD CONSTRAINT emergency_requests_status_check[\s\S]*CHECK\s*\(\s*status IN\s*\(/i
  );

  for (const status of [
    "draft",
    "ready_for_distribution",
    "active",
    "selection_pending",
    "assigned",
    "in_service",
    "resolved",
    "cancelled",
    "expired",
    "unable_to_match",
    "safety_blocked",
    "professional_en_route",
    "professional_arrived",
    "work_in_progress",
    "completed",
  ]) {
    assert.match(sql, new RegExp(`'${status}'`, "i"));
  }
});

test("dispatch lifecycle migration is additive and runner compatible", () => {
  const droppedConstraints = [
    ...sql.matchAll(/\bDROP\s+CONSTRAINT(?:\s+IF\s+EXISTS)?\s+([a-z0-9_]+)/gi),
  ].map((match) => match[1].toLowerCase());

  assert.deepEqual(
    droppedConstraints,
    ["emergency_requests_status_check"]
  );
  assert.doesNotMatch(sql, /\bDROP\s+TABLE\b/i);
  assert.doesNotMatch(sql, /\bTRUNCATE\b/i);
  assert.doesNotMatch(sql, /\bDELETE\s+FROM\s+emergency_requests\b/i);
  assert.doesNotMatch(sql, /\bALTER\s+COLUMN\b[\s\S]*\bSET\s+NOT\s+NULL\b/i);
  assert.doesNotMatch(sql, /\bALTER\s+COLUMN\b[\s\S]*\bTYPE\b/i);
  assert.doesNotMatch(sql, /\bRENAME\s+TABLE\b/i);
  assert.doesNotMatch(sql, /\bCREATE\s+TYPE\b[\s\S]*\bAS\s+ENUM\b/i);
  assert.doesNotMatch(sql, /\bINSERT\s+INTO\b/i);
  assert.doesNotMatch(sql, /\bUPDATE\s+emergency_requests\b/i);
  assert.doesNotMatch(sql, /\bBEGIN\s*;/i);
  assert.doesNotMatch(sql, /\bCOMMIT\s*;/i);
  assert.doesNotMatch(sql, /\bROLLBACK\s*;/i);
});

test("dispatch lifecycle migration creates no separate dispatch record", () => {
  assert.doesNotMatch(
    sql,
    /\bCREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+(?:emergency_dispatch|emergency_dispatches|dispatch_records|assignments)\b/i
  );
});

test("migration inventory records canonical identity and dispatch files in order", () => {
  const readme = readFileSync(
    join(migrationsDirectory, "README.md"),
    "utf8"
  );
  const migrationFiles = readdirSync(migrationsDirectory)
    .filter((filename) => /^\d{12}_[a-z0-9_]+\.sql$/.test(filename))
    .sort();
  const inventoryFiles = [
    ...readme.matchAll(/^\d+\.\s+`([^`]+\.sql)`$/gm),
  ].map((match) => match[1]);
  const inventoryFilesWithCanonicalAdditions = [
    ...inventoryFiles,
    ...[
      "202608010001_create_commercial_authority_foundation.sql",
      "202608010002_create_canonical_evaluations.sql",
    ].filter((filename) => !inventoryFiles.includes(filename)),
  ];
  const filenames = [
    "202607210001_add_message_conversation_identity.sql",
    "202607210002_allow_dual_message_identity.sql",
    "202607230001_create_emergency_requests.sql",
    "202607240001_add_single_active_emergency_relationship.sql",
    migrationFilename,
    "202608010001_create_commercial_authority_foundation.sql",
    "202608010002_create_canonical_evaluations.sql",
  ];
  const indexes = filenames.map((filename) => migrationFiles.indexOf(filename));

  assert.deepEqual(inventoryFilesWithCanonicalAdditions, migrationFiles);
  assert.ok(indexes.every((index) => index >= 0));
  assert.deepEqual(indexes, [...indexes].sort((left, right) => left - right));
  assert.match(
    readme,
    /Migration creation and governed migration execution remain separate operations\./i
  );
});
