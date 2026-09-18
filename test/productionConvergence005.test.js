"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const manifest =
  require("../production-convergence/005/manifest");

const {
  assertPostflightSnapshot,
  assertPreflightSnapshot,
  classifySnapshot,
  expectedPostLedger,
  extractTargetMarkers,
  inspectAuthorization,
  loadTargetMigrations,
  validateManifest,
} =
  require("../production-convergence/005/assertions");

const {
  objectFingerprint,
  prestateFingerprint,
} =
  require("../production-convergence/005/fingerprints");

const {
  ALLOWED_CONFIGURATION_DELTA,
  MAINTENANCE_MECHANISM,
  PROOF_VERSION,
  proofSha256,
  validateMaintenanceProof,
} =
  require("../production-convergence/005/maintenanceProof");

const {
  executeConvergence,
  parseMode,
  run,
} =
  require("../scripts/run-production-convergence-005");

function markers() {
  return extractTargetMarkers(
    loadTargetMigrations()
  );
}

function preSnapshot() {
  const targetMarkers = markers();

  const snapshot = {
    postgresVersion:
      "18.6 (synthetic)",

    ledger:
      manifest.CURRENT_PRODUCTION_LEDGER
        .map(entry => ({ ...entry })),

    ledgerFingerprint:
      manifest.PRESTATE_LEDGER_FINGERPRINT,

    catalog:
      structuredClone(
        manifest.PRODUCTION_PRESTATE.catalog
      ),

    catalogFingerprint:
      manifest.PRESTATE_CATALOG_FINGERPRINT,

    preservation:
      structuredClone(
        manifest.PRODUCTION_PRESTATE.preservation
      ),

    ownerBackfillEligibility:
      structuredClone(
        manifest.PRODUCTION_PRESTATE
          .ownerBackfillEligibility
      ),

    ownerMembership:
      structuredClone(
        manifest.PRODUCTION_PRESTATE
          .ownerMembership
      ),

    operationalCounts:
      structuredClone(
        manifest.PRODUCTION_PRESTATE
          .operationalCounts
      ),

    targetMarkers: {
      expected: targetMarkers.count,
      present: 0,
    },
  };

  snapshot.prestateFingerprint =
    prestateFingerprint(
      snapshot,
      {
        postgresVersionPrefix:
          manifest.PRODUCTION_PRESTATE
            .postgresVersion,
      }
    );

  return snapshot;
}

function postSnapshot() {
  const targetMarkers = markers();
  const snapshot = preSnapshot();

  snapshot.ledger =
    expectedPostLedger()
      .map(entry => ({ ...entry }));

  snapshot.ledgerFingerprint =
    manifest.EXPECTED_POST_LEDGER_FINGERPRINT;

  snapshot.catalog =
    structuredClone(
      manifest.EXPECTED_POST_CATALOG
    );

  snapshot.catalogFingerprint =
    manifest.EXPECTED_POST_CATALOG_FINGERPRINT;

  snapshot.targetMarkers = {
    expected: targetMarkers.count,
    present: targetMarkers.count,
  };

  return snapshot;
}

