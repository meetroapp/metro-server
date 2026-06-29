"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createCleanupPlan,
  createTemporaryDatabaseName,
  inspectTemporaryDatabaseName,
} = require("../helpers/temporaryDatabaseSafety");

test("generates deterministic allowlisted temporary database names", () => {
  assert.equal(
    createTemporaryDatabaseName("CI Run 2048"),
    "meetro_test_ci_run_2048"
  );
  assert.equal(
    createTemporaryDatabaseName("CI Run 2048"),
    "meetro_test_ci_run_2048"
  );
});

test("rejects invalid and production-style database names", () => {
  for (const databaseName of [
    "",
    "meetro",
    "production",
    "meetro_production",
    "meetro_test_bad-name",
    "meetro_test_",
  ]) {
    assert.equal(inspectTemporaryDatabaseName(databaseName).safe, false);
  }
});

test("accepts valid test-only database names", () => {
  assert.equal(
    inspectTemporaryDatabaseName("meetro_test_local_001").safe,
    true
  );
});

test("cleanup planning rejects non-test and invalid targets", () => {
  for (const databaseName of [
    "meetro",
    "production",
    "meetro_production",
    "meetro_test_bad-name",
  ]) {
    assert.throws(
      () => createCleanupPlan(databaseName, { nodeEnv: "test" }),
      /Unsafe cleanup target/
    );
  }
});

test("cleanup planning enforces NODE_ENV=test", () => {
  for (const nodeEnv of [undefined, "development", "production"]) {
    assert.throws(
      () =>
        createCleanupPlan("meetro_test_cleanup_001", {
          nodeEnv,
        }),
      /NODE_ENV must equal test/
    );
  }
});

test("cleanup planning returns metadata only for a validated target", () => {
  const plan = createCleanupPlan("meetro_test_cleanup_001", {
    nodeEnv: "test",
  });

  assert.deepEqual(plan, {
    operation: "drop_database",
    databaseName: "meetro_test_cleanup_001",
  });
  assert.equal(Object.isFrozen(plan), true);
});

test("temporary database generation fails closed without an identifier", () => {
  assert.throws(
    () => createTemporaryDatabaseName(),
    /unique test database identifier/
  );
  assert.throws(
    () => createTemporaryDatabaseName("***"),
    /unique test database identifier/
  );
});
