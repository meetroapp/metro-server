"use strict";

const {
  TEST_DATABASE_PREFIX,
  inspectTestEnvironment,
} = require("./databaseTargetSafety");

const MAX_POSTGRES_IDENTIFIER_LENGTH = 63;
const TEST_DATABASE_NAME_PATTERN = /^meetro_test_[a-z0-9][a-z0-9_]*$/;

function normalizeIdentifier(identifier) {
  if (typeof identifier !== "string") {
    return "";
  }

  return identifier
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function inspectTemporaryDatabaseName(databaseName) {
  const reasons = [];

  if (typeof databaseName !== "string" || databaseName.trim() === "") {
    return {
      safe: false,
      reasons: ["Temporary database name is required."],
    };
  }

  if (!databaseName.startsWith(TEST_DATABASE_PREFIX)) {
    reasons.push(`Database name must start with ${TEST_DATABASE_PREFIX}.`);
  }

  if (!TEST_DATABASE_NAME_PATTERN.test(databaseName)) {
    reasons.push("Database name contains unsupported characters or structure.");
  }

  if (databaseName.length > MAX_POSTGRES_IDENTIFIER_LENGTH) {
    reasons.push(
      `Database name must not exceed ${MAX_POSTGRES_IDENTIFIER_LENGTH} characters.`
    );
  }

  return {
    safe: reasons.length === 0,
    reasons,
  };
}

function createTemporaryDatabaseName(uniqueIdentifier) {
  const normalizedIdentifier = normalizeIdentifier(uniqueIdentifier);

  if (!normalizedIdentifier) {
    throw new Error("A unique test database identifier is required.");
  }

  const availableLength =
    MAX_POSTGRES_IDENTIFIER_LENGTH - TEST_DATABASE_PREFIX.length;
  const databaseName =
    TEST_DATABASE_PREFIX + normalizedIdentifier.slice(0, availableLength);
  const result = inspectTemporaryDatabaseName(databaseName);

  if (!result.safe) {
    throw new Error(`Unsafe temporary database name: ${result.reasons.join(" ")}`);
  }

  return databaseName;
}

function createCleanupPlan(databaseName, { nodeEnv } = {}) {
  const environmentResult = inspectTestEnvironment(nodeEnv);
  const nameResult = inspectTemporaryDatabaseName(databaseName);
  const reasons = [...environmentResult.reasons, ...nameResult.reasons];

  if (reasons.length > 0) {
    throw new Error(`Unsafe cleanup target: ${reasons.join(" ")}`);
  }

  return Object.freeze({
    operation: "drop_database",
    databaseName,
  });
}

module.exports = {
  MAX_POSTGRES_IDENTIFIER_LENGTH,
  TEST_DATABASE_NAME_PATTERN,
  createCleanupPlan,
  createTemporaryDatabaseName,
  inspectTemporaryDatabaseName,
  normalizeIdentifier,
};
