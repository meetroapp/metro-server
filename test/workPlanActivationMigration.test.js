"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const { getMigrationFiles } = require("../scripts/run-migrations");

const migrationName = "202608150002_activate_work_plan_execution.sql";
const sql = readFileSync(join(__dirname, "..", "migrations", migrationName), "utf8");

test("Work Plan execution is additive governed migration 41", () => {
  const migrations = getMigrationFiles();
  assert.equal(migrations.length, 41);
  assert.equal(migrations.at(-1).filename, migrationName);
  assert.match(sql, /canonical_work_activity_versions[\s\S]*customer_visible BOOLEAN NOT NULL DEFAULT FALSE/i);
  assert.match(sql, /'work_activity\.update'/i);
  for (const command of [
    "workstream.create",
    "finding.assign_workstream",
    "work_activity.create",
    "work_activity.progress",
    "work_obligation.create",
    "finding.resolve",
    "work_obligation.transition",
    "workstream.complete",
  ]) assert.match(sql, new RegExp(`'${command.replaceAll(".", "\\.")}'`));
  assert.doesNotMatch(sql, /DEFAULT TRUE|UPDATE canonical_|INSERT INTO lifecycle_authority_grants/i);
  assert.doesNotMatch(sql, /DROP\s+(?:TABLE|COLUMN)|TRUNCATE|DELETE\s+FROM/i);
});