function baseEnvironment() {
  return {
    NODE_ENV:
      "production",

    RAILWAY_PROJECT_ID:
      manifest.EXPECTED_PRODUCTION_TARGET
        .projectId,

    RAILWAY_PROJECT_NAME:
      manifest.EXPECTED_PRODUCTION_TARGET
        .projectName,

    RAILWAY_ENVIRONMENT_ID:
      manifest.EXPECTED_PRODUCTION_TARGET
        .environmentId,

    RAILWAY_ENVIRONMENT_NAME:
      manifest.EXPECTED_PRODUCTION_TARGET
        .environmentName,

    RAILWAY_SERVICE_ID:
      manifest.EXPECTED_PRODUCTION_TARGET
        .databaseServiceId,

    RAILWAY_SERVICE_NAME:
      manifest.EXPECTED_PRODUCTION_TARGET
        .databaseServiceName,

    EXPECTED_PRESTATE_SERVER_SHA:
      manifest.PRODUCTION_PRESTATE.serverSha,

    EXPECTED_PRESTATE_IMAGE_DIGEST:
      manifest.PRODUCTION_PRESTATE.imageDigest,

    EXPECTED_PRESTATE_DEPLOYMENT_ID:
      manifest
        .CERTIFIED_PRE_MAINTENANCE_DEPLOYMENT_ID,

    ACTUAL_PRE_MAINTENANCE_DEPLOYMENT_ID:
      manifest
        .CERTIFIED_PRE_MAINTENANCE_DEPLOYMENT_ID,

    EXPECTED_PRESTATE_FINGERPRINT:
      manifest.PRESTATE_FINGERPRINT,

    EXPECTED_PRESTATE_LEDGER_FINGERPRINT:
      manifest.PRESTATE_LEDGER_FINGERPRINT,

    EXPECTED_POST_LEDGER_FINGERPRINT:
      manifest.EXPECTED_POST_LEDGER_FINGERPRINT,

    CONFIRM_PRODUCTION_TARGET:
      `${manifest.EXPECTED_PRODUCTION_TARGET.projectName}/production/Postgres/railway`,

    PRODUCTION_CONVERGENCE_ID:
      manifest.CONVERGENCE_ID,
  };
}

function maintenanceFixture() {
  const preDeployment =
    manifest
      .CERTIFIED_PRE_MAINTENANCE_DEPLOYMENT_ID;

  const bridgeDeployment =
    "11111111-1111-4111-8111-111111111111";

  const bridgeDigest =
    "sha256:" + "b".repeat(64);

  const configurationFingerprint =
    "a".repeat(64);

  const proof = {
    proofVersion:
      PROOF_VERSION,

    maintenanceMechanism:
      MAINTENANCE_MECHANISM,

    projectId:
      manifest.EXPECTED_PRODUCTION_TARGET
        .projectId,

    environmentId:
      manifest.EXPECTED_PRODUCTION_TARGET
        .environmentId,

    serviceId:
      manifest.EXPECTED_PRODUCTION_TARGET
        .backendServiceId,

    preMaintenanceDeploymentId:
      preDeployment,

    preMaintenanceServerSha:
      manifest.PRODUCTION_PRESTATE.serverSha,

    preMaintenanceImageDigest:
      manifest.PRODUCTION_PRESTATE.imageDigest,

    preMaintenanceDeploymentStatus:
      "SUCCESS",

    preMaintenanceDeploymentCurrent:
      true,

    preMaintenanceDeploymentInactiveAfterBridge:
      true,

    preMaintenanceDeploymentVerifiedAtUtc:
      "2026-09-18T12:00:00Z",

    preMaintenanceHealthVerified:
      true,

    preMaintenanceHealthStatus:
      200,

    preMaintenanceGitSource:
      null,

    preMaintenanceRegion:
      manifest.EXPECTED_PRODUCTION_RUNTIME
        .region,

    preMaintenanceReplicaCount:
      manifest.EXPECTED_PRODUCTION_RUNTIME
        .replicaCount,

    preMaintenanceDomain:
      manifest.EXPECTED_PRODUCTION_RUNTIME
        .domain,

    preMaintenancePort:
      manifest.EXPECTED_PRODUCTION_RUNTIME
        .port,

    preMaintenanceDatabaseAttachment:
      manifest.EXPECTED_PRODUCTION_RUNTIME
        .databaseAttachment,

    preMaintenanceHealthcheckPath:
      manifest.EXPECTED_PRODUCTION_RUNTIME
        .healthcheckPath,

    preMaintenanceHealthcheckTimeoutSeconds:
      manifest.EXPECTED_PRODUCTION_RUNTIME
        .healthcheckTimeoutSeconds,

    bridgeDeploymentId:
      bridgeDeployment,

    bridgeImageDigest:
      bridgeDigest,

    bridgeVersion:
      "maintenance-bridge-v1",

    bridgeCurrent:
      true,

    bridgeBecameCurrentAtUtc:
      "2026-09-18T12:01:00Z",

    oldDeploymentInactiveAtUtc:
      "2026-09-18T12:02:00Z",

    maintenanceVerifiedAtUtc:
      "2026-09-18T12:03:00Z",

    healthMarkerVerified:
      true,

    trafficProbeCount:
      8,

    trafficProbeStatus:
      503,

    oldApplicationInactive:
      true,

    databaseReachabilityVerified:
      true,

    configurationFingerprintBefore:
      configurationFingerprint,

    configurationFingerprintMaintenance:
      configurationFingerprint,

    allowedConfigurationDelta:
      [...ALLOWED_CONFIGURATION_DELTA],

    ownerEligibilityFingerprint:
      manifest.OWNER_BACKFILL_ELIGIBILITY
        .eligibilityFingerprint,

    databasePrestateLedgerRows:
      manifest.EXPECTED_PRE_LEDGER_ROWS,

    databasePrestateLedgerFingerprint:
      manifest.PRESTATE_LEDGER_FINGERPRINT,

    databasePrestateCatalogFingerprint:
      manifest.PRESTATE_CATALOG_FINGERPRINT,

    databasePrestateFingerprint:
      manifest.PRESTATE_FINGERPRINT,

    proofFreshnessExpiresAtUtc:
      "2026-09-18T12:08:00Z",
  };

  return {
    proof,
    proofDigest:
      proofSha256(proof),
    preDeployment,
    bridgeDeployment,
    bridgeDigest,
  };
}

