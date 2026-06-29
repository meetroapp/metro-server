"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  assertSafeMigrationPlanningTarget,
  inspectMigrationTarget,
} = require("../helpers/migrationTargetSafety");

test("rejects production-like migration targets", () => {
  const result = inspectMigrationTarget(
    "postgresql://migration:secret@production-db.example.com/meetro_test_plan",
    { nodeEnv: "test", allowExecution: false }
  );

  assert.equal(result.safe, false);
  assert.ok(
    result.reasons.includes("Production-looking database hosts are prohibited.")
  );
});

test("rejects Railway-like migration targets", () => {
  const result = inspectMigrationTarget(
    "postgresql://migration:secret@containers.railway.app/meetro_test_plan",
    { nodeEnv: "test", allowExecution: false }
  );

  assert.equal(result.safe, false);
  assert.ok(result.reasons.includes("Railway database hosts are prohibited."));
});

test("rejects non-test database names and missing environment", () => {
  assert.equal(
    inspectMigrationTarget(
      "postgresql://migration:secret@localhost/meetro",
      { nodeEnv: "test", allowExecution: false }
    ).safe,
    false
  );
  assert.equal(
    inspectMigrationTarget(
      "postgresql://migration:secret@localhost/meetro_test_plan",
      { allowExecution: false }
    ).safe,
    false
  );
});

test("fails closed when migration execution is not explicitly disabled", () => {
  const result = inspectMigrationTarget(
    "postgresql://migration:secret@localhost/meetro_test_plan",
    { nodeEnv: "test" }
  );

  assert.equal(result.safe, false);
  assert.ok(
    result.reasons.includes(
      "Migration execution must be explicitly disabled in scaffolding."
    )
  );
});

test("accepts only local test planning targets with execution disabled", () => {
  const target = assertSafeMigrationPlanningTarget(
    "postgresql://migration:secret@localhost/meetro_test_plan",
    { nodeEnv: "test", allowExecution: false }
  );

  assert.deepEqual(target, {
    host: "localhost",
    database: "meetro_test_plan",
    executionAllowed: false,
  });
});
