#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");

const EXPECTED_PROJECT = "profound-magic";
const EXPECTED_ENVIRONMENT = "production";
const EXPECTED_SERVICE =
  "athletic-rebirth";
const REQUIRED_CONFIRMATION = "YES";

const MIGRATIONS_DIRECTORY = path.join(
  __dirname,
  "..",
  "migrations"
);

const EMERGENCY_MIGRATIONS = Object.freeze([
  {
    filename:
      "202607230001_create_emergency_requests.sql",
    checksum:
      "29fc9b8cbf68e63daf01f6103e42b982492add0ae4c745d3a643251d9a9eaf7b",
  },
  {
    filename:
      "202607230002_add_emergency_relationship_source.sql",
    checksum:
      "d5ffe1e34b61087afb58905d116c7fe04ed1262b699905f081efc8abd3b5b7a0",
  },
  {
    filename:
      "202607230003_create_emergency_safety_assessments.sql",
    checksum:
      "f02ddb70a1c50914fc0acaf2ffe5f4f434a4b8e1db910bea20b44e28d1706e23",
  },
  {
    filename:
      "202607240001_add_single_active_emergency_relationship.sql",
    checksum:
      "5d824b8c31722dcd6a9debd49b28687f16b93b1efd4f71b65bb8eb89fff2fa80",
  },
  {
    filename:
      "202607250001_add_emergency_dispatch_lifecycle.sql",
    checksum:
      "aa39d8311f8a73970e20069dad8fd1e4a4bfa0b65acc7e09cffaa0e33be21462",
  },
]);

const EXPECTED_DISPATCH_COLUMNS = Object.freeze([
  "en_route_at",
  "arrived_at",
  "work_started_at",
  "completed_at",
]);

const EXPECTED_EMERGENCY_STATUSES =
  Object.freeze([
    "draft",
    "ready_for_distribution",
    "active",
    "selection_pending",
    "assigned",
    "in_service",
    "resolved",
    "cancelled",
    "expired",
    "unable_to_match",
    "safety_blocked",
    "professional_en_route",
    "professional_arrived",
    "work_in_progress",
    "completed",
  ]);

const INSPECTION_SQL = Object.freeze({
  begin:
    "BEGIN TRANSACTION READ ONLY",
  rollback:
    "ROLLBACK",
  databaseIdentity:
    "SELECT current_database() AS database_name",
  ledgerExists: `
    SELECT
      to_regclass(
        'public.schema_migrations'
      ) IS NOT NULL AS exists
  `,
  ledgerRows: `
    SELECT
      filename,
      checksum,
      execution_target,
      applied_at
    FROM schema_migrations
    ORDER BY filename
  `,
  emergencyTableExists: `
    SELECT
      to_regclass(
        'public.emergency_requests'
      ) IS NOT NULL AS exists
  `,
  emergencyColumns: `
    SELECT
      column_name,
      data_type,
      is_nullable,
      column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'emergency_requests'
    ORDER BY ordinal_position
  `,
  emergencyConstraints: `
    SELECT
      tc.constraint_name,
      tc.constraint_type,
      pg_get_constraintdef(
        pc.oid
      ) AS constraint_definition
    FROM information_schema.table_constraints tc
    INNER JOIN pg_catalog.pg_constraint pc
      ON pc.conname = tc.constraint_name
    INNER JOIN pg_catalog.pg_class rel
      ON rel.oid = pc.conrelid
    INNER JOIN pg_catalog.pg_namespace ns
      ON ns.oid = rel.relnamespace
    WHERE tc.table_schema = 'public'
      AND tc.table_name = 'emergency_requests'
      AND ns.nspname = 'public'
    ORDER BY tc.constraint_name
  `,
  emergencyIndexes: `
    SELECT
      indexname AS index_name,
      indexdef AS index_definition
    FROM pg_catalog.pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'emergency_requests'
    ORDER BY indexname
  `,
  safetyTableExists: `
    SELECT
      to_regclass(
        'public.emergency_safety_assessments'
      ) IS NOT NULL AS exists
  `,
  safetyColumns: `
    SELECT
      column_name,
      data_type,
      is_nullable,
      column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name =
        'emergency_safety_assessments'
    ORDER BY ordinal_position
  `,
  relationshipColumns: `
    SELECT
      column_name,
      data_type,
      is_nullable,
      column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name =
        'request_relationships'
    ORDER BY ordinal_position
  `,
  relationshipConstraints: `
    SELECT
      tc.constraint_name,
      tc.constraint_type,
      pg_get_constraintdef(
        pc.oid
      ) AS constraint_definition
    FROM information_schema.table_constraints tc
    INNER JOIN pg_catalog.pg_constraint pc
      ON pc.conname = tc.constraint_name
    INNER JOIN pg_catalog.pg_class rel
      ON rel.oid = pc.conrelid
    INNER JOIN pg_catalog.pg_namespace ns
      ON ns.oid = rel.relnamespace
    WHERE tc.table_schema = 'public'
      AND tc.table_name =
        'request_relationships'
      AND ns.nspname = 'public'
    ORDER BY tc.constraint_name
  `,
  relationshipIndexes: `
    SELECT
      indexname AS index_name,
      indexdef AS index_definition
    FROM pg_catalog.pg_indexes
    WHERE schemaname = 'public'
      AND tablename =
        'request_relationships'
    ORDER BY indexname
  `,
  conversationTableExists: `
    SELECT
      to_regclass(
        'public.conversations'
      ) IS NOT NULL AS exists
  `,
  statusCounts: `
    SELECT
      status,
      COUNT(*)::bigint AS count
    FROM emergency_requests
    GROUP BY status
    ORDER BY status
  `,
});

