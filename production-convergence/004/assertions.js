"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  ARCHIVE_MIGRATION,
  BASELINE_FILENAME,
  CONVERGENCE_ID,
  CURRENT_PRODUCTION_LEDGER,
  EXECUTION_TARGET,
  EXPECTED_PRODUCTION_TARGET,
  PRODUCTION_PRESTATE,
  TARGET_MIGRATIONS,
} = require("./manifest");
const { sha256 } = require("./fingerprints");

const REPOSITORY_ROOT = path.resolve(__dirname, "..", "..");
const MIGRATIONS_DIRECTORY = path.join(REPOSITORY_ROOT, "migrations");
const FILENAME_PATTERN = /^\d{12}_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const TRANSACTION_PROHIBITED = [
  /CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY/i,
  /REINDEX\s+[^;]*CONCURRENTLY/i,
  /\bVACUUM\b/i,
  /ALTER\s+TYPE[\s\S]*ADD\s+VALUE/i,
  /CREATE\s+DATABASE/i,
  /DROP\s+DATABASE/i,
];

function blocked(code, details = []) {
  const error = new Error(code);
  error.code = code;
  error.details = details;
  return error;
}

function validateManifest(targetMigrations = TARGET_MIGRATIONS) {
  const reasons = [];
  if (targetMigrations.length !== 49) reasons.push("TARGET_COUNT_INVALID");
  const names = targetMigrations.map(({ filename }) => filename);
  if (new Set(names).size !== names.length) reasons.push("DUPLICATE_FULL_FILENAME");
  if (names.includes(BASELINE_FILENAME)) reasons.push("BASELINE_TARGET_PROHIBITED");
  if (names.includes(ARCHIVE_MIGRATION.filename)) reasons.push("ARCHIVE_TARGET_PROHIBITED");
  if (names.some((name) => !FILENAME_PATTERN.test(name))) reasons.push("FILENAME_INVALID");
  if (targetMigrations.some(({ checksum }) => !SHA256_PATTERN.test(checksum))) {
    reasons.push("CHECKSUM_INVALID");
  }
  if (targetMigrations.some(({ sourceCommit }) => !/^[0-9a-f]{40}$/.test(sourceCommit))) {
    reasons.push("SOURCE_COMMIT_INVALID");
  }
  if (targetMigrations.some(({ order }, index) => order !== index + 1)) {
    reasons.push("ORDER_FIELD_INVALID");
  }
  if (names.join("\n") !== [...names].sort().join("\n")) reasons.push("TARGET_ORDER_INVALID");
  if (names[0] !== "202608090001_create_job_lifecycle_concern_foundation.sql") {
    reasons.push("TARGET_START_INVALID");
  }
  if (names.at(-1) !== "202608310001_create_business_job_customer_message_authority.sql") {
    reasons.push("TARGET_END_INVALID");
  }
  if (reasons.length) throw blocked("MANIFEST_INVALID", reasons);
  return true;
}

function loadTargetMigrations({
  migrationsDirectory = MIGRATIONS_DIRECTORY,
  targetMigrations = TARGET_MIGRATIONS,
} = {}) {
  validateManifest(targetMigrations);
  const realDirectory = fs.realpathSync(migrationsDirectory);
  if (path.resolve(realDirectory) !== path.resolve(migrationsDirectory)) {
    throw blocked("MIGRATION_DIRECTORY_INVALID");
  }
  return targetMigrations.map((entry) => {
    const filePath = path.join(migrationsDirectory, entry.filename);
    if (!fs.existsSync(filePath)) throw blocked("TARGET_MIGRATION_MISSING", [entry.filename]);
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw blocked("TARGET_MIGRATION_FILE_INVALID", [entry.filename]);
    }
    if (path.dirname(fs.realpathSync(filePath)) !== realDirectory) {
      throw blocked("TARGET_MIGRATION_PATH_INVALID", [entry.filename]);
    }
    const sql = fs.readFileSync(filePath, "utf8");
    if (sha256(sql) !== entry.checksum) {
      throw blocked("TARGET_MIGRATION_CHECKSUM_DRIFT", [entry.filename]);
    }
    if (/^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/im.test(sql)) {
      throw blocked("MIGRATION_OWNS_TRANSACTION", [entry.filename]);
    }
    if (TRANSACTION_PROHIBITED.some((pattern) => pattern.test(sql))) {
      throw blocked("TRANSACTION_INCOMPATIBLE_MIGRATION", [entry.filename]);
    }
    return Object.freeze({ ...entry, sql });
  });
}

