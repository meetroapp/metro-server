"use strict";

const fs = require("node:fs");
const path = require("node:path");
const baseAssertions = require("../004/assertions");
const baseManifest = require("../004/manifest");
const {
  ARCHIVE_MIGRATION,
  BASELINE_FILENAME,
  CANONICAL_TEAM_FILENAME,
  CONVERGENCE_ID,
  CURRENT_PRODUCTION_LEDGER,
  EXECUTION_TARGET,
  EXPECTED_POST_OWNER_MEMBERSHIP,
  EXPECTED_PRODUCTION_TARGET,
  PRODUCTION_PRESTATE,
  TARGET_MIGRATIONS,
  VARIANT_FILENAME,
} = require("./manifest");
const { sha256 } = require("./fingerprints");

const IMAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const REPOSITORY_ROOT = path.resolve(__dirname, "..", "..");
const MIGRATIONS_DIRECTORY = path.join(REPOSITORY_ROOT, "migrations");
const VARIANT_DIRECTORY = path.join(__dirname, "sql");
const {
  FILENAME_PATTERN,
  SHA256_PATTERN,
  TRANSACTION_PROHIBITED,
  blocked,
  compareLedger,
  extractTargetMarkers,
} = baseAssertions;

function validateManifest(targetMigrations = TARGET_MIGRATIONS) {
  const reasons = [];
  if (targetMigrations.length !== 49) reasons.push("TARGET_COUNT_INVALID");
  const names = targetMigrations.map(({ filename }) => filename);
  if (new Set(names).size !== names.length) reasons.push("DUPLICATE_FULL_FILENAME");
  if (names.includes(BASELINE_FILENAME)) reasons.push("BASELINE_TARGET_PROHIBITED");
  if (names.includes(ARCHIVE_MIGRATION.filename)) reasons.push("ARCHIVE_TARGET_PROHIBITED");
  if (names.includes(CANONICAL_TEAM_FILENAME)) reasons.push("CANONICAL_TEAM_TARGET_PROHIBITED");
  if (names.some((name) => !FILENAME_PATTERN.test(name))) reasons.push("FILENAME_INVALID");
  if (targetMigrations.some(({ checksum }) => !SHA256_PATTERN.test(checksum))) reasons.push("CHECKSUM_INVALID");
  if (targetMigrations.some(({ order }, index) => order !== index + 1)) reasons.push("ORDER_FIELD_INVALID");
  if (names[0] !== baseManifest.TARGET_MIGRATIONS[0].filename) reasons.push("TARGET_START_INVALID");
  if (names.at(-1) !== baseManifest.TARGET_MIGRATIONS.at(-1).filename) reasons.push("TARGET_END_INVALID");
  const position43 = targetMigrations[42];
  if (position43?.filename !== VARIANT_FILENAME) reasons.push("TEAM_VARIANT_POSITION_INVALID");
  for (const entry of targetMigrations) {
    const canonical = baseManifest.TARGET_MIGRATIONS[entry.order - 1];
    if (!canonical) continue;
    if (entry.order === 43) continue;
    if (entry.filename !== canonical.filename || entry.checksum !== canonical.checksum) {
      reasons.push(`CANONICAL_TARGET_DRIFT:${entry.order}`);
    }
  }
  if (reasons.length) throw blocked("MANIFEST_INVALID", reasons);
  return true;
}

