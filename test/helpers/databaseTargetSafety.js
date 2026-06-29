"use strict";

const TEST_DATABASE_PREFIX = "meetro_test_";
const LOCAL_DATABASE_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const PRODUCTION_HOST_MARKERS = [
  "prod",
  "production",
  "railway",
  "rlwy",
];

function inspectTestEnvironment(nodeEnv) {
  if (nodeEnv === "test") {
    return {
      safe: true,
      reasons: [],
    };
  }

  return {
    safe: false,
    reasons: ["NODE_ENV must equal test for test-database operations."],
  };
}

function inspectTestDatabaseUrl(databaseUrl, { nodeEnv } = {}) {
  const reasons = [];
  let parsedUrl;
  const environmentResult = inspectTestEnvironment(nodeEnv);

  reasons.push(...environmentResult.reasons);

  if (typeof databaseUrl !== "string" || databaseUrl.trim() === "") {
    return {
      safe: false,
      reasons: ["Database URL is required."],
      target: null,
    };
  }

  try {
    parsedUrl = new URL(databaseUrl);
  } catch {
    return {
      safe: false,
      reasons: ["Database URL is invalid."],
      target: null,
    };
  }

  if (!["postgres:", "postgresql:"].includes(parsedUrl.protocol)) {
    reasons.push("Database URL must use PostgreSQL.");
  }

  const normalizedHostname = parsedUrl.hostname.toLowerCase();

  if (
    PRODUCTION_HOST_MARKERS.some((marker) => normalizedHostname.includes(marker))
  ) {
    reasons.push("Production-looking database hosts are prohibited.");
  }

  if (normalizedHostname.includes("railway")) {
    reasons.push("Railway database hosts are prohibited.");
  }

  if (!LOCAL_DATABASE_HOSTS.has(normalizedHostname)) {
    reasons.push("Database host must be local for foundation tests.");
  }

  const databaseName = decodeURIComponent(parsedUrl.pathname.replace(/^\/+/, ""));

  if (!databaseName.startsWith(TEST_DATABASE_PREFIX)) {
    reasons.push(`Database name must start with ${TEST_DATABASE_PREFIX}.`);
  }

  return {
    safe: reasons.length === 0,
    reasons,
    target: {
      host: normalizedHostname,
      database: databaseName,
    },
  };
}

function assertSafeTestDatabaseUrl(databaseUrl, options) {
  const result = inspectTestDatabaseUrl(databaseUrl, options);

  if (!result.safe) {
    throw new Error(`Unsafe test database target: ${result.reasons.join(" ")}`);
  }

  return result.target;
}

module.exports = {
  TEST_DATABASE_PREFIX,
  assertSafeTestDatabaseUrl,
  inspectTestEnvironment,
  inspectTestDatabaseUrl,
};