function extractTargetMarkers(migrations) {
  const relations = new Set();
  const columns = new Set();
  for (const { sql } of migrations) {
    for (const match of sql.matchAll(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([a-z0-9_]+)/gi)) {
      relations.add(match[1]);
    }
    for (const statement of sql.split(";")) {
      const table = statement.match(
        /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?([a-z0-9_]+)/i
      )?.[1];
      if (!table) continue;
      for (const match of statement.matchAll(
        /ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+([a-z0-9_]+)/gi
      )) {
        columns.add(`${table}.${match[1]}`);
      }
    }
  }
  return Object.freeze({
    relations: Object.freeze([...relations].sort()),
    columns: Object.freeze([...columns].sort()),
    count: relations.size + columns.size,
  });
}

function expectedPostLedger(targetMigrations = TARGET_MIGRATIONS) {
  return [
    ...CURRENT_PRODUCTION_LEDGER,
    ...targetMigrations.map(({ filename, checksum }) => ({
      filename,
      checksum,
      executionTarget: EXECUTION_TARGET,
    })),
  ].sort((left, right) => left.filename.localeCompare(right.filename));
}

function compareLedger(actual, expected) {
  const normalize = (rows) => rows
    .map(({ filename, checksum, executionTarget, execution_target }) => ({
      filename,
      checksum,
      executionTarget: executionTarget || execution_target,
    }))
    .sort((left, right) => left.filename.localeCompare(right.filename));
  const left = normalize(actual);
  const right = normalize(expected);
  return Object.freeze({
    exact: JSON.stringify(left) === JSON.stringify(right),
    actual: left,
    expected: right,
  });
}

function classifySnapshot(snapshot) {
  const pre = compareLedger(snapshot.ledger, CURRENT_PRODUCTION_LEDGER).exact;
  const post = compareLedger(snapshot.ledger, expectedPostLedger()).exact;
  const markers = snapshot.targetMarkers || { present: 0, expected: 0 };
  if (pre && markers.present === 0) return "READY";
  if (post && markers.expected > 0 && markers.present === markers.expected) {
    return "ALREADY_APPLIED";
  }
  return "BLOCKED";
}

function compareObject(actual, expected, prefix, reasons) {
  for (const [key, expectedValue] of Object.entries(expected)) {
    const actualValue = actual?.[key];
    if (expectedValue && typeof expectedValue === "object" && !Array.isArray(expectedValue)) {
      compareObject(actualValue, expectedValue, `${prefix}${key}.`, reasons);
    } else if (actualValue !== expectedValue) {
      reasons.push(`${prefix}${key}`);
    }
  }
}

function assertPreflightSnapshot(snapshot, expected = PRODUCTION_PRESTATE) {
  const reasons = [];
  if (!String(snapshot.postgresVersion || "").startsWith(expected.postgresVersion)) {
    reasons.push("POSTGRES_VERSION_MISMATCH");
  }
  if (!compareLedger(snapshot.ledger, CURRENT_PRODUCTION_LEDGER).exact) {
    reasons.push("LEDGER_PRESTATE_MISMATCH");
  }
  if ((snapshot.targetMarkers?.present || 0) !== 0) reasons.push("PARTIAL_TARGET_SCHEMA");
  compareObject(snapshot.catalog, expected.catalog, "catalog.", reasons);
  compareObject(snapshot.preservation, expected.preservation, "preservation.", reasons);
  if (reasons.length) throw blocked("PREFLIGHT_BLOCKED", reasons);
  return "READY";
}