function fakeClient() {
  const queries = [];

  return {
    queries,

    async query(sql, values) {
      queries.push({
        sql: String(sql),
        values,
      });

      return {
        rows: [],
      };
    },
  };
}

test(
  "005 manifest freezes the exact 75-to-99 full-filename ledger contract",
  () => {
    assert.equal(
      validateManifest(),
      true
    );

    assert.equal(
      manifest.CURRENT_PRODUCTION_LEDGER.length,
      75
    );

    assert.equal(
      manifest.TARGET_MIGRATIONS.length,
      24
    );

    assert.equal(
      expectedPostLedger().length,
      99
    );

    assert.equal(
      manifest.PRESTATE_LEDGER_FINGERPRINT,
      "7ee78065b5ca5a6f40c14342e289b8f2135995f8f4ff16a39656ae4b2dcf3e0b"
    );

    assert.equal(
      manifest.EXPECTED_POST_LEDGER_FINGERPRINT,
      "327cab9fbaa6af56a084b75b04938228653ebe28deea795bf6d1c39e0ee15434"
    );

    assert.equal(
      manifest.PRESTATE_FINGERPRINT,
      "151d8a31ad8fb305cfdf8dd1965a51397791bb70f5e51de31c32a22779819575"
    );

    const names =
      expectedPostLedger()
        .map(entry => entry.filename);

    assert.equal(
      names.includes(
        manifest.ARCHIVE_MIGRATION.filename
      ),
      true
    );

    assert.equal(
      names.includes(
        manifest.VARIANT_FILENAME
      ),
      true
    );

    assert.equal(
      names.includes(
        manifest.CANONICAL_TEAM_FILENAME
      ),
      false
    );

    assert.equal(
      names.includes(
        manifest.BASELINE_FILENAME
      ),
      false
    );
  }
);

test(
  "all 24 target assets load by exact checksum and are transaction compatible",
  () => {
    const migrations =
      loadTargetMigrations();

    assert.equal(
      migrations.length,
      24
    );

    assert.equal(
      migrations[0].filename,
      "202609020001_add_business_origin_commercial_job_foundation.sql"
    );

    assert.equal(
      migrations.at(-1).filename,
      "202609160015_generalize_invoice_job_origins.sql"
    );

    assert.ok(
      migrations.every(
        ({ sql }) =>
          !/CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY/i
            .test(sql)
      )
    );
  }
);

