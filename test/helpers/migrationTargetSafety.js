"use strict";

const {
  assertSafeTestDatabaseUrl,
  inspectTestDatabaseUrl,
  inspectTestEnvironment,
} = require("./databaseTargetSafety");

function inspectMigrationTarget(databaseUrl, { nodeEnv, allowExecution } = {}) {
  const environmentResult = inspectTestEnvironment(nodeEnv);
  const databaseResult = inspectTestDatabaseUrl(databaseUrl, { nodeEnv });
  const reasons = [
    ...environmentResult.reasons,
    ...databaseResult.reasons,
  ];

  if (allowExecution !== false) {
    reasons.push("Migration execution must be explicitly disabled in scaffolding.");
  }

  return {
    safe: reasons.length === 0,
    reasons: [...new Set(reasons)],
    target: databaseResult.target,
  };
}

function assertSafeMigrationPlanningTarget(databaseUrl, options) {
  const result = inspectMigrationTarget(databaseUrl, options);

  if (!result.safe) {
    throw new Error(`Unsafe migration target: ${result.reasons.join(" ")}`);
  }

  const target = assertSafeTestDatabaseUrl(databaseUrl, options);

  return Object.freeze({
    ...target,
    executionAllowed: false,
  });
}

module.exports = {
  assertSafeMigrationPlanningTarget,
  inspectMigrationTarget,
};