class InspectionFailure extends Error {
  constructor(code) {
    super(code);
    this.name = "InspectionFailure";
    this.code = code;
  }
}

function sha256(value) {
  return crypto
    .createHash("sha256")
    .update(value)
    .digest("hex");
}

function parseDatabaseUrl(value) {
  try {
    const parsed =
      new URL(String(value || ""));

    if (
      ![
        "postgres:",
        "postgresql:",
      ].includes(parsed.protocol)
    ) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

function databaseNameFromUrl(parsed) {
  if (!parsed) return "";

  return decodeURIComponent(
    parsed.pathname.replace(/^\/+/, "")
  );
}

function hostType(hostname) {
  const host =
    String(hostname || "").toLowerCase();

  if (
    host.endsWith(
      ".railway.internal"
    )
  ) {
    return "railway-private";
  }

  if (
    host.endsWith(
      ".proxy.rlwy.net"
    )
  ) {
    return "railway-proxy";
  }

  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]"
  ) {
    return "local";
  }

  return "unknown";
}

function hasStagingMarker(value) {
  return /(^|[^a-z])staging([^a-z]|$)/i.test(
    String(value || "")
  );
}

function hasProductionMarker(value) {
  return /(^|[^a-z])(prod|production)([^a-z]|$)/i.test(
    String(value || "")
  );
}

function safeIdentity(value, expected) {
  const text =
    String(value || "");

  if (text === expected) {
    return expected;
  }

  if (!text) {
    return "unknown";
  }

  if (hasStagingMarker(text)) {
    return "staging-like";
  }

  if (hasProductionMarker(text)) {
    return "production-like";
  }

  return "unrecognized";
}

function classifyInspectionTarget(env = {}) {
  const parsed =
    parseDatabaseUrl(env.DATABASE_URL);

  if (!parsed) {
    return "invalid";
  }

  const targetText = [
    env.RAILWAY_PROJECT_NAME,
    env.RAILWAY_ENVIRONMENT_NAME,
    env.RAILWAY_SERVICE_NAME,
    parsed.hostname,
    databaseNameFromUrl(parsed),
  ].join(" ");

  if (hasStagingMarker(targetText)) {
    return "rejected-staging";
  }

  const type =
    hostType(parsed.hostname);

  if (type === "local") {
    return "rejected-local";
  }

  if (type === "unknown") {
    return "rejected-unknown";
  }

  if (
    env.NODE_ENV !==
      EXPECTED_ENVIRONMENT ||
    env.RAILWAY_PROJECT_NAME !==
      EXPECTED_PROJECT ||
    env.RAILWAY_ENVIRONMENT_NAME !==
      EXPECTED_ENVIRONMENT ||
    env.RAILWAY_SERVICE_NAME !==
      EXPECTED_SERVICE ||
    env
      .CONFIRM_PRODUCTION_EMERGENCY_INSPECTION !==
      REQUIRED_CONFIRMATION
  ) {
    return "rejected-unknown";
  }

  if (
    !hasProductionMarker(
      [
        env.RAILWAY_ENVIRONMENT_NAME,
        env.RAILWAY_SERVICE_NAME,
      ].join(" ")
    )
  ) {
    return "rejected-unknown";
  }

  return "production";
}