test(
  "READY, ALREADY_APPLIED, and partial states are exact",
  () => {
    const pre =
      preSnapshot();

    const post =
      postSnapshot();

    assert.equal(
      classifySnapshot(pre),
      "READY"
    );

    assert.equal(
      assertPreflightSnapshot(pre),
      "READY"
    );

    assert.equal(
      classifySnapshot(post),
      "ALREADY_APPLIED"
    );

    assert.equal(
      assertPostflightSnapshot(post),
      "ALREADY_APPLIED"
    );

    const partial =
      preSnapshot();

    partial.ledger.push(
      expectedPostLedger().at(-1)
    );

    assert.equal(
      classifySnapshot(partial),
      "BLOCKED"
    );
  }
);

test(
  "prestate catalog, preservation, owner, and operational drift fail closed",
  () => {
    const mutations = [
      snapshot => {
        snapshot.catalog.tables.count += 1;
        snapshot.catalogFingerprint =
          objectFingerprint(
            snapshot.catalog
          );
      },

      snapshot => {
        snapshot.preservation.posts.count += 1;
      },

      snapshot => {
        snapshot.ownerBackfillEligibility
          .eligibleProfileCount -= 1;
      },

      snapshot => {
        snapshot.ownerMembership.owners += 1;
      },

      snapshot => {
        snapshot.operationalCounts.jobs = 1;
      },
    ];

    for (const mutate of mutations) {
      const snapshot =
        preSnapshot();

      mutate(snapshot);

      snapshot.prestateFingerprint =
        prestateFingerprint(
          snapshot,
          {
            postgresVersionPrefix:
              "18.6",
          }
        );

      assert.throws(
        () =>
          assertPreflightSnapshot(
            snapshot
          ),
        {
          code:
            "PREFLIGHT_BLOCKED",
        }
      );
    }
  }
);

test(
  "postflight requires the exact certified successor catalog",
  () => {
    const snapshot =
      postSnapshot();

    assert.equal(
      assertPostflightSnapshot(snapshot),
      "ALREADY_APPLIED"
    );

    snapshot.catalog.functions.count += 1;

    snapshot.catalogFingerprint =
      objectFingerprint(
        snapshot.catalog
      );

    assert.throws(
      () =>
        assertPostflightSnapshot(
          snapshot
        ),
      {
        code:
          "POSTFLIGHT_BLOCKED",
      }
    );
  }
);

