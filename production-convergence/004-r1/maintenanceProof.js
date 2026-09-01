"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  EXPECTED_PRODUCTION_TARGET,
  OWNER_BACKFILL_ELIGIBILITY,
  PRODUCTION_PRESTATE,
} = require("./manifest");

const BRIDGE_VERSION = "maintenance-bridge-v1";
const MAINTENANCE_MECHANISM = "railway-immutable-maintenance-bridge-v1";
const PROOF_VERSION = 1;
const PROOF_FRESHNESS_MS = 5 * 60 * 1000;
const CLOCK_SKEW_MS = 30 * 1000;
const MAX_PROOF_BYTES = 32 * 1024;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const HEX_SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ALLOWED_CONFIGURATION_DELTA = Object.freeze([
  "activeDeploymentId",
  "sourceImageDigest",
]);
const REQUIRED_KEYS = Object.freeze([
  "proofVersion",
  "maintenanceMechanism",
  "projectId",
  "environmentId",
  "serviceId",
  "preMaintenanceDeploymentId",
  "preMaintenanceServerSha",
  "preMaintenanceImageDigest",
  "bridgeDeploymentId",
  "bridgeImageDigest",
  "bridgeVersion",
  "bridgeBecameCurrentAtUtc",
  "oldDeploymentInactiveAtUtc",
  "maintenanceVerifiedAtUtc",
  "healthMarkerVerified",
  "trafficProbeCount",
  "trafficProbeStatus",
  "oldApplicationInactive",
  "databaseReachabilityVerified",
  "configurationFingerprintBefore",
  "configurationFingerprintMaintenance",
  "allowedConfigurationDelta",
  "ownerEligibilityFingerprint",
  "databasePrestateFingerprint",
  "proofFreshnessExpiresAtUtc",
]);

function blocked(code, details = []) {
  const error = new Error(code);
  error.code = code;
  error.details = details;
  return error;
}

function canonicalize(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalize(value[key])}`
    ).join(",")}}`;
  }
  throw blocked("MAINTENANCE_PROOF_VALUE_INVALID");
}

function proofSha256(proof) {
  return crypto.createHash("sha256").update(canonicalize(proof)).digest("hex");
}

function parseUtc(value, field, reasons) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
    reasons.push(`${field}_INVALID`);
    return NaN;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) reasons.push(`${field}_INVALID`);
  return timestamp;
}