function sanitizeTargetMetadata(
  env = {},
  classification =
    classifyInspectionTarget(env)
) {
  const parsed =
    parseDatabaseUrl(env.DATABASE_URL);

  return {
    classification,
    protocol: parsed
      ? parsed.protocol.replace(/:$/, "")
      : "invalid",
    hostType: parsed
      ? hostType(parsed.hostname)
      : "unknown",
    databaseNameClass:
      parsed &&
      hasStagingMarker(
        databaseNameFromUrl(parsed)
      )
        ? "staging-like"
        : parsed
          ? "non-staging"
          : "missing",
    projectName: safeIdentity(
      env.RAILWAY_PROJECT_NAME,
      EXPECTED_PROJECT
    ),
    environmentName: safeIdentity(
      env.RAILWAY_ENVIRONMENT_NAME,
      EXPECTED_ENVIRONMENT
    ),
    serviceName: safeIdentity(
      env.RAILWAY_SERVICE_NAME,
      EXPECTED_SERVICE
    ),
  };
}

function validateInspectionEnvironment(
  env = {}
) {
  const classification =
    classifyInspectionTarget(env);

  let code =
    "INSPECTION_TARGET_NOT_PRODUCTION";

  if (!parseDatabaseUrl(env.DATABASE_URL)) {
    code =
      "INSPECTION_TARGET_INVALID";
  } else if (
    env
      .CONFIRM_PRODUCTION_EMERGENCY_INSPECTION !==
    REQUIRED_CONFIRMATION
  ) {
    code =
      "INSPECTION_CONFIRMATION_REQUIRED";
  }

  return {
    valid:
      classification === "production",
    classification,
    code:
      classification === "production"
        ? "PRODUCTION_INSPECTION_AUTHORIZED"
        : code,
    target: sanitizeTargetMetadata(
      env,
      classification
    ),
  };
}

function loadLocalMigrationChecksums(
  readFile = fs.readFileSync
) {
  return EMERGENCY_MIGRATIONS.map(
    (migration) => {
      const fullPath =
        path.join(
          MIGRATIONS_DIRECTORY,
          migration.filename
        );

      const source =
        readFile(fullPath, "utf8");

      return {
        filename:
          migration.filename,
        approvedChecksum:
          migration.checksum,
        localChecksum:
          sha256(source),
        checksumMatches:
          sha256(source) ===
          migration.checksum,
      };
    }
  );
}

function sanitizeLedgerRows(rows = []) {
  const approved =
    new Set(
      EMERGENCY_MIGRATIONS.map(
        (migration) =>
          migration.filename
      )
    );

  return rows
    .filter((row) =>
      approved.has(row.filename)
    )
    .map((row) => ({
      filename:
        row.filename,
      checksum:
        typeof row.checksum === "string"
          ? row.checksum
          : null,
      executionTarget:
        typeof row.execution_target ===
        "string"
          ? row.execution_target
          : null,
      applied:
        Boolean(row.applied_at),
    }))
    .sort((left, right) =>
      left.filename.localeCompare(
        right.filename
      )
    );
}

