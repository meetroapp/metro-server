#!/usr/bin/env node
"use strict";

const { Pool } = require("pg");

const {
  ADVISORY_LOCK_ID,
  CERTIFIED_PRE_MAINTENANCE_DEPLOYMENT_ID,
  CONVERGENCE_ID,
  EXECUTION_TARGET,
  EXPECTED_POST_LEDGER_FINGERPRINT,
  EXPECTED_POST_LEDGER_ROWS,
  EXPECTED_PRE_LEDGER_ROWS,
  PRESTATE_CATALOG_FINGERPRINT,
  PRESTATE_FINGERPRINT,
  PRESTATE_LEDGER_FINGERPRINT,
  PRODUCTION_PRESTATE,
  TARGET_MIGRATIONS,
} = require(
  "../production-convergence/005/manifest"
);

const {
  assertPostflightSnapshot,
  assertPreflightSnapshot,
  blocked,
  classifySnapshot,
  extractTargetMarkers,
  inspectAuthorization,
  loadTargetMigrations,
} = require(
  "../production-convergence/005/assertions"
);

const {
  readSnapshot,
} = require(
  "../production-convergence/005/snapshot"
);

const {
  BRIDGE_VERSION,
  MAINTENANCE_MECHANISM,
  PROOF_FRESHNESS_MS,
  loadMaintenanceProof,
} = require(
  "../production-convergence/005/maintenanceProof"
);

const MODES = new Set([
  "--describe",
  "--preflight",
  "--execute",
  "--postflight",
]);

function usage() {
  return [
    "Usage:",
    "node scripts/run-production-convergence-005.js",
    "--describe|--preflight|--execute|--postflight",
  ].join(" ");
}

function parseMode(argv) {
  const supplied =
    argv.filter(
      (argument) =>
        MODES.has(argument)
    );

  if (
    supplied.length !== 1 ||
    argv.length !== 1
  ) {
    return null;
  }

  return supplied[0];
}

function parseDatabaseUrl(value) {
  try {
    const parsed =
      new URL(value);

    return {
      ok:
        [
          "postgres:",
          "postgresql:",
        ].includes(parsed.protocol),

      database:
        decodeURIComponent(
          parsed.pathname.replace(
            /^\/+/,
            ""
          )
        ),

      host:
        parsed.hostname.toLowerCase(),
    };
  } catch {
    return {
      ok: false,
      database: "",
      host: "",
    };
  }
}

function assertDatabaseTarget(env) {
  const value =
    env.DATABASE_PUBLIC_URL ||
    env.DATABASE_URL ||
    "";

  const parsed =
    parseDatabaseUrl(value);

  const railwayHost =
    parsed.host.endsWith(
      ".railway.internal"
    ) ||
    parsed.host.endsWith(
      ".proxy.rlwy.net"
    ) ||
    parsed.host.endsWith(
      "proxy.rlwy.net"
    );

  if (
    !parsed.ok ||
    parsed.database !== "railway" ||
    !railwayHost
  ) {
    throw blocked(
      "DATABASE_TARGET_BLOCKED"
    );
  }

  return value;
}