function loadTargetMigrations({
  migrationsDirectory = MIGRATIONS_DIRECTORY,
  variantDirectory = VARIANT_DIRECTORY,
  targetMigrations = TARGET_MIGRATIONS,
} = {}) {
  validateManifest(targetMigrations);
  const canonicalRoot = fs.realpathSync(migrationsDirectory);
  const variantRoot = fs.realpathSync(variantDirectory);
  return targetMigrations.map((entry) => {
    const root = entry.filename === VARIANT_FILENAME ? variantDirectory : migrationsDirectory;
    const expectedRoot = entry.filename === VARIANT_FILENAME ? variantRoot : canonicalRoot;
    const filePath = path.join(root, entry.filename);
    if (!fs.existsSync(filePath)) throw blocked("TARGET_MIGRATION_MISSING", [entry.filename]);
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw blocked("TARGET_MIGRATION_FILE_INVALID", [entry.filename]);
    if (path.dirname(fs.realpathSync(filePath)) !== expectedRoot) {
      throw blocked("TARGET_MIGRATION_PATH_INVALID", [entry.filename]);
    }
    const sql = fs.readFileSync(filePath, "utf8");
    if (sha256(sql) !== entry.checksum) throw blocked("TARGET_MIGRATION_CHECKSUM_DRIFT", [entry.filename]);
    if (/^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/im.test(sql)) throw blocked("MIGRATION_OWNS_TRANSACTION", [entry.filename]);
    if (TRANSACTION_PROHIBITED.some((pattern) => pattern.test(sql))) {
      throw blocked("TRANSACTION_INCOMPATIBLE_MIGRATION", [entry.filename]);
    }
    return Object.freeze({ ...entry, sql });
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

function classifySnapshot(snapshot) {
  const pre = compareLedger(snapshot.ledger, CURRENT_PRODUCTION_LEDGER).exact;
  const post = compareLedger(snapshot.ledger, expectedPostLedger()).exact;
  const markers = snapshot.targetMarkers || { present: 0, expected: 0 };
  if (pre && markers.present === 0) return "READY";
  if (post && markers.expected > 0 && markers.present === markers.expected) return "ALREADY_APPLIED";
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

function assertOwnerBackfillEligibility(snapshot, expected = PRODUCTION_PRESTATE.ownerBackfillEligibility) {
  const reasons = [];
  compareObject(snapshot.ownerBackfillEligibility, expected, "ownerBackfillEligibility.", reasons);
  if (reasons.length) throw blocked("OWNER_BACKFILL_ELIGIBILITY_BLOCKED", reasons);
  return true;
}

function assertPreflightSnapshot(snapshot, expected = PRODUCTION_PRESTATE) {
  assertOwnerBackfillEligibility(snapshot, expected.ownerBackfillEligibility);
  baseAssertions.assertPreflightSnapshot(snapshot, expected);
  return "READY";
}

function assertPostflightSnapshot(snapshot, expected = PRODUCTION_PRESTATE) {
  const reasons = [];
  if (!compareLedger(snapshot.ledger, expectedPostLedger()).exact) reasons.push("LEDGER_POSTSTATE_MISMATCH");
  if (!snapshot.targetMarkers || snapshot.targetMarkers.expected === 0 ||
      snapshot.targetMarkers.present !== snapshot.targetMarkers.expected) reasons.push("TARGET_SCHEMA_INCOMPLETE");
  compareObject(snapshot.preservation, expected.preservation, "preservation.", reasons);
  compareObject(snapshot.ownerBackfillEligibility, expected.ownerBackfillEligibility,
    "ownerBackfillEligibility.", reasons);
  compareObject(snapshot.ownerMembership, EXPECTED_POST_OWNER_MEMBERSHIP, "ownerMembership.", reasons);
  if (snapshot.archiveLedger?.filename !== ARCHIVE_MIGRATION.filename) reasons.push("ARCHIVE_LEDGER_MISSING");
  if (snapshot.archiveLedger?.checksum !== ARCHIVE_MIGRATION.checksum) reasons.push("ARCHIVE_LEDGER_CHECKSUM");
  for (const [table, count] of Object.entries(snapshot.operationalCounts || {})) {
    if (count !== 0) reasons.push(`UNINTENDED_OPERATIONAL_ROWS:${table}`);
  }
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
    EXPECTED_PRODUCTION_DEPLOYMENT_ID: PRODUCTION_PRESTATE.deploymentId,
    CONFIRM_PRODUCTION_TARGET: `${EXPECTED_PRODUCTION_TARGET.projectName}/production/Postgres/railway`,
    PRODUCTION_CONVERGENCE_ID: CONVERGENCE_ID,
  };
  for (const [key, value] of Object.entries(required)) {
    if (env[key] !== value) reasons.push(`${key}_MISMATCH`);
  }
  if (execute) {
    if (!env.CERTIFIED_BACKUP_REFERENCE) reasons.push("BACKUP_REFERENCE_MISSING");
    if (!SHA256_PATTERN.test(env.CERTIFIED_BACKUP_SHA256 || "")) reasons.push("BACKUP_CHECKSUM_INVALID");
    if (!env.RESTORE_CERTIFICATION_REFERENCE) reasons.push("RESTORE_PROOF_MISSING");
    if (!env.MAINTENANCE_BRIDGE_PROOF_PATH) reasons.push("MAINTENANCE_PROOF_PATH_MISSING");
    if (!SHA256_PATTERN.test(env.MAINTENANCE_BRIDGE_PROOF_SHA256 || "")) {
      reasons.push("MAINTENANCE_PROOF_CHECKSUM_INVALID");
    }
    if (!IMAGE_DIGEST_PATTERN.test(env.EXPECTED_MAINTENANCE_BRIDGE_IMAGE_DIGEST || "")) {
      reasons.push("EXPECTED_MAINTENANCE_BRIDGE_IMAGE_INVALID");
    }
    if (!UUID_PATTERN.test(env.CURRENT_MAINTENANCE_BRIDGE_DEPLOYMENT_ID || "")) {
      reasons.push("CURRENT_MAINTENANCE_BRIDGE_DEPLOYMENT_INVALID");
    }
    if (!IMAGE_DIGEST_PATTERN.test(env.CURRENT_MAINTENANCE_BRIDGE_IMAGE_DIGEST || "")) {
      reasons.push("CURRENT_MAINTENANCE_BRIDGE_IMAGE_INVALID");
    }
    if (env.CURRENT_MAINTENANCE_BRIDGE_IMAGE_DIGEST !== env.EXPECTED_MAINTENANCE_BRIDGE_IMAGE_DIGEST) {
      reasons.push("CURRENT_MAINTENANCE_BRIDGE_IMAGE_MISMATCH");
    }
    if (env.CONFIRM_PRODUCTION_CONVERGENCE !== "EXECUTE_MC_PRODUCTION_CONVERGENCE_004_R1") {
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
  VARIANT_DIRECTORY,
  assertOwnerBackfillEligibility,
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