function analyzeLedger(
  rows = [],
  localMigrations = []
) {
  const sanitized =
    sanitizeLedgerRows(rows);

  const duplicateFilenames = [];
  const counts = new Map();

  for (const row of sanitized) {
    counts.set(
      row.filename,
      (counts.get(row.filename) || 0) +
        1
    );
  }

  for (
    const [filename, count]
    of counts
  ) {
    if (count > 1) {
      duplicateFilenames.push(
        filename
      );
    }
  }

  const recordedByFilename =
    new Map(
      sanitized.map((row) => [
        row.filename,
        row,
      ])
    );

  const missing = [];
  const checksumDrift = [];

  for (const local of localMigrations) {
    const recorded =
      recordedByFilename.get(
        local.filename
      );

    if (!recorded) {
      missing.push(local.filename);
      continue;
    }

    if (
      recorded.checksum !==
      local.approvedChecksum
    ) {
      checksumDrift.push(
        local.filename
      );
    }
  }

  return {
    exists:
      Array.isArray(rows),
    entries: sanitized,
    missing,
    checksumDrift,
    duplicateFilenames:
      duplicateFilenames.sort(),
    allRecorded:
      missing.length === 0,
    allChecksumsMatch:
      checksumDrift.length === 0,
  };
}

function mapColumns(rows = []) {
  return Object.fromEntries(
    rows
      .filter(
        (row) =>
          typeof row.column_name ===
          "string"
      )
      .map((row) => [
        row.column_name,
        {
          dataType:
            row.data_type || null,
          nullable:
            row.is_nullable || null,
          hasDefault:
            row.column_default != null,
        },
      ])
  );
}

function sanitizeDefinitions(
  rows = [],
  nameField,
  definitionField
) {
  return rows
    .filter(
      (row) =>
        typeof row[nameField] ===
        "string"
    )
    .map((row) => ({
      name:
        row[nameField],
      definition:
        typeof row[
          definitionField
        ] === "string"
          ? row[definitionField]
          : "",
    }))
    .sort((left, right) =>
      left.name.localeCompare(
        right.name
      )
    );
}

function sanitizeStatusCounts(
  rows = []
) {
  return rows
    .filter(
      (row) =>
        typeof row.status === "string"
    )
    .map((row) => ({
      status:
        /^[a-z][a-z0-9_]{0,63}$/.test(
          row.status
        )
          ? row.status
          : "invalid_status_value",
      count:
        Number.isSafeInteger(
          Number(row.count)
        )
          ? Number(row.count)
          : 0,
    }))
    .sort((left, right) =>
      left.status.localeCompare(
        right.status
      )
    );
}

function classifySchema({
  emergencyTableExists,
  safetyTableExists,
  conversationTableExists,
  emergencyColumns,
  emergencyConstraints,
  emergencyIndexes,
  safetyColumns,
  relationshipColumns,
  relationshipConstraints,
  relationshipIndexes,
  statusCounts,
}) {
  const dispatchColumns =
    Object.fromEntries(
      EXPECTED_DISPATCH_COLUMNS.map(
        (name) => [
          name,
          Boolean(
            emergencyColumns[name]
          ),
        ]
      )
    );

  const statusValues =
    statusCounts.map(
      (row) => row.status
    );

  const unsupportedStatuses =
    statusValues.filter(
      (status) =>
        !EXPECTED_EMERGENCY_STATUSES.includes(
          status
        )
    );

  const hasEmergencyRelationshipColumn =
    Boolean(
      relationshipColumns
        .emergency_request_id
    );

  const hasEmergencyRelationshipConstraint =
    relationshipConstraints.some(
      (constraint) =>
        /emergency_request_id/i.test(
          constraint.definition
        )
    );

  const hasSingleActiveIndex =
    relationshipIndexes.some(
      (index) =>
        /emergency/i.test(
          index.name
        ) &&
        /unique/i.test(
          index.definition
        )
    );

  const foundationComplete =
    emergencyTableExists &&
    safetyTableExists &&
    conversationTableExists &&
    hasEmergencyRelationshipColumn &&
    hasEmergencyRelationshipConstraint;

  const dispatchComplete =
    EXPECTED_DISPATCH_COLUMNS.every(
      (name) =>
        dispatchColumns[name] === true
    );

  const singleActiveComplete =
    hasSingleActiveIndex;

  const complete =
    foundationComplete &&
    dispatchComplete &&
    singleActiveComplete &&
    unsupportedStatuses.length === 0;

  const anyEmergencySchema =
    emergencyTableExists ||
    safetyTableExists ||
    hasEmergencyRelationshipColumn ||
    dispatchComplete ||
    singleActiveComplete;

  return {
    classification: complete
      ? "COMPLETE"
      : anyEmergencySchema
        ? "PARTIAL"
        : "ABSENT",
    foundationComplete,
    dispatchComplete,
    singleActiveComplete,
    emergencyTableExists,
    safetyTableExists,
    conversationTableExists,
    dispatchColumns,
    unsupportedStatuses,
    relationship: {
      emergencyRequestColumn:
        hasEmergencyRelationshipColumn,
      sourceConstraint:
        hasEmergencyRelationshipConstraint,
      singleActiveIndex:
        hasSingleActiveIndex,
    },
    inventory: {
      emergencyColumns:
        Object.keys(
          emergencyColumns
        ).sort(),
      safetyColumns:
        Object.keys(
          safetyColumns
        ).sort(),
      emergencyConstraintCount:
        emergencyConstraints.length,
      emergencyIndexCount:
        emergencyIndexes.length,
      relationshipConstraintCount:
        relationshipConstraints.length,
      relationshipIndexCount:
        relationshipIndexes.length,
    },
  };
}