test(
  "authorization binds exact production identity and all execution proofs",
  () => {
    const base =
      baseEnvironment();

    assert.equal(
      inspectAuthorization(base)
        .authorized,
      true
    );

    const {
      proofDigest,
      bridgeDeployment,
      bridgeDigest,
    } =
      maintenanceFixture();

    const execute = {
      ...base,

      CERTIFIED_BACKUP_REFERENCE:
        "synthetic-backup",

      CERTIFIED_BACKUP_SHA256:
        "c".repeat(64),

      RESTORE_CERTIFICATION_REFERENCE:
        "synthetic-restore",

      MAINTENANCE_BRIDGE_PROOF_PATH:
        "/tmp/synthetic-proof.json",

      MAINTENANCE_BRIDGE_PROOF_SHA256:
        proofDigest,

      EXPECTED_MAINTENANCE_BRIDGE_IMAGE_DIGEST:
        bridgeDigest,

      CURRENT_MAINTENANCE_BRIDGE_DEPLOYMENT_ID:
        bridgeDeployment,

      CURRENT_MAINTENANCE_BRIDGE_IMAGE_DIGEST:
        bridgeDigest,

      CURRENT_MAINTENANCE_BRIDGE_CURRENT:
        "true",

      CONFIRM_PRODUCTION_CONVERGENCE:
        "EXECUTE_MC_PRODUCTION_CONVERGENCE_005",
    };

    assert.equal(
      inspectAuthorization(
        execute,
        { execute: true }
      ).authorized,
      true
    );

    for (const key of [
      "EXPECTED_PRESTATE_SERVER_SHA",
      "EXPECTED_PRESTATE_IMAGE_DIGEST",
      "EXPECTED_PRESTATE_DEPLOYMENT_ID",
      "ACTUAL_PRE_MAINTENANCE_DEPLOYMENT_ID",
      "EXPECTED_PRESTATE_FINGERPRINT",
      "EXPECTED_PRESTATE_LEDGER_FINGERPRINT",
      "EXPECTED_POST_LEDGER_FINGERPRINT",
      "CERTIFIED_BACKUP_REFERENCE",
      "CERTIFIED_BACKUP_SHA256",
      "RESTORE_CERTIFICATION_REFERENCE",
      "MAINTENANCE_BRIDGE_PROOF_PATH",
      "MAINTENANCE_BRIDGE_PROOF_SHA256",
      "EXPECTED_MAINTENANCE_BRIDGE_IMAGE_DIGEST",
      "CURRENT_MAINTENANCE_BRIDGE_DEPLOYMENT_ID",
      "CURRENT_MAINTENANCE_BRIDGE_IMAGE_DIGEST",
      "CURRENT_MAINTENANCE_BRIDGE_CURRENT",
      "CONFIRM_PRODUCTION_CONVERGENCE",
    ]) {
      const bad = {
        ...execute,
      };

      delete bad[key];

      assert.equal(
        inspectAuthorization(
          bad,
          { execute: true }
        ).authorized,
        false,
        key
      );
    }
  }
);

test(
  "maintenance proof binds the exact 75-row database prestate and expires fail closed",
  () => {
    const fixture =
      maintenanceFixture();

    assert.equal(
      validateMaintenanceProof(
        fixture.proof,
        {
          expectedProofSha256:
            fixture.proofDigest,

          expectedBridgeImageDigest:
            fixture.bridgeDigest,

          actualPreMaintenanceDeploymentId:
            fixture.preDeployment,

          currentBridgeDeploymentId:
            fixture.bridgeDeployment,

          currentBridgeImageDigest:
            fixture.bridgeDigest,

          currentBridgeCurrent:
            true,

          now:
            new Date(
              "2026-09-18T12:04:00Z"
            ),
        }
      ).status,
      "MAINTENANCE_PROOF_VERIFIED"
    );

    const wrongPrestate = {
      ...fixture.proof,

      databasePrestateFingerprint:
        "d".repeat(64),
    };

    assert.throws(
      () =>
        validateMaintenanceProof(
          wrongPrestate,
          {
            expectedProofSha256:
              proofSha256(
                wrongPrestate
              ),

            expectedBridgeImageDigest:
              fixture.bridgeDigest,

            actualPreMaintenanceDeploymentId:
              fixture.preDeployment,

            currentBridgeDeploymentId:
              fixture.bridgeDeployment,

            currentBridgeImageDigest:
              fixture.bridgeDigest,

            currentBridgeCurrent:
              true,

            now:
              new Date(
                "2026-09-18T12:04:00Z"
              ),
          }
        ),
      {
        code:
          "MAINTENANCE_PROOF_BLOCKED",
      }
    );

    assert.throws(
      () =>
        validateMaintenanceProof(
          fixture.proof,
          {
            expectedProofSha256:
              fixture.proofDigest,

            expectedBridgeImageDigest:
              fixture.bridgeDigest,

            actualPreMaintenanceDeploymentId:
              fixture.preDeployment,

            currentBridgeDeploymentId:
              fixture.bridgeDeployment,

            currentBridgeImageDigest:
              fixture.bridgeDigest,

            currentBridgeCurrent:
              true,

            now:
              new Date(
                "2026-09-18T12:09:00Z"
              ),
          }
        ),
      {
        code:
          "MAINTENANCE_PROOF_BLOCKED",
      }
    );
  }
);

