"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const { getMigrationFiles } = require("../scripts/run-migrations");

const migrationName = "202608150001_activate_customer_safe_efr.sql";
const migrationPath = join(__dirname, "..", "migrations", migrationName);

test("EFR activation is the additive migration 40 boundary", () => {
  const migrations = getMigrationFiles();
  assert.equal((migrations.at(-1)?.filename || migrations.at(-1)), "202608300006_create_business_job_assignment_authority.sql");
  const migrationIndex = migrations.findIndex(({ filename }) => filename === migrationName);
  assert.equal(migrationIndex, 39);
  assert.equal(
    migrations[migrationIndex + 1].filename,
    "202608150002_activate_work_plan_execution.sql"
  );
  const sql = readFileSync(migrationPath, "utf8");
  assert.match(sql, /canonical_evaluation_finding_versions[\s\S]*customer_visible BOOLEAN NOT NULL DEFAULT FALSE/i);
  assert.match(sql, /canonical_recommendation_versions[\s\S]*customer_visible BOOLEAN NOT NULL DEFAULT FALSE/i);
  assert.match(sql, /'finding\.update'/i);
  assert.match(sql, /'recommendation\.update'/i);
  for (const command of [
    "quote.draft.create",
    "quote.scope.add",
    "quote.scope.remove",
    "quote.issue",
    "quote.customer.approve",
    "quote.customer.decline",
    "quote.revision.create",
  ]) {
    assert.match(sql, new RegExp(`'${command.replaceAll(".", "\\.")}'`));
  }
  assert.doesNotMatch(sql, /ALTER TABLE canonical_evaluations|UPDATE canonical_|INSERT INTO lifecycle_authority_grants/i);
  assert.doesNotMatch(sql, /DEFAULT TRUE/i);
});