function decisionFor({
  localMigrations,
  ledger,
  schema,
}) {
  if (
    localMigrations.some(
      (migration) =>
        !migration.checksumMatches
    )
  ) {
    return {
      decision: "FAIL",
      code:
        "MIGRATION_CHECKSUM_MISMATCH",
    };
  }

  if (
    ledger.duplicateFilenames.length >
      0 ||
    ledger.checksumDrift.length > 0
  ) {
    return {
      decision: "FAIL",
      code:
        "MIGRATION_LEDGER_CONFLICT",
    };
  }

  if (
    ledger.allRecorded &&
    schema.classification ===
      "COMPLETE"
  ) {
    return {
      decision: "ALREADY_APPLIED",
      code:
        "PRODUCTION_EMERGENCY_READY",
    };
  }

  if (
    !ledger.allRecorded &&
    schema.classification ===
      "ABSENT"
  ) {
    return {
      decision:
        "PASS_READY_FOR_MIGRATION_PLANNING",
      code:
        "PRODUCTION_EMERGENCY_MIGRATIONS_MISSING",
    };
  }

  return {
    decision:
      "BLOCKED_PARTIAL_OR_UNRECORDED_SCHEMA",
    code:
      "PRODUCTION_EMERGENCY_SCHEMA_REQUIRES_REVIEW",
  };
}

function reportForFailure({
  env,
  code,
  decision = "BLOCKED_TARGET_NOT_PROVEN",
}) {
  return {
    success: false,
    decision,
    code,
    target:
      sanitizeTargetMetadata(env),
    migrations:
      EMERGENCY_MIGRATIONS.map(
        (migration) => ({
          filename:
            migration.filename,
          checksum:
            migration.checksum,
        })
      ),
  };
}

function assertDatabaseIdentity(
  env,
  rows
) {
  const parsed =
    parseDatabaseUrl(env.DATABASE_URL);

  const expectedName =
    databaseNameFromUrl(parsed);

  const actualName =
    String(
      rows?.[0]?.database_name || ""
    );

  if (
    !actualName ||
    actualName !== expectedName ||
    hasStagingMarker(actualName)
  ) {
    throw new InspectionFailure(
      "INSPECTION_TARGET_IDENTITY_MISMATCH"
    );
  }
}