async function inspectReadOnly(
  client,
  markers,
  options
) {
  await client.query(
    "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"
  );

  try {
    const snapshot =
      await readSnapshot(
        client,
        markers,
        options
      );

    await client.query("ROLLBACK");

    return snapshot;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function executeConvergence({
  client,

  migrations =
    loadTargetMigrations(),

  expectedPrestate =
    PRODUCTION_PRESTATE,

  injectFailureAt = null,

  injectPostconditionFailure =
    false,

  readSnapshotFn =
    readSnapshot,
} = {}) {
  const markers =
    extractTargetMarkers(
      migrations
    );

  const inspect =
    async (options) => {
      await client.query(
        "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"
      );

      try {
        const snapshot =
          await readSnapshotFn(
            client,
            markers,
            options
          );

        await client.query(
          "ROLLBACK"
        );

        return snapshot;
      } catch (error) {
        await client.query(
          "ROLLBACK"
        );

        throw error;
      }
    };

  const initial =
    await inspect({
      postconditions: true,
    });

  const initialState =
    classifySnapshot(initial);

  if (
    initialState ===
    "ALREADY_APPLIED"
  ) {
    assertPostflightSnapshot(
      initial,
      expectedPrestate
    );

    return Object.freeze({
      state: "ALREADY_APPLIED",
      applied: 0,
    });
  }

  if (
    initialState !== "READY"
  ) {
    throw blocked(
      "REPLAY_STATE_BLOCKED",
      [initialState]
    );
  }

  assertPreflightSnapshot(
    initial,
    expectedPrestate
  );

  let started = false;

  try {
    await client.query("BEGIN");
    started = true;

    await client.query(
      "SET LOCAL lock_timeout = '5s'"
    );

    await client.query(
      "SET LOCAL statement_timeout = '15min'"
    );

    await client.query(
      "SELECT pg_advisory_xact_lock($1)",
      [ADVISORY_LOCK_ID]
    );

    await client.query(
      "LOCK TABLE schema_migrations IN SHARE ROW EXCLUSIVE MODE"
    );

    const locked =
      await readSnapshotFn(
        client,
        markers,
        {
          postconditions: true,
        }
      );

    if (
      classifySnapshot(locked) !==
      "READY"
    ) {
      throw blocked(
        "LOCKED_PRESTATE_CHANGED"
      );
    }

    assertPreflightSnapshot(
      locked,
      expectedPrestate
    );

    for (
      const migration
      of migrations
    ) {
      if (
        injectFailureAt ===
        migration.order
      ) {
        throw blocked(
          "INJECTED_MIGRATION_FAILURE"
        );
      }

      await client.query(
        migration.sql
      );

      await client.query(
        `INSERT INTO schema_migrations
           (filename, checksum, execution_target)
         VALUES ($1, $2, $3)`,
        [
          migration.filename,
          migration.checksum,
          EXECUTION_TARGET,
        ]
      );
    }

    const poststate =
      await readSnapshotFn(
        client,
        markers,
        {
          postconditions: true,
        }
      );

    if (
      injectPostconditionFailure
    ) {
      poststate
        .operationalCounts
        .__injected = 1;
    }

    assertPostflightSnapshot(
      poststate,
      expectedPrestate
    );

    await client.query(
      "COMMIT"
    );

    started = false;

    return Object.freeze({
      state: "ALREADY_APPLIED",
      applied:
        migrations.length,
    });
  } catch (error) {
    if (started) {
      await client.query(
        "ROLLBACK"
      );
    }

    throw error;
  }
}

async function run({
  argv =
    process.argv.slice(2),

  env =
    process.env,

  output =
    console.log,
} = {}) {
  const mode =
    parseMode(argv);

  if (!mode) {
    output(
      JSON.stringify({
        status: "BLOCKED",
        usage: usage(),
      })
    );

    return 2;
  }

  const migrations =
    loadTargetMigrations();

  const markers =
    extractTargetMarkers(
      migrations
    );

  if (
    mode === "--describe"
  ) {
    output(
      JSON.stringify({
        status:
          "DESCRIBED",

        convergenceId:
          CONVERGENCE_ID,

        prestateDeploymentId:
          CERTIFIED_PRE_MAINTENANCE_DEPLOYMENT_ID,

        prestateServerSha:
          PRODUCTION_PRESTATE.serverSha,

        prestateImageDigest:
          PRODUCTION_PRESTATE.imageDigest,

        prestateLedgerRows:
          EXPECTED_PRE_LEDGER_ROWS,

        prestateLedgerFingerprint:
          PRESTATE_LEDGER_FINGERPRINT,

        prestateCatalogFingerprint:
          PRESTATE_CATALOG_FINGERPRINT,

        prestateFingerprint:
          PRESTATE_FINGERPRINT,

        targetMigrationCount:
          TARGET_MIGRATIONS.length,

        expectedPostLedgerRows:
          EXPECTED_POST_LEDGER_ROWS,

        expectedPostLedgerFingerprint:
          EXPECTED_POST_LEDGER_FINGERPRINT,

        actualPreMaintenanceDeploymentIdEnvironment:
          "ACTUAL_PRE_MAINTENANCE_DEPLOYMENT_ID",

        maintenanceMechanism:
          MAINTENANCE_MECHANISM,

        maintenanceBridgeVersion:
          BRIDGE_VERSION,

        maintenanceProofVersion:
          3,

        maintenanceProofFreshnessSeconds:
          PROOF_FRESHNESS_MS / 1000,

        transactionCompatible:
          true,
      })
    );

    return 0;
  }

  const authorization =
    inspectAuthorization(
      env,
      {
        execute:
          mode === "--execute",
      }
    );

  if (
    !authorization.authorized
  ) {
    throw blocked(
      "AUTHORIZATION_BLOCKED",
      authorization.reasons
    );
  }

  if (
    mode === "--execute"
  ) {
    loadMaintenanceProof(env);
  }

  const databaseUrl =
    assertDatabaseTarget(env);

  const pool =
    new Pool({
      connectionString:
        databaseUrl,

      max: 1,

      connectionTimeoutMillis:
        5000,
    });

  const client =
    await pool.connect();

  try {
    if (
      mode === "--execute"
    ) {
      const result =
        await executeConvergence({
          client,
          migrations,
        });

      output(
        JSON.stringify({
          status:
            result.state,

          applied:
            result.applied,

          expectedPostLedgerRows:
            EXPECTED_POST_LEDGER_ROWS,

          expectedPostLedgerFingerprint:
            EXPECTED_POST_LEDGER_FINGERPRINT,
        })
      );

      return 0;
    }

    const snapshot =
      await inspectReadOnly(
        client,
        markers,
        {
          postconditions: true,
        }
      );

    const state =
      classifySnapshot(
        snapshot
      );

    if (
      mode === "--preflight"
    ) {
      if (
        state === "READY"
      ) {
        assertPreflightSnapshot(
          snapshot
        );
      } else if (
        state ===
        "ALREADY_APPLIED"
      ) {
        assertPostflightSnapshot(
          snapshot
        );
      } else {
        throw blocked(
          "PREFLIGHT_BLOCKED",
          [state]
        );
      }
    } else {
      if (
        state !==
        "ALREADY_APPLIED"
      ) {
        throw blocked(
          "POSTFLIGHT_BLOCKED",
          [state]
        );
      }

      assertPostflightSnapshot(
        snapshot
      );
    }

    output(
      JSON.stringify({
        status:
          state,

        ledgerRows:
          snapshot.ledger.length,

        ledgerFingerprint:
          snapshot.ledgerFingerprint,

        targetMarkers:
          snapshot.targetMarkers,
      })
    );

    return 0;
  } finally {
    client.release();
    await pool.end();
  }
}

if (
  require.main === module
) {
  run().then(
    (code) => {
      process.exitCode =
        code;
    },

    (error) => {
      console.error(
        JSON.stringify({
          status:
            "BLOCKED",

          code:
            error.code ||
            "CONVERGENCE_FAILED",

          details:
            error.details ||
            [],
        })
      );

      process.exitCode = 1;
    }
  );
}

module.exports = Object.freeze({
  assertDatabaseTarget,
  executeConvergence,
  inspectReadOnly,
  parseDatabaseUrl,
  parseMode,
  run,
  usage,
});
