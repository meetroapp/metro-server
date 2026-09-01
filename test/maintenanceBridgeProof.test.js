"use strict";

const assert = require("node:assert/strict");
const { mkdtempSync, rmSync, symlinkSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");

const manifest = require("../production-convergence/004-r1/manifest");
const {
  ALLOWED_CONFIGURATION_DELTA,
  BRIDGE_VERSION,
  MAINTENANCE_MECHANISM,
  loadMaintenanceProof,
  proofSha256,
  validateMaintenanceProof,
} = require("../production-convergence/004-r1/maintenanceProof");

const BRIDGE_DEPLOYMENT_ID = "11111111-1111-4111-8111-111111111111";
const BRIDGE_DIGEST = `sha256:${"c".repeat(64)}`;
const NOW = new Date("2026-09-01T15:00:00Z");

function validProof() {
  return {
    proofVersion: 1,
    maintenanceMechanism: MAINTENANCE_MECHANISM,
    projectId: manifest.EXPECTED_PRODUCTION_TARGET.projectId,
    environmentId: manifest.EXPECTED_PRODUCTION_TARGET.environmentId,
    serviceId: manifest.EXPECTED_PRODUCTION_TARGET.backendServiceId,
    preMaintenanceDeploymentId: manifest.PRODUCTION_PRESTATE.deploymentId,
    preMaintenanceServerSha: manifest.PRODUCTION_PRESTATE.serverSha,
    preMaintenanceImageDigest: manifest.PRODUCTION_PRESTATE.imageDigest,
    bridgeDeploymentId: BRIDGE_DEPLOYMENT_ID,
    bridgeImageDigest: BRIDGE_DIGEST,
    bridgeVersion: BRIDGE_VERSION,
    bridgeBecameCurrentAtUtc: "2026-09-01T14:56:00Z",
    oldDeploymentInactiveAtUtc: "2026-09-01T14:57:00Z",
    maintenanceVerifiedAtUtc: "2026-09-01T14:58:00Z",
    healthMarkerVerified: true,
    trafficProbeCount: 14,
    trafficProbeStatus: 503,
    oldApplicationInactive: true,
    databaseReachabilityVerified: true,
    configurationFingerprintBefore: "d".repeat(64),
    configurationFingerprintMaintenance: "d".repeat(64),
    allowedConfigurationDelta: [...ALLOWED_CONFIGURATION_DELTA],
    ownerEligibilityFingerprint: manifest.OWNER_BACKFILL_ELIGIBILITY.eligibilityFingerprint,
    databasePrestateFingerprint: manifest.PRODUCTION_PRESTATE.auditSchemaFingerprint,
    proofFreshnessExpiresAtUtc: "2026-09-01T15:03:00Z",
  };
}

function options(proof, overrides = {}) {
  return {
    expectedProofSha256: proofSha256(proof),
    expectedBridgeImageDigest: BRIDGE_DIGEST,
    currentBridgeDeploymentId: BRIDGE_DEPLOYMENT_ID,
    currentBridgeImageDigest: BRIDGE_DIGEST,
    now: NOW,
    ...overrides,
  };
}

test("valid structured bridge proof is canonical, fresh, and accepted", () => {
  const proof = validProof();
  const result = validateMaintenanceProof(proof, options(proof));
  assert.equal(result.status, "MAINTENANCE_PROOF_VERIFIED");
  assert.equal(result.bridgeDeploymentId, BRIDGE_DEPLOYMENT_ID);
  const reordered = Object.fromEntries(Object.entries(proof).reverse());
  assert.equal(proofSha256(reordered), proofSha256(proof));
});

test("plain strings and rejected replica-pause proofs fail closed", () => {
  assert.throws(() => validateMaintenanceProof("maintenance-proof", {}), {
    code: "MAINTENANCE_PROOF_INVALID",
  });
  const proof = validProof();
  proof.maintenanceMechanism = "railway-app-replica-pause-v1";
  assert.throws(() => validateMaintenanceProof(proof, options(proof)), {
    code: "MAINTENANCE_PROOF_BLOCKED",
  });
});

test("identity, bridge, traffic, database, and configuration drift all block", () => {
  const cases = [
    (proof) => { proof.projectId = "wrong-project"; },
    (proof) => { proof.environmentId = "wrong-environment"; },
    (proof) => { proof.serviceId = "wrong-service"; },
    (proof) => { proof.preMaintenanceDeploymentId = "22222222-2222-4222-8222-222222222222"; },
    (proof) => { proof.preMaintenanceServerSha = "e".repeat(40); },
    (proof) => { proof.preMaintenanceImageDigest = `sha256:${"e".repeat(64)}`; },
    (proof) => { proof.bridgeImageDigest = `sha256:${"e".repeat(64)}`; },
    (proof) => { proof.bridgeDeploymentId = "22222222-2222-4222-8222-222222222222"; },
    (proof) => { proof.oldApplicationInactive = false; },
    (proof) => { proof.trafficProbeCount = 7; },
    (proof) => { proof.trafficProbeStatus = 200; },
    (proof) => { proof.databaseReachabilityVerified = false; },
    (proof) => { proof.databasePrestateFingerprint = "e".repeat(64); },
    (proof) => { proof.configurationFingerprintMaintenance = "e".repeat(64); },
    (proof) => { proof.allowedConfigurationDelta = ["replicas"]; },
  ];
  for (const mutate of cases) {
    const proof = validProof();
    mutate(proof);
    assert.throws(() => validateMaintenanceProof(proof, options(proof)), {
      code: "MAINTENANCE_PROOF_BLOCKED",
    });
  }
});

test("wrong proof hash, stale proof, future proof, and invalid ordering block", () => {
  const proof = validProof();
  assert.throws(() => validateMaintenanceProof(proof, options(proof, {
    expectedProofSha256: "f".repeat(64),
  })), { code: "MAINTENANCE_PROOF_BLOCKED" });
  assert.throws(() => validateMaintenanceProof(proof, options(proof, {
    now: new Date("2026-09-01T15:03:01Z"),
  })), { code: "MAINTENANCE_PROOF_BLOCKED" });

  const future = validProof();
  future.bridgeBecameCurrentAtUtc = "2026-09-01T15:01:00Z";
  future.oldDeploymentInactiveAtUtc = "2026-09-01T15:01:10Z";
  future.maintenanceVerifiedAtUtc = "2026-09-01T15:01:20Z";
  future.proofFreshnessExpiresAtUtc = "2026-09-01T15:04:00Z";
  assert.throws(() => validateMaintenanceProof(future, options(future)), {
    code: "MAINTENANCE_PROOF_BLOCKED",
  });

  const unordered = validProof();
  unordered.oldDeploymentInactiveAtUtc = "2026-09-01T14:55:00Z";
  assert.throws(() => validateMaintenanceProof(unordered, options(unordered)), {
    code: "MAINTENANCE_PROOF_BLOCKED",
  });
});

test("proof loader requires an absolute bounded regular file and exact normalized hash", () => {
  const directory = mkdtempSync(join(tmpdir(), "meetro-maintenance-proof-"));
  const proof = validProof();
  const proofPath = join(directory, "proof.json");
  const linkPath = join(directory, "proof-link.json");
  writeFileSync(proofPath, `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600 });
  symlinkSync(proofPath, linkPath);
  const env = {
    MAINTENANCE_BRIDGE_PROOF_PATH: proofPath,
    MAINTENANCE_BRIDGE_PROOF_SHA256: proofSha256(proof),
    EXPECTED_MAINTENANCE_BRIDGE_IMAGE_DIGEST: BRIDGE_DIGEST,
    CURRENT_MAINTENANCE_BRIDGE_DEPLOYMENT_ID: BRIDGE_DEPLOYMENT_ID,
    CURRENT_MAINTENANCE_BRIDGE_IMAGE_DIGEST: BRIDGE_DIGEST,
  };
  try {
    assert.equal(loadMaintenanceProof(env, { now: NOW }).status, "MAINTENANCE_PROOF_VERIFIED");
    assert.throws(() => loadMaintenanceProof({ ...env, MAINTENANCE_BRIDGE_PROOF_PATH: "relative.json" }), {
      code: "MAINTENANCE_PROOF_PATH_BLOCKED",
    });
    assert.throws(() => loadMaintenanceProof({ ...env, MAINTENANCE_BRIDGE_PROOF_PATH: linkPath }), {
      code: "MAINTENANCE_PROOF_FILE_INVALID",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