async function inspectProductionEmergencyState(
  options = {}
) {
  const env =
    options.env || process.env;

  const validation =
    validateInspectionEnvironment(env);

  if (!validation.valid) {
    return reportForFailure({
      env,
      code: validation.code,
    });
  }

  let localMigrations;

  try {
    localMigrations =
      loadLocalMigrationChecksums(
        options.readFile ||
          fs.readFileSync
      );
  } catch {
    return reportForFailure({
      env,
      code:
        "MIGRATION_SOURCE_UNAVAILABLE",
      decision: "FAIL",
    });
  }

  if (
    localMigrations.some(
      (migration) =>
        !migration.checksumMatches
    )
  ) {
    return {
      ...reportForFailure({
        env,
        code:
          "MIGRATION_CHECKSUM_MISMATCH",
        decision: "FAIL",
      }),
      localMigrations,
    };
  }

  const poolFactory =
    options.poolFactory ||
    ((configuration) =>
      new Pool(configuration));

  let pool;
  let client;
  let transactionStarted = false;
  let rollbackCompleted = false;

  try {
    pool = poolFactory({
      connectionString:
        env.DATABASE_URL,
      ssl:
        env.PGSSLMODE === "disable"
          ? false
          : {
              rejectUnauthorized:
                false,
            },
    });

    client =
      await pool.connect();
  } catch {
    if (
      pool &&
      typeof pool.end === "function"
    ) {
      try {
        await pool.end();
      } catch {
        // Preserve stable failure.
      }
    }

    return {
      ...reportForFailure({
        env,
        code:
          "INSPECTION_DATABASE_UNAVAILABLE",
        decision: "FAIL",
      }),
      localMigrations,
    };
  }

  try {
    await client.query(
      INSPECTION_SQL.begin
    );

    transactionStarted = true;

    const identity =
      await client.query(
        INSPECTION_SQL.databaseIdentity
      );

    assertDatabaseIdentity(
      env,
      identity.rows
    );

    const ledgerExistsResult =
      await client.query(
        INSPECTION_SQL.ledgerExists
      );

    const ledgerExists =
      ledgerExistsResult.rows?.[0]
        ?.exists === true;

    const ledgerRows =
      ledgerExists
        ? (
            await client.query(
              INSPECTION_SQL.ledgerRows
            )
          ).rows
        : [];

    const emergencyTableResult =
      await client.query(
        INSPECTION_SQL
          .emergencyTableExists
      );

    const emergencyTableExists =
      emergencyTableResult.rows?.[0]
        ?.exists === true;

    const emergencyColumnRows =
      emergencyTableExists
        ? (
            await client.query(
              INSPECTION_SQL
                .emergencyColumns
            )
          ).rows
        : [];

    const emergencyConstraintRows =
      emergencyTableExists
        ? (
            await client.query(
              INSPECTION_SQL
                .emergencyConstraints
            )
          ).rows
        : [];

    const emergencyIndexRows =
      emergencyTableExists
        ? (
            await client.query(
              INSPECTION_SQL
                .emergencyIndexes
            )
          ).rows
        : [];

    const safetyTableResult =
      await client.query(
        INSPECTION_SQL
          .safetyTableExists
      );

    const safetyTableExists =
      safetyTableResult.rows?.[0]
        ?.exists === true;

    const safetyColumnRows =
      safetyTableExists
        ? (
            await client.query(
              INSPECTION_SQL
                .safetyColumns
            )
          ).rows
        : [];

    const relationshipColumnRows =
      (
        await client.query(
          INSPECTION_SQL
            .relationshipColumns
        )
      ).rows;

    const relationshipConstraintRows =
      (
        await client.query(
          INSPECTION_SQL
            .relationshipConstraints
        )
      ).rows;

    const relationshipIndexRows =
      (
        await client.query(
          INSPECTION_SQL
            .relationshipIndexes
        )
      ).rows;

    const conversationTableResult =
      await client.query(
        INSPECTION_SQL
          .conversationTableExists
      );

    const conversationTableExists =
      conversationTableResult.rows?.[0]
        ?.exists === true;

    const statusRows =
      emergencyTableExists
        ? (
            await client.query(
              INSPECTION_SQL
                .statusCounts
            )
          ).rows
        : [];

    const ledger =
      analyzeLedger(
        ledgerRows,
        localMigrations
      );

    const schema =
      classifySchema({
        emergencyTableExists,
        safetyTableExists,
        conversationTableExists,
        emergencyColumns:
          mapColumns(
            emergencyColumnRows
          ),
        emergencyConstraints:
          sanitizeDefinitions(
            emergencyConstraintRows,
            "constraint_name",
            "constraint_definition"
          ),
        emergencyIndexes:
          sanitizeDefinitions(
            emergencyIndexRows,
            "index_name",
            "index_definition"
          ),
        safetyColumns:
          mapColumns(
            safetyColumnRows
          ),
        relationshipColumns:
          mapColumns(
            relationshipColumnRows
          ),
        relationshipConstraints:
          sanitizeDefinitions(
            relationshipConstraintRows,
            "constraint_name",
            "constraint_definition"
          ),
        relationshipIndexes:
          sanitizeDefinitions(
            relationshipIndexRows,
            "index_name",
            "index_definition"
          ),
        statusCounts:
          sanitizeStatusCounts(
            statusRows
          ),
      });

    const decision =
      decisionFor({
        localMigrations,
        ledger,
        schema,
      });

    return {
      success:
        [
          "ALREADY_APPLIED",
          "PASS_READY_FOR_MIGRATION_PLANNING",
        ].includes(
          decision.decision
        ),
      decision:
        decision.decision,
      code:
        decision.code,
      target:
        validation.target,
      localMigrations,
      ledger,
      schema,
      statusCounts:
        sanitizeStatusCounts(
          statusRows
        ),
      readOnly:
        true,
    };
  } catch (error) {
    return {
      ...reportForFailure({
        env,
        code:
          error instanceof
          InspectionFailure
            ? error.code
            : "INSPECTION_QUERY_FAILED",
        decision: "FAIL",
      }),
      localMigrations,
    };
  } finally {
    if (
      transactionStarted &&
      client
    ) {
      try {
        await client.query(
          INSPECTION_SQL.rollback
        );

        rollbackCompleted = true;
      } catch {
        rollbackCompleted = false;
      }
    }

    if (
      client &&
      typeof client.release ===
        "function"
    ) {
      try {
        client.release();
      } catch {
        // No raw release details.
      }
    }

    if (
      pool &&
      typeof pool.end === "function"
    ) {
      try {
        await pool.end();
      } catch {
        // No raw pool details.
      }
    }

    void rollbackCompleted;
  }
}