function validateMaintenanceProof(proof, {
  expectedProofSha256,
  expectedBridgeImageDigest,
  currentBridgeDeploymentId,
  currentBridgeImageDigest,
  now = new Date(),
} = {}) {
  const reasons = [];
  if (!proof || typeof proof !== "object" || Array.isArray(proof)) {
    throw blocked("MAINTENANCE_PROOF_INVALID", ["PROOF_OBJECT_REQUIRED"]);
  }
  const keys = Object.keys(proof).sort();
  const expectedKeys = [...REQUIRED_KEYS].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) reasons.push("PROOF_FIELDS_INVALID");
  if (!HEX_SHA256_PATTERN.test(expectedProofSha256 || "")) reasons.push("PROOF_SHA256_INVALID");
  else if (proofSha256(proof) !== expectedProofSha256) reasons.push("PROOF_SHA256_MISMATCH");
  if (!SHA256_PATTERN.test(expectedBridgeImageDigest || "")) reasons.push("EXPECTED_BRIDGE_DIGEST_INVALID");
  if (!UUID_PATTERN.test(currentBridgeDeploymentId || "")) reasons.push("CURRENT_BRIDGE_DEPLOYMENT_INVALID");
  if (!SHA256_PATTERN.test(currentBridgeImageDigest || "")) reasons.push("CURRENT_BRIDGE_DIGEST_INVALID");
  if (currentBridgeImageDigest !== expectedBridgeImageDigest) reasons.push("CURRENT_BRIDGE_DIGEST_MISMATCH");

  const expected = {
    proofVersion: PROOF_VERSION,
    maintenanceMechanism: MAINTENANCE_MECHANISM,
    projectId: EXPECTED_PRODUCTION_TARGET.projectId,
    environmentId: EXPECTED_PRODUCTION_TARGET.environmentId,
    serviceId: EXPECTED_PRODUCTION_TARGET.backendServiceId,
    preMaintenanceDeploymentId: PRODUCTION_PRESTATE.deploymentId,
    preMaintenanceServerSha: PRODUCTION_PRESTATE.serverSha,
    preMaintenanceImageDigest: PRODUCTION_PRESTATE.imageDigest,
    bridgeDeploymentId: currentBridgeDeploymentId,
    bridgeImageDigest: expectedBridgeImageDigest,
    bridgeVersion: BRIDGE_VERSION,
    healthMarkerVerified: true,
    trafficProbeStatus: 503,
    oldApplicationInactive: true,
    databaseReachabilityVerified: true,
    ownerEligibilityFingerprint: OWNER_BACKFILL_ELIGIBILITY.eligibilityFingerprint,
    databasePrestateFingerprint: PRODUCTION_PRESTATE.auditSchemaFingerprint,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (proof[field] !== value) reasons.push(`${field}_MISMATCH`);
  }
  if (!Number.isInteger(proof.trafficProbeCount) || proof.trafficProbeCount < 8) {
    reasons.push("trafficProbeCount_INVALID");
  }
  if (!HEX_SHA256_PATTERN.test(proof.configurationFingerprintBefore || "")) {
    reasons.push("configurationFingerprintBefore_INVALID");
  }
  if (!HEX_SHA256_PATTERN.test(proof.configurationFingerprintMaintenance || "")) {
    reasons.push("configurationFingerprintMaintenance_INVALID");
  }
  if (proof.configurationFingerprintBefore !== proof.configurationFingerprintMaintenance) {
    reasons.push("CONFIGURATION_FINGERPRINT_DRIFT");
  }
  if (JSON.stringify(proof.allowedConfigurationDelta) !== JSON.stringify(ALLOWED_CONFIGURATION_DELTA)) {
    reasons.push("ALLOWED_CONFIGURATION_DELTA_INVALID");
  }

  const currentTime = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const bridgeCurrent = parseUtc(proof.bridgeBecameCurrentAtUtc, "bridgeBecameCurrentAtUtc", reasons);
  const oldInactive = parseUtc(proof.oldDeploymentInactiveAtUtc, "oldDeploymentInactiveAtUtc", reasons);
  const verified = parseUtc(proof.maintenanceVerifiedAtUtc, "maintenanceVerifiedAtUtc", reasons);
  const expires = parseUtc(proof.proofFreshnessExpiresAtUtc, "proofFreshnessExpiresAtUtc", reasons);
  if (![currentTime, bridgeCurrent, oldInactive, verified, expires].every(Number.isFinite)) {
    reasons.push("PROOF_TIME_INVALID");
  } else {
    if (!(bridgeCurrent <= oldInactive && oldInactive <= verified)) reasons.push("PROOF_TIME_ORDER_INVALID");
    if (verified > currentTime + CLOCK_SKEW_MS) reasons.push("PROOF_FROM_FUTURE");
    if (expires <= verified || expires - verified > PROOF_FRESHNESS_MS) reasons.push("PROOF_EXPIRY_INVALID");
    if (currentTime > expires) reasons.push("PROOF_EXPIRED");
  }

  if (reasons.length) throw blocked("MAINTENANCE_PROOF_BLOCKED", [...new Set(reasons)]);
  return Object.freeze({
    status: "MAINTENANCE_PROOF_VERIFIED",
    proofSha256: expectedProofSha256,
    bridgeDeploymentId: proof.bridgeDeploymentId,
    bridgeImageDigest: proof.bridgeImageDigest,
    expiresAtUtc: proof.proofFreshnessExpiresAtUtc,
  });
}

function loadMaintenanceProof(env, { now = new Date() } = {}) {
  const proofPath = String(env.MAINTENANCE_BRIDGE_PROOF_PATH || "");
  if (!path.isAbsolute(proofPath)) throw blocked("MAINTENANCE_PROOF_PATH_BLOCKED");
  let stat;
  try {
    stat = fs.lstatSync(proofPath);
  } catch {
    throw blocked("MAINTENANCE_PROOF_FILE_MISSING");
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_PROOF_BYTES) {
    throw blocked("MAINTENANCE_PROOF_FILE_INVALID");
  }
  let proof;
  try {
    proof = JSON.parse(fs.readFileSync(proofPath, "utf8"));
  } catch {
    throw blocked("MAINTENANCE_PROOF_JSON_INVALID");
  }
  return validateMaintenanceProof(proof, {
    expectedProofSha256: env.MAINTENANCE_BRIDGE_PROOF_SHA256,
    expectedBridgeImageDigest: env.EXPECTED_MAINTENANCE_BRIDGE_IMAGE_DIGEST,
    currentBridgeDeploymentId: env.CURRENT_MAINTENANCE_BRIDGE_DEPLOYMENT_ID,
    currentBridgeImageDigest: env.CURRENT_MAINTENANCE_BRIDGE_IMAGE_DIGEST,
    now,
  });
}

module.exports = Object.freeze({
  ALLOWED_CONFIGURATION_DELTA,
  BRIDGE_VERSION,
  CLOCK_SKEW_MS,
  MAINTENANCE_MECHANISM,
  MAX_PROOF_BYTES,
  PROOF_FRESHNESS_MS,
  PROOF_VERSION,
  canonicalize,
  loadMaintenanceProof,
  proofSha256,
  validateMaintenanceProof,
});