test(
  "runner has no default execution and describe exposes only the 005 contract",
  async () => {
    assert.equal(
      parseMode([]),
      null
    );

    assert.equal(
      parseMode([
        "--describe",
        "--execute",
      ]),
      null
    );

    const blocked = [];

    assert.equal(
      await run({
        argv: [],
        env: {},
        output:
          line =>
            blocked.push(line),
      }),
      2
    );

    assert.match(
      blocked[0],
      /"status":"BLOCKED"/
    );

    const output = [];

    assert.equal(
      await run({
        argv: ["--describe"],
        env: {},
        output:
          line =>
            output.push(line),
      }),
      0
    );

    const described =
      JSON.parse(output[0]);

    assert.equal(
      described.convergenceId,
      "MC-PRODUCTION-CONVERGENCE-005"
    );

    assert.equal(
      described.prestateLedgerRows,
      75
    );

    assert.equal(
      described.targetMigrationCount,
      24
    );

    assert.equal(
      described.expectedPostLedgerRows,
      99
    );

    assert.equal(
      described.prestateFingerprint,
      manifest.PRESTATE_FINGERPRINT
    );

    assert.equal(
      described.expectedPostLedgerFingerprint,
      manifest.EXPECTED_POST_LEDGER_FINGERPRINT
    );
  }
);

test(
  "executeConvergence applies exactly 24 ledgered migrations, rolls back failures, and replays with zero mutation",
  async () => {
    const migrations =
      loadTargetMigrations();

    const successClient =
      fakeClient();

    const sequence = [
      preSnapshot(),
      preSnapshot(),
      postSnapshot(),
    ];

    let sequenceIndex = 0;

    const success =
      await executeConvergence({
        client:
          successClient,

        migrations,

        readSnapshotFn:
          async () =>
            structuredClone(
              sequence[
                sequenceIndex++
              ]
            ),
      });

    assert.deepEqual(
      success,
      {
        state:
          "ALREADY_APPLIED",
        applied:
          24,
      }
    );

    const ledgerWrites =
      successClient.queries
        .filter(
          ({ sql }) =>
            /INSERT INTO schema_migrations/i
              .test(sql)
        );

    assert.equal(
      ledgerWrites.length,
      24
    );

    assert.ok(
      ledgerWrites.every(
        ({ values }) =>
          values?.[2] ===
          manifest.EXECUTION_TARGET
      )
    );

    assert.ok(
      successClient.queries.some(
        ({ sql }) =>
          sql === "COMMIT"
      )
    );

    const failureClient =
      fakeClient();

    await assert.rejects(
      executeConvergence({
        client:
          failureClient,

        migrations,

        injectFailureAt:
          12,

        readSnapshotFn:
          async () =>
            preSnapshot(),
      }),
      {
        code:
          "INJECTED_MIGRATION_FAILURE",
      }
    );

    assert.equal(
      failureClient
        .queries
        .at(-1)
        .sql,
      "ROLLBACK"
    );

    assert.equal(
      failureClient.queries.some(
        ({ sql }) =>
          sql === "COMMIT"
      ),
      false
    );

    const replayClient =
      fakeClient();

    const replay =
      await executeConvergence({
        client:
          replayClient,

        migrations,

        readSnapshotFn:
          async () =>
            postSnapshot(),
      });

    assert.deepEqual(
      replay,
      {
        state:
          "ALREADY_APPLIED",
        applied:
          0,
      }
    );

    assert.equal(
      replayClient.queries.some(
        ({ sql }) =>
          /INSERT INTO schema_migrations/i
            .test(sql)
      ),
      false
    );
  }
);
