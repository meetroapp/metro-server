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
  assert.equal((migrations.at(-1)?.filename || migrations.at(-1)), "202608310001_create_business_job_customer_message_authority.sql");
  const migrationIndex = migrations.findIndex(({ filename }) => filename === migrationName);
  assert.equal(migrationIndex, 40);
  assert.equal(
    migrations[migrationIndex + 1].filename,
    "202608150003_create_job_completion_history.sql"
  );
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