function assertPostflightSnapshot(snapshot, expectedPreservation = PRODUCTION_PRESTATE.preservation) {
  const reasons = [];
  if (!compareLedger(snapshot.ledger, expectedPostLedger()).exact) {
    reasons.push("LEDGER_POSTSTATE_MISMATCH");
  }
  if (
    !snapshot.targetMarkers ||
    snapshot.targetMarkers.expected === 0 ||
    snapshot.targetMarkers.present !== snapshot.targetMarkers.expected
  ) reasons.push("TARGET_SCHEMA_INCOMPLETE");
  compareObject(snapshot.preservation, expectedPreservation, "preservation.", reasons);
  if (snapshot.archiveLedger?.filename !== ARCHIVE_MIGRATION.filename) {
    reasons.push("ARCHIVE_LEDGER_MISSING");
  }
  if (snapshot.archiveLedger?.checksum !== ARCHIVE_MIGRATION.checksum) {
    reasons.push("ARCHIVE_LEDGER_CHECKSUM");
  }
  for (const [table, count] of Object.entries(snapshot.operationalCounts || {})) {
    if (count !== 0) reasons.push(`UNINTENDED_OPERATIONAL_ROWS:${table}`);
  }
  const owner = snapshot.ownerMembership || {};
  if (owner.businesses !== expectedPreservation.contractor_profiles.count) {
    reasons.push("OWNER_BUSINESS_COUNT");
  }
  if (owner.owners !== expectedPreservation.contractor_profiles.count) {
    reasons.push("OWNER_MEMBERSHIP_COUNT");
  }
  if (owner.duplicateOwners !== 0) reasons.push("DUPLICATE_OWNER_MEMBERSHIP");
  if (owner.nonOwners !== 0) reasons.push("UNINTENDED_NON_OWNER_MEMBERSHIP");
  if (owner.unrelatedOwners !== 0) reasons.push("UNRELATED_OWNER_MEMBERSHIP");
  if (reasons.length) throw blocked("POSTFLIGHT_BLOCKED", reasons);
  return "ALREADY_APPLIED";
}

function inspectAuthorization(env, { execute = false } = {}) {
  const reasons = [];
  const required = {
    NODE_ENV: "production",
    RAILWAY_PROJECT_ID: EXPECTED_PRODUCTION_TARGET.projectId,
    RAILWAY_PROJECT_NAME: EXPECTED_PRODUCTION_TARGET.projectName,
    RAILWAY_ENVIRONMENT_ID: EXPECTED_PRODUCTION_TARGET.environmentId,
    RAILWAY_ENVIRONMENT_NAME: EXPECTED_PRODUCTION_TARGET.environmentName,
    RAILWAY_SERVICE_ID: EXPECTED_PRODUCTION_TARGET.databaseServiceId,
    RAILWAY_SERVICE_NAME: EXPECTED_PRODUCTION_TARGET.databaseServiceName,
    EXPECTED_PRESTATE_SERVER_SHA: PRODUCTION_PRESTATE.serverSha,
    EXPECTED_PRESTATE_IMAGE_DIGEST: PRODUCTION_PRESTATE.imageDigest,
    CERTIFIED_HISTORICAL_PRODUCTION_DEPLOYMENT_ID:
      PRODUCTION_PRESTATE.historicalCertifiedDeploymentId,
    CONFIRM_PRODUCTION_TARGET:
      `${EXPECTED_PRODUCTION_TARGET.projectName}/production/Postgres/railway`,
    PRODUCTION_CONVERGENCE_ID: CONVERGENCE_ID,
  };
  for (const [key, value] of Object.entries(required)) {
    if (env[key] !== value) reasons.push(`${key}_MISMATCH`);
  }
  if (execute) {
    if (!env.CERTIFIED_BACKUP_REFERENCE) reasons.push("BACKUP_REFERENCE_MISSING");
    if (!SHA256_PATTERN.test(env.CERTIFIED_BACKUP_SHA256 || "")) {
      reasons.push("BACKUP_CHECKSUM_INVALID");
    }
    if (!env.RESTORE_CERTIFICATION_REFERENCE) reasons.push("RESTORE_PROOF_MISSING");
    if (!env.MAINTENANCE_TRAFFIC_PAUSE_PROOF) reasons.push("MAINTENANCE_PROOF_MISSING");
    if (env.CONFIRM_PRODUCTION_CONVERGENCE !== "EXECUTE_MC_PRODUCTION_CONVERGENCE_004") {
      reasons.push("EXECUTION_ACKNOWLEDGEMENT_MISMATCH");
    }
  }
  return Object.freeze({ authorized: reasons.length === 0, reasons });
}

module.exports = Object.freeze({
  FILENAME_PATTERN,
  MIGRATIONS_DIRECTORY,
  SHA256_PATTERN,
  TRANSACTION_PROHIBITED,
  assertPostflightSnapshot,
  assertPreflightSnapshot,
  blocked,
  classifySnapshot,
  compareLedger,
  expectedPostLedger,
  extractTargetMarkers,
  inspectAuthorization,
  loadTargetMigrations,
  validateManifest,
});
