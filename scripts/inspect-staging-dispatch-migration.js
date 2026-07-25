#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");

const EXPECTED_PROJECT = "profound-magic";
const EXPECTED_ENVIRONMENT = "staging";
const EXPECTED_SERVICE = "athletic-rebirth";
const REQUIRED_CONFIRMATION = "YES";
const MIGRATION_FILENAME =
  "202607250001_add_emergency_dispatch_lifecycle.sql";
const APPROVED_CHECKSUM =
  "aa39d8311f8a73970e20069dad8fd1e4a4bfa0b65acc7e09cffaa0e33be21462";
const MIGRATIONS_DIRECTORY = path.join(
  __dirname,
  "..",
  "migrations"
);
const MIGRATION_PATH = path.join(
  MIGRATIONS_DIRECTORY,
  MIGRATION_FILENAME
);
const REQUIRED_PREREQUISITES = Object.freeze([
  "202607230001_create_emergency_requests.sql",
  "202607230002_add_emergency_relationship_source.sql",
  "202607230003_create_emergency_safety_assessments.sql",
  "202607240001_add_single_active_emergency_relationship.sql",
]);
const EXPECTED_DISPATCH_COLUMNS = Object.freeze([
  "en_route_at",
  "arrived_at",
  "work_started_at",
  "completed_at",
]);
const LEGACY_STATUSES = Object.freeze([
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
]);
const DISPATCH_STATUSES = Object.freeze([
  "professional_en_route",
  "professional_arrived",
  "work_in_progress",
  "completed",
]);
const EXPECTED_STATUSES = Object.freeze([
  ...LEGACY_STATUSES,
  ...DISPATCH_STATUSES,
]);
const PRODUCTION_MARKER =
  /(^|[^a-z])(prod|production)([^a-z]|$)/i;
const RAILWAY_PRIVATE_SUFFIX = ".railway.internal";
const RAILWAY_PROXY_SUFFIX = ".proxy.rlwy.net";

const INSPECTION_SQL = Object.freeze({
  begin: "BEGIN TRANSACTION READ ONLY",
  databaseIdentity:
    "SELECT current_database() AS database_name",
  ledgerExists: `
    SELECT
      to_regclass('public.schema_migrations') IS NOT NULL AS exists
  `,
  ledgerRows: `
    SELECT filename, checksum, applied_at
    FROM schema_migrations
    ORDER BY filename
  `,
  emergencyTableExists: `
    SELECT
      to_regclass('public.emergency_requests') IS NOT NULL AS exists
  `,
  emergencyColumns: `
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'emergency_requests'
    ORDER BY ordinal_position
  `,
  emergencyConstraints: `
    SELECT
      constraint_name,
      constraint_type,
      pg_get_constraintdef(pc.oid) AS constraint_definition
    FROM information_schema.table_constraints AS tc
    INNER JOIN pg_catalog.pg_constraint AS pc
      ON pc.conname = tc.constraint_name
    INNER JOIN pg_catalog.pg_class AS rel
      ON rel.oid = pc.conrelid
    INNER JOIN pg_catalog.pg_namespace AS ns
      ON ns.oid = rel.relnamespace
    WHERE tc.table_schema = 'public'
      AND tc.table_name = 'emergency_requests'
      AND ns.nspname = 'public'
    ORDER BY constraint_name
  `,
  emergencyIndexes: `
    SELECT indexname AS index_name, indexdef AS index_definition
    FROM pg_catalog.pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'emergency_requests'
    ORDER BY indexname
  `,
  emergencyRowCount:
    "SELECT COUNT(*)::bigint AS row_count FROM emergency_requests",
  emergencyStatusCounts: `
    SELECT status, COUNT(*)::bigint AS count
    FROM emergency_requests
    GROUP BY status
    ORDER BY status
  `,
  rollback: "ROLLBACK",
});

class InspectionFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function parseDatabaseUrl(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }

  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "postgres:" &&
      parsed.protocol !== "postgresql:"
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
  try {
    return decodeURIComponent(
      parsed.pathname.replace(/^\/+/, "")
    );
  } catch {
    return "";
  }
}

