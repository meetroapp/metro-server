"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  assertSafeTestDatabaseUrl,
  inspectTestDatabaseUrl,
} = require("../helpers/databaseTargetSafety");

test("rejects a production database URL", () => {
  const result = inspectTestDatabaseUrl(
    "postgresql://app:secret@production-db.example.com:5432/meetro_test_remote",
    { nodeEnv: "test" }
  );

  assert.equal(result.safe, false);
  assert.ok(
    result.reasons.includes("Production-looking database hosts are prohibited.")
  );
  assert.ok(result.reasons.includes("Database host must be local for foundation tests."));
});

test("rejects Railway database URLs", () => {
  const result = inspectTestDatabaseUrl(
    "postgresql://app:secret@containers-us-west.railway.app:5432/meetro_test_remote",
    { nodeEnv: "test" }
  );

  assert.equal(result.safe, false);
  assert.ok(result.reasons.includes("Railway database hosts are prohibited."));
  assert.ok(result.reasons.includes("Database host must be local for foundation tests."));
});

test("rejects a local database without the test-only name prefix", () => {
  const result = inspectTestDatabaseUrl(
    "postgresql://app:secret@localhost:5432/meetro",
    { nodeEnv: "test" }
  );

  assert.equal(result.safe, false);
  assert.ok(
    result.reasons.includes("Database name must start with meetro_test_.")
  );
});

test("fails closed when the database URL is missing or invalid", () => {
  assert.equal(inspectTestDatabaseUrl(undefined, { nodeEnv: "test" }).safe, false);
  assert.equal(inspectTestDatabaseUrl("", { nodeEnv: "test" }).safe, false);
  assert.equal(
    inspectTestDatabaseUrl("not-a-database-url", { nodeEnv: "test" }).safe,
    false
  );

  assert.throws(
    () => assertSafeTestDatabaseUrl(undefined, { nodeEnv: "test" }),
    /Unsafe test database target/
  );
});

test("requires NODE_ENV=test for all test-database targets", () => {
  const databaseUrl =
    "postgresql://app:secret@localhost:5432/meetro_test_environment";

  for (const nodeEnv of [undefined, "development", "production"]) {
    const result = inspectTestDatabaseUrl(databaseUrl, { nodeEnv });

    assert.equal(result.safe, false);
    assert.ok(
      result.reasons.includes(
        "NODE_ENV must equal test for test-database operations."
      )
    );
  }
});

test("accepts only an explicitly named local test database", () => {
  const target = assertSafeTestDatabaseUrl(
    "postgresql://app:secret@127.0.0.1:5432/meetro_test_smoke",
    { nodeEnv: "test" }
  );

  assert.deepEqual(target, {
    host: "127.0.0.1",
    database: "meetro_test_smoke",
  });
});