function exitCodeForDecision(
  decision
) {
  if (
    decision === "ALREADY_APPLIED"
  ) {
    return 0;
  }

  if (
    decision ===
    "PASS_READY_FOR_MIGRATION_PLANNING"
  ) {
    return 2;
  }

  return 1;
}

async function runInspectionCli(
  options = {}
) {
  const env =
    options.env || process.env;

  const inspect =
    options.inspect ||
    inspectProductionEmergencyState;

  const write =
    options.write ||
    ((value) =>
      process.stdout.write(value));

  let report;

  try {
    report =
      await inspect({
        ...options,
        env,
      });

    if (
      !report ||
      typeof report !== "object" ||
      ![
        "ALREADY_APPLIED",
        "PASS_READY_FOR_MIGRATION_PLANNING",
        "BLOCKED_TARGET_NOT_PROVEN",
        "BLOCKED_PARTIAL_OR_UNRECORDED_SCHEMA",
        "FAIL",
      ].includes(report.decision)
    ) {
      throw new InspectionFailure(
        "INSPECTION_RESULT_INVALID"
      );
    }
  } catch {
    report =
      reportForFailure({
        env,
        code:
          "INSPECTION_RESULT_INVALID",
        decision: "FAIL",
      });
  }

  write(
    `${JSON.stringify(report)}\n`
  );

  return exitCodeForDecision(
    report.decision
  );
}

if (require.main === module) {
  runInspectionCli().then(
    (exitCode) => {
      process.exitCode =
        exitCode;
    }
  );
}

module.exports = {
  EMERGENCY_MIGRATIONS,
  INSPECTION_SQL,
  analyzeLedger,
  classifyInspectionTarget,
  classifySchema,
  decisionFor,
  inspectProductionEmergencyState,
  loadLocalMigrationChecksums,
  runInspectionCli,
  sanitizeTargetMetadata,
  validateInspectionEnvironment,
};