function hasProductionMarker(value) {
  return PRODUCTION_MARKER.test(String(value || ""));
}

function hostType(hostname) {
  const host = String(hostname || "").toLowerCase();
  if (host.endsWith(RAILWAY_PRIVATE_SUFFIX)) {
    return "railway-private";
  }
  if (host.endsWith(RAILWAY_PROXY_SUFFIX)) {
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

function databaseNameClass(databaseName) {
  const value = String(databaseName || "").toLowerCase();
  if (!value) return "missing";
  if (hasProductionMarker(value)) return "production-like";
  if (value === "railway") return "railway-default";
  if (value.includes("staging")) return "staging-like";
  return "unknown";
}

function safeIdentity(value, expected) {
  if (value === expected) return expected;
  if (!value) return "unknown";
  if (hasProductionMarker(value)) {
    return "production-like";
  }
  return "unrecognized";
}

function classifyInspectionTarget(env = {}) {
  const parsed = parseDatabaseUrl(env.DATABASE_URL);
  if (!parsed) return "invalid";

  const databaseName = databaseNameFromUrl(parsed);
  const type = hostType(parsed.hostname);
  const identityText = [
    env.RAILWAY_PROJECT_NAME,
    env.RAILWAY_ENVIRONMENT_NAME,
    env.RAILWAY_SERVICE_NAME,
  ].join(" ");

  if (
    String(env.RAILWAY_ENVIRONMENT_NAME || "")
      .toLowerCase() === "production" ||
    String(env.RAILWAY_SERVICE_NAME || "")
      .toLowerCase() ===
      "athletic-rebirth-production-0a28"
  ) {
    return "rejected-railway-production";
  }

  if (
    hasProductionMarker(identityText) ||
    hasProductionMarker(databaseName)
  ) {
    return "rejected-production";
  }

  if (type === "local") return "rejected-local";
  if (type === "unknown") return "rejected-unknown";

  if (
    env.NODE_ENV !== EXPECTED_ENVIRONMENT ||
    env.RAILWAY_PROJECT_NAME !== EXPECTED_PROJECT ||
    env.RAILWAY_ENVIRONMENT_NAME !==
      EXPECTED_ENVIRONMENT ||
    env.RAILWAY_SERVICE_NAME !== EXPECTED_SERVICE ||
    env.CONFIRM_STAGING_DISPATCH_INSPECTION !==
      REQUIRED_CONFIRMATION
  ) {
    return "rejected-unknown";
  }

  if (
    !["railway-default", "staging-like"].includes(
      databaseNameClass(databaseName)
    )
  ) {
    return "rejected-unknown";
  }

  return "staging";
}

function sanitizeTargetMetadata(
  env = {},
  classification = classifyInspectionTarget(env)
) {
  const parsed = parseDatabaseUrl(env.DATABASE_URL);
  return {
    classification,
    protocol: parsed
      ? parsed.protocol.replace(/:$/, "")
      : "invalid",
    hostType: parsed
      ? hostType(parsed.hostname)
      : "unknown",
    databaseNameClass: parsed
      ? databaseNameClass(databaseNameFromUrl(parsed))
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

function validateInspectionEnvironment(env = {}) {
  const classification =
    classifyInspectionTarget(env);
  let code = "INSPECTION_TARGET_NOT_STAGING";

  if (!parseDatabaseUrl(env.DATABASE_URL)) {
    code = "INSPECTION_TARGET_INVALID";
  } else if (
    env.CONFIRM_STAGING_DISPATCH_INSPECTION !==
    REQUIRED_CONFIRMATION
  ) {
    code = "INSPECTION_CONFIRMATION_REQUIRED";
  }

  return {
    valid: classification === "staging",
    classification,
    code:
      classification === "staging"
        ? "STAGING_INSPECTION_AUTHORIZED"
        : code,
    target: sanitizeTargetMetadata(
      env,
      classification
    ),
  };
}

function sha256(value) {
  return crypto
    .createHash("sha256")
    .update(value)
    .digest("hex");
}

function baseMigrationState(localChecksum = null) {
  return {
    filename: MIGRATION_FILENAME,
    localChecksum,
    approvedChecksum: APPROVED_CHECKSUM,
    checksumMatches:
      localChecksum === APPROVED_CHECKSUM,
    recorded: false,
    recordedChecksum: null,
  };
}

function baseLedgerState() {
  return {
    exists: false,
    entries: [],
    latestFilename: null,
    prerequisitesPresent: [],
    prerequisitesMissing: [
      ...REQUIRED_PREREQUISITES,
    ],
    duplicateFilenames: [],
    duplicateTimestampPrefixes: [],
    checksumDrift: [],
    invalidEntries: 0,
  };
}

function baseSchemaState() {
  return {
    tableExists: false,
    classification: "PARTIAL",
    dispatchColumns: Object.fromEntries(
      EXPECTED_DISPATCH_COLUMNS.map((name) => [
        name,
        {
          exists: false,
          dataType: null,
          nullable: null,
          default: null,
        },
      ])
    ),
    primaryKeyPresent: false,
    constraintCount: 0,
    indexCount: 0,
    statusConstraintFound: false,
    expectedStatusesPresent: [],
    expectedStatusesMissing: [
      ...EXPECTED_STATUSES,
    ],
    unexpectedStatuses: [],
    unsupportedRowStatuses: [],
  };
}

function baseCounts() {
  return {
    rowCount: 0,
    statusCounts: [],
  };
}

function reportForFailure({
  env,
  code,
  decision = "FAIL",
  localChecksum = null,
  tests,
}) {
  return {
    success: false,
    decision,
    code,
    target: sanitizeTargetMetadata(env),
    migration: baseMigrationState(localChecksum),
    ledger: baseLedgerState(),
    schema: baseSchemaState(),
    counts: baseCounts(),
    tests: tests || {
      readOnlyTransaction: false,
      rollbackCompleted: false,
    },
  };
}

function loadLocalMigrationChecksums({
  readDirectory,
  readFile,
  migrationsDirectory,
}) {
  const checksums = new Map();
  for (const filename of readDirectory(
    migrationsDirectory
  )) {
    if (!/^\d{12}_[a-z0-9_]+\.sql$/.test(filename)) {
      continue;
    }
    const contents = readFile(
      path.join(migrationsDirectory, filename),
      "utf8"
    );
    checksums.set(filename, sha256(contents));
  }
  return checksums;
}

function duplicateValues(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

function analyzeLedger(rows, localChecksums) {
  const safeRows = [];
  let invalidEntries = 0;

  for (const row of rows || []) {
    if (
      !/^\d{12}_[a-z0-9_]+\.sql$/.test(
        String(row?.filename || "")
      ) ||
      !/^[a-f0-9]{64}$/.test(
        String(row?.checksum || "")
      )
    ) {
      invalidEntries += 1;
      continue;
    }

    let appliedAt = null;
    if (row.applied_at instanceof Date) {
      appliedAt = row.applied_at.toISOString();
    } else if (row.applied_at) {
      const parsedDate = new Date(row.applied_at);
      if (!Number.isNaN(parsedDate.valueOf())) {
        appliedAt = parsedDate.toISOString();
      }
    }

    safeRows.push({
      filename: row.filename,
      checksum: row.checksum,
      appliedAt,
    });
  }

  safeRows.sort((left, right) =>
    left.filename.localeCompare(right.filename)
  );
  const filenames = safeRows.map(
    ({ filename }) => filename
  );
  const timestamps = filenames.map((filename) =>
    filename.slice(0, 12)
  );
  const prerequisiteSet = new Set(filenames);
  const dispatchRows = safeRows.filter(
    ({ filename }) => filename === MIGRATION_FILENAME
  );
  const checksumDrift = safeRows
    .filter(
      ({ filename, checksum }) =>
        localChecksums.has(filename) &&
        localChecksums.get(filename) !== checksum
    )
    .map(({ filename }) => filename)
    .sort();

  return {
    entries: safeRows,
    latestFilename:
      safeRows.at(-1)?.filename || null,
    prerequisitesPresent:
      REQUIRED_PREREQUISITES.filter((filename) =>
        prerequisiteSet.has(filename)
      ),
    prerequisitesMissing:
      REQUIRED_PREREQUISITES.filter(
        (filename) =>
          !prerequisiteSet.has(filename)
    ),
    duplicateFilenames: duplicateValues(filenames),
    duplicateTimestampPrefixes:
      duplicateValues(timestamps),
    checksumDrift,
    invalidEntries,
    dispatchRows,
  };
}

function parseConstraintStatuses(definition) {
  if (
    typeof definition !== "string" ||
    !/\bstatus\b/i.test(definition)
  ) {
    return [];
  }

  return [
    ...new Set(
      [...definition.matchAll(/'((?:''|[^'])*)'/g)]
        .map((match) =>
          match[1].replace(/''/g, "'")
        )
        .filter(Boolean)
    ),
  ].sort();
}

function analyzeSchema({
  tableExists,
  columns,
  constraints,
  indexes,
}) {
  const schema = baseSchemaState();
  schema.tableExists = tableExists;
  schema.constraintCount = constraints.length;
  schema.indexCount = indexes.length;

  const columnMap = new Map(
    columns.map((column) => [
      column.column_name,
      column,
    ])
  );
  for (const columnName of EXPECTED_DISPATCH_COLUMNS) {
    const column = columnMap.get(columnName);
    if (!column) continue;
    schema.dispatchColumns[columnName] = {
      exists: true,
      dataType: String(column.data_type || ""),
      nullable: String(column.is_nullable || ""),
      default:
        column.column_default === undefined
          ? null
          : column.column_default,
    };
  }

  schema.primaryKeyPresent = constraints.some(
    (constraint) =>
      constraint.constraint_type === "PRIMARY KEY"
  );
  const statusConstraint = constraints.find(
    (constraint) =>
      constraint.constraint_name ===
        "emergency_requests_status_check" &&
      constraint.constraint_type === "CHECK"
  );
  const parsedStatuses = parseConstraintStatuses(
    statusConstraint?.constraint_definition
  );
  const parsedSet = new Set(parsedStatuses);
  schema.statusConstraintFound =
    Boolean(statusConstraint) &&
    parsedStatuses.length > 0;
  schema.expectedStatusesPresent =
    EXPECTED_STATUSES.filter((status) =>
      parsedSet.has(status)
    );
  schema.expectedStatusesMissing =
    EXPECTED_STATUSES.filter(
      (status) => !parsedSet.has(status)
    );
  schema.unexpectedStatuses =
    parsedStatuses.filter(
      (status) => !EXPECTED_STATUSES.includes(status)
    );

  return schema;
}

function dispatchColumnsState(schema) {
  const values = Object.values(
    schema.dispatchColumns
  );
  const present = values.filter(
    (column) => column.exists
  );
  const correct = present.filter(
    (column) =>
      column.dataType ===
        "timestamp without time zone" &&
      column.nullable === "YES" &&
      column.default === null
  );
  return {
    nonePresent: present.length === 0,
    allCorrect:
      present.length ===
        EXPECTED_DISPATCH_COLUMNS.length &&
      correct.length ===
        EXPECTED_DISPATCH_COLUMNS.length,
  };
}

function classifySchema({ ledger, schema, migration }) {
  if (
    !migration.checksumMatches ||
    ledger.duplicateFilenames.length > 0 ||
    ledger.duplicateTimestampPrefixes.length > 0 ||
    ledger.checksumDrift.length > 0 ||
    ledger.invalidEntries > 0 ||
    schema.unsupportedRowStatuses.length > 0 ||
    (migration.recorded &&
      migration.recordedChecksum !==
        APPROVED_CHECKSUM)
  ) {
    return "CONFLICTING";
  }

  if (
    !ledger.exists ||
    ledger.prerequisitesMissing.length > 0 ||
    !schema.tableExists ||
    !schema.primaryKeyPresent ||
    !schema.statusConstraintFound
  ) {
    return "PARTIAL";
  }

  const columns = dispatchColumnsState(schema);
  const presentStatuses = new Set(
    schema.expectedStatusesPresent
  );
  const allLegacyPresent = LEGACY_STATUSES.every(
    (status) => presentStatuses.has(status)
  );
  const allStatusesPresent =
    EXPECTED_STATUSES.every((status) =>
      presentStatuses.has(status)
    ) &&
    schema.expectedStatusesMissing.length === 0 &&
    schema.unexpectedStatuses.length === 0;
  const noDispatchStatuses =
    DISPATCH_STATUSES.every(
      (status) => !presentStatuses.has(status)
    );

  if (
    columns.nonePresent &&
    noDispatchStatuses &&
    allLegacyPresent &&
    !migration.recorded
  ) {
    return "ABSENT";
  }

  if (columns.allCorrect && allStatusesPresent) {
    return migration.recorded
      ? "COMPLETE_AND_RECORDED"
      : "COMPLETE_BUT_UNRECORDED";
  }

  return "PARTIAL";
}

function decisionForClassification(classification) {
  if (classification === "ABSENT") {
    return {
      success: true,
      decision: "PASS_READY_FOR_EXECUTION_APPROVAL",
      code: "STAGING_DISPATCH_PREFLIGHT_READY",
    };
  }
  if (classification === "COMPLETE_AND_RECORDED") {
    return {
      success: true,
      decision: "ALREADY_APPLIED",
      code: "STAGING_DISPATCH_ALREADY_APPLIED",
    };
  }
  if (
    classification === "COMPLETE_BUT_UNRECORDED" ||
    classification === "PARTIAL"
  ) {
    return {
      success: false,
      decision: "BLOCKED_PARTIAL_SCHEMA",
      code: "STAGING_DISPATCH_PARTIAL_SCHEMA",
    };
  }
  return {
    success: false,
    decision: "FAIL",
    code: "STAGING_DISPATCH_SCHEMA_CONFLICT",
  };
}

function safeCount(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0
    ? parsed
    : 0;
}

function sanitizeStatusCounts(rows) {
  return (rows || [])
    .filter(
      (row) =>
        typeof row.status === "string"
    )
    .map((row) => ({
      status: /^[a-z][a-z0-9_]{0,63}$/.test(
        row.status
      )
        ? row.status
        : "invalid_status_value",
      count: safeCount(row.count),
    }))
    .sort((left, right) =>
      left.status.localeCompare(right.status)
    );
}

function assertDatabaseIdentity(
  env,
  databaseIdentityRows
) {
  const parsed = parseDatabaseUrl(env.DATABASE_URL);
  const expectedName =
    databaseNameFromUrl(parsed);
  const actualName = String(
    databaseIdentityRows?.[0]?.database_name || ""
  );

  if (
    !actualName ||
    actualName !== expectedName ||
    hasProductionMarker(actualName) ||
    !["railway-default", "staging-like"].includes(
      databaseNameClass(actualName)
    )
  ) {
    throw new InspectionFailure(
      "INSPECTION_TARGET_NOT_STAGING"
    );
  }
}

async function inspectDispatchMigrationState(
  options = {}
) {
  const env = options.env || process.env;
  const validation =
    validateInspectionEnvironment(env);
  if (!validation.valid) {
    return reportForFailure({
      env,
      code: validation.code,
      decision: "BLOCKED_TARGET_NOT_PROVEN",
    });
  }

  const readFile =
    options.readFile || fs.readFileSync;
  const readDirectory =
    options.readDirectory || fs.readdirSync;
  const migrationPath =
    options.migrationPath || MIGRATION_PATH;
  const migrationsDirectory =
    options.migrationsDirectory ||
    MIGRATIONS_DIRECTORY;
  let localMigration;
  let localChecksums;

  try {
    localMigration = readFile(
      migrationPath,
      "utf8"
    );
    localChecksums = loadLocalMigrationChecksums({
      readDirectory,
      readFile,
      migrationsDirectory,
    });
  } catch {
    return reportForFailure({
      env,
      code: "MIGRATION_CHECKSUM_MISMATCH",
    });
  }

  const localChecksum = sha256(localMigration);
  if (localChecksum !== APPROVED_CHECKSUM) {
    return reportForFailure({
      env,
      code: "MIGRATION_CHECKSUM_MISMATCH",
      localChecksum,
    });
  }

  const poolFactory =
    options.poolFactory ||
    ((configuration) =>
      new Pool(configuration));
  let pool;
  let client;
  let transactionStarted = false;
  let rollbackCompleted = false;
  let report;

  try {
    pool = poolFactory({
      connectionString: env.DATABASE_URL,
      ssl:
        env.PGSSLMODE === "disable"
          ? false
          : { rejectUnauthorized: false },
    });
    client = await pool.connect();
  } catch {
    if (pool && typeof pool.end === "function") {
      try {
        await pool.end();
      } catch {
        // The stable connection failure remains authoritative.
      }
    }
    return reportForFailure({
      env,
      code: "INSPECTION_DATABASE_UNAVAILABLE",
      localChecksum,
    });
  }

  try {
    try {
      await client.query(INSPECTION_SQL.begin);
      transactionStarted = true;
    } catch {
      throw new InspectionFailure(
        "INSPECTION_READ_ONLY_BEGIN_FAILED"
      );
    }

    const identityResult = await client.query(
      INSPECTION_SQL.databaseIdentity
    );
    assertDatabaseIdentity(
      env,
      identityResult.rows
    );

    const ledgerExistsResult =
      await client.query(
        INSPECTION_SQL.ledgerExists
      );
    const ledgerExists =
      ledgerExistsResult.rows[0]?.exists === true;
    const ledgerRows = ledgerExists
      ? (
          await client.query(
            INSPECTION_SQL.ledgerRows
          )
        ).rows
      : [];
    const ledgerAnalysis = analyzeLedger(
      ledgerRows,
      localChecksums
    );
    const dispatchRows =
      ledgerAnalysis.dispatchRows;
    const migration = {
      ...baseMigrationState(localChecksum),
      recorded: dispatchRows.length > 0,
      recordedChecksum:
        dispatchRows[0]?.checksum || null,
    };
    const ledger = {
      exists: ledgerExists,
      entries: ledgerAnalysis.entries,
      latestFilename:
        ledgerAnalysis.latestFilename,
      prerequisitesPresent:
        ledgerAnalysis.prerequisitesPresent,
      prerequisitesMissing:
        ledgerAnalysis.prerequisitesMissing,
      duplicateFilenames:
        ledgerAnalysis.duplicateFilenames,
      duplicateTimestampPrefixes:
        ledgerAnalysis.duplicateTimestampPrefixes,
      checksumDrift:
        ledgerAnalysis.checksumDrift,
      invalidEntries:
        ledgerAnalysis.invalidEntries,
    };

    const tableExistsResult =
      await client.query(
        INSPECTION_SQL.emergencyTableExists
      );
    const tableExists =
      tableExistsResult.rows[0]?.exists === true;
    let columnRows = [];
    let constraintRows = [];
    let indexRows = [];
    let rowCount = 0;
    let statusCounts = [];

    if (tableExists) {
      columnRows = (
        await client.query(
          INSPECTION_SQL.emergencyColumns
        )
      ).rows;
      constraintRows = (
        await client.query(
          INSPECTION_SQL.emergencyConstraints
        )
      ).rows;
      indexRows = (
        await client.query(
          INSPECTION_SQL.emergencyIndexes
        )
      ).rows;
      const rowCountResult = await client.query(
        INSPECTION_SQL.emergencyRowCount
      );
      rowCount = safeCount(
        rowCountResult.rows[0]?.row_count
      );
      const statusResult = await client.query(
        INSPECTION_SQL.emergencyStatusCounts
      );
      statusCounts = sanitizeStatusCounts(
        statusResult.rows
      );
    }

    const schema = analyzeSchema({
      tableExists,
      columns: columnRows,
      constraints: constraintRows,
      indexes: indexRows,
    });
    schema.unsupportedRowStatuses = [
      ...new Set(
        statusCounts
          .map(({ status }) => status)
          .filter(
            (status) =>
              !EXPECTED_STATUSES.includes(status)
          )
      ),
    ].sort();
    schema.classification = classifySchema({
      ledger,
      schema,
      migration,
    });
    const decision = decisionForClassification(
      schema.classification
    );

    await client.query(INSPECTION_SQL.rollback);
    transactionStarted = false;
    rollbackCompleted = true;

    report = {
      ...decision,
      target: validation.target,
      migration,
      ledger,
      schema,
      counts: {
        rowCount,
        statusCounts,
      },
      tests: {
        readOnlyTransaction: true,
        rollbackCompleted: true,
      },
    };
  } catch (error) {
    let code =
      error instanceof InspectionFailure
        ? error.code
        : "INSPECTION_QUERY_FAILED";

    if (transactionStarted) {
      try {
        await client.query(
          INSPECTION_SQL.rollback
        );
        transactionStarted = false;
        rollbackCompleted = true;
      } catch {
        code = "INSPECTION_ROLLBACK_FAILED";
      }
    }

    report = reportForFailure({
      env,
      code,
      decision:
        code === "INSPECTION_TARGET_NOT_STAGING"
          ? "BLOCKED_TARGET_NOT_PROVEN"
          : "FAIL",
      localChecksum,
      tests: {
        readOnlyTransaction:
          code !==
          "INSPECTION_READ_ONLY_BEGIN_FAILED",
        rollbackCompleted,
      },
    });
  }

  try {
    client.release();
  } catch {
    report = reportForFailure({
      env,
      code: "INSPECTION_DATABASE_UNAVAILABLE",
      localChecksum,
      tests: {
        readOnlyTransaction:
          report.tests.readOnlyTransaction,
        rollbackCompleted:
          report.tests.rollbackCompleted,
      },
    });
  }

  if (typeof pool.end === "function") {
    try {
      await pool.end();
    } catch {
      report = reportForFailure({
        env,
        code: "INSPECTION_DATABASE_UNAVAILABLE",
        localChecksum,
        tests: {
          readOnlyTransaction:
            report.tests.readOnlyTransaction,
          rollbackCompleted:
            report.tests.rollbackCompleted,
        },
      });
    }
  }

  return report;
}

function exitCodeForDecision(decision) {
  if (
    decision === "PASS_READY_FOR_EXECUTION_APPROVAL" ||
    decision === "ALREADY_APPLIED"
  ) {
    return 0;
  }
  if (
    decision === "BLOCKED_TARGET_NOT_PROVEN" ||
    decision === "BLOCKED_PARTIAL_SCHEMA"
  ) {
    return 2;
  }
  return 1;
}

async function runInspectionCli(options = {}) {
  const env = options.env || process.env;
  const write =
    options.write ||
    ((value) => process.stdout.write(value));
  const inspect =
    options.inspect ||
    inspectDispatchMigrationState;
  let report;

  try {
    report = await inspect({
      ...options,
      env,
    });
    if (
      !report ||
      typeof report !== "object" ||
      ![
        "PASS_READY_FOR_EXECUTION_APPROVAL",
        "ALREADY_APPLIED",
        "BLOCKED_TARGET_NOT_PROVEN",
        "BLOCKED_PARTIAL_SCHEMA",
        "FAIL",
      ].includes(report.decision)
    ) {
      throw new InspectionFailure(
        "INSPECTION_RESULT_INVALID"
      );
    }
  } catch {
    report = reportForFailure({
      env,
      code: "INSPECTION_RESULT_INVALID",
    });
  }

  write(`${JSON.stringify(report)}\n`);
  return exitCodeForDecision(report.decision);
}

if (require.main === module) {
  runInspectionCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}

module.exports = {
  classifyInspectionTarget,
  inspectDispatchMigrationState,
  runInspectionCli,
  sanitizeTargetMetadata,
  validateInspectionEnvironment,
};
