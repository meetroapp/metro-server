#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");
const {
  inspectProductionEmergencyState,
} = require("./inspect-production-emergency-migrations");

const MIGRATIONS_DIRECTORY = path.join(
  __dirname,
  "..",
  "migrations"
);

const APPROVED_MIGRATIONS = Object.freeze([
  Object.freeze({
    filename: "202607230001_create_emergency_requests.sql",
    checksum:
      "29fc9b8cbf68e63daf01f6103e42b982492add0ae4c745d3a643251d9a9eaf7b",
  }),
  Object.freeze({
    filename: "202607230002_add_emergency_relationship_source.sql",
    checksum:
      "d5ffe1e34b61087afb58905d116c7fe04ed1262b699905f081efc8abd3b5b7a0",
  }),
  Object.freeze({
    filename: "202607230003_create_emergency_safety_assessments.sql",
    checksum:
      "f02ddb70a1c50914fc0acaf2ffe5f4f434a4b8e1db910bea20b44e28d1706e23",
  }),
  Object.freeze({
    filename: "202607240001_add_single_active_emergency_relationship.sql",
    checksum:
      "5d824b8c31722dcd6a9debd49b28687f16b93b1efd4f71b65bb8eb89fff2fa80",
  }),
  Object.freeze({
    filename: "202607250001_add_emergency_dispatch_lifecycle.sql",
    checksum:
      "aa39d8311f8a73970e20069dad8fd1e4a4bfa0b65acc7e09cffaa0e33be21462",
  }),
]);

const REQUIRED_CONFIRMATIONS = Object.freeze({
  CONFIRM_PRODUCTION_EMERGENCY_MIGRATION: "YES",
  CONFIRM_PRODUCTION_TARGET:
    "profound-magic/production/athletic-rebirth",
  CONFIRM_EMERGENCY_MIGRATION_CHAIN:
    "202607230001-202607250001",
  CONFIRM_PRODUCTION_MUTATION: "EXECUTE",
});

const EXPECTED_IDENTITY = Object.freeze({
  NODE_ENV: "production",
  RAILWAY_PROJECT_NAME: "profound-magic",
  RAILWAY_ENVIRONMENT_NAME: "production",
  RAILWAY_SERVICE_NAME: "athletic-rebirth",
});

const EXECUTION_TARGET = "production-governed-emergency";
const ADVISORY_LOCK_ID = 481005041;
const MIGRATION_FILENAME_PATTERN =
  /^\d{12}_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;

const FORBIDDEN_SQL = Object.freeze([
  /\bDROP\s+DATABASE\b/i,
  /\bDROP\s+SCHEMA\b/i,
  /\bTRUNCATE\b/i,
  /\bDELETE\s+FROM\b/i,
  /\bALTER\s+ROLE\b/i,
  /\bCREATE\s+ROLE\b/i,
  /\bGRANT\b/i,
  /\bREVOKE\b/i,
  /(^|\s)\\?copy\b/i,
  /\bVACUUM\b/i,
  /\bREINDEX\b/i,
  /\bCLUSTER\b/i,
]);

const REQUIRED_SQL_SCOPE = Object.freeze({
  "202607230001_create_emergency_requests.sql": Object.freeze([
    /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+emergency_requests/i,
    /emergency_requests_status_check/i,
    /emergency_requests_homeowner_idx/i,
    /emergency_requests_status_service_idx/i,
  ]),
  "202607230002_add_emergency_relationship_source.sql": Object.freeze([
    /ALTER\s+TABLE\s+request_relationships/i,
    /ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+emergency_request_id/i,
    /request_relationships_exactly_one_source/i,
    /request_relationships_unique_emergency_response/i,
  ]),
  "202607230003_create_emergency_safety_assessments.sql": Object.freeze([
    /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+emergency_request_safety_assessments/i,
    /emergency_request_safety_assessments_one_per_request/i,
    /emergency_request_safety_assessments_disposition_check/i,
  ]),
  "202607240001_add_single_active_emergency_relationship.sql": Object.freeze([
    /CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+request_relationships_one_active_emergency/i,
    /status\s*=\s*'active'/i,
  ]),
  "202607250001_add_emergency_dispatch_lifecycle.sql": Object.freeze([
    /ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+en_route_at/i,
    /ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+arrived_at/i,
    /ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+work_started_at/i,
    /ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+completed_at/i,
    /'professional_en_route'/i,
    /'professional_arrived'/i,
    /'work_in_progress'/i,
    /'completed'/i,
  ]),
});

const VERIFICATION_SQL = Object.freeze({
  "202607230001_create_emergency_requests.sql": `
    SELECT (
      to_regclass('public.emergency_requests') IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'emergency_requests'
          AND column_name = 'homeowner_id'
      )
      AND EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'emergency_requests'
          AND column_name = 'service_domain'
      )
      AND EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_schema = 'public'
          AND table_name = 'emergency_requests'
          AND constraint_name = 'emergency_requests_status_check'
      )
    ) AS verified
  `,
  "202607230002_add_emergency_relationship_source.sql": `
    SELECT (
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'request_relationships'
          AND column_name = 'emergency_request_id'
      )
      AND EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_schema = 'public'
          AND table_name = 'request_relationships'
          AND constraint_name = 'request_relationships_exactly_one_source'
      )
    ) AS verified
  `,
  "202607230003_create_emergency_safety_assessments.sql": `
    SELECT (
      to_regclass(
        'public.emergency_request_safety_assessments'
      ) IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'emergency_request_safety_assessments'
          AND column_name = 'emergency_request_id'
      )
    ) AS verified
  `,
  "202607240001_add_single_active_emergency_relationship.sql": `
    SELECT EXISTS (
      SELECT 1 FROM pg_catalog.pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'request_relationships'
        AND indexname = 'request_relationships_one_active_emergency'
        AND indexdef ILIKE '%UNIQUE%'
        AND indexdef ILIKE '%emergency_request_id%'
        AND indexdef ILIKE '%status%active%'
    ) AS verified
  `,
  "202607250001_add_emergency_dispatch_lifecycle.sql": `
    SELECT (
      (
        SELECT COUNT(*) = 4
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'emergency_requests'
          AND column_name = ANY(
            ARRAY[
              'en_route_at',
              'arrived_at',
              'work_started_at',
              'completed_at'
            ]
          )
      )
      AND EXISTS (
        SELECT 1
        FROM pg_catalog.pg_constraint constraint_record
        INNER JOIN pg_catalog.pg_class relation
          ON relation.oid = constraint_record.conrelid
        INNER JOIN pg_catalog.pg_namespace namespace
          ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND relation.relname = 'emergency_requests'
          AND constraint_record.conname = 'emergency_requests_status_check'
          AND pg_get_constraintdef(constraint_record.oid)
            ILIKE '%professional_en_route%'
          AND pg_get_constraintdef(constraint_record.oid)
            ILIKE '%professional_arrived%'
          AND pg_get_constraintdef(constraint_record.oid)
            ILIKE '%work_in_progress%'
          AND pg_get_constraintdef(constraint_record.oid)
            ILIKE '%completed%'
      )
    ) AS verified
  `,
});

const LEDGER_SELECT_SQL = `
  SELECT filename, checksum, execution_target, applied_at
  FROM schema_migrations
  WHERE filename = $1
  ORDER BY applied_at
`;

const LEDGER_INSERT_SQL = `
  INSERT INTO schema_migrations (
    filename,
    checksum,
    execution_target
  ) VALUES ($1, $2, $3)
`;

class RunnerFailure extends Error {
  constructor(code) {
    super(code);
    this.name = "RunnerFailure";
    this.code = code;
  }
}

function fail(code) {
  throw new RunnerFailure(code);
}

function parseDatabaseUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = new URL(value);
    if (!["postgres:", "postgresql:"].includes(parsed.protocol)) return null;
    if (!parsed.username || !parsed.password || !parsed.hostname) return null;
    if (!parsed.pathname || parsed.pathname === "/") return null;
    return parsed;
  } catch {
    return null;
  }
}

function isRailwayPrivateHost(hostname = "") {
  const normalized = String(hostname).toLowerCase();
  return (
    normalized === "railway.internal" ||
    normalized.endsWith(".railway.internal")
  );
}

function sanitizedTarget(env = {}, parsed = parseDatabaseUrl(env.DATABASE_URL)) {
  const identityMatches = Object.entries(EXPECTED_IDENTITY).every(
    ([name, value]) => env[name] === value
  );
  return {
    classification:
      identityMatches && parsed && isRailwayPrivateHost(parsed.hostname)
        ? "production"
        : "rejected",
    protocol: parsed ? parsed.protocol.replace(/:$/, "") : "invalid",
    hostType:
      parsed && isRailwayPrivateHost(parsed.hostname)
        ? "railway-private"
        : "rejected",
    projectName:
      env.RAILWAY_PROJECT_NAME === EXPECTED_IDENTITY.RAILWAY_PROJECT_NAME
        ? EXPECTED_IDENTITY.RAILWAY_PROJECT_NAME
        : "mismatch",
    environmentName:
      env.RAILWAY_ENVIRONMENT_NAME ===
      EXPECTED_IDENTITY.RAILWAY_ENVIRONMENT_NAME
        ? EXPECTED_IDENTITY.RAILWAY_ENVIRONMENT_NAME
        : "mismatch",
    serviceName:
      env.RAILWAY_SERVICE_NAME === EXPECTED_IDENTITY.RAILWAY_SERVICE_NAME
        ? EXPECTED_IDENTITY.RAILWAY_SERVICE_NAME
        : "mismatch",
  };
}

function authorizeExecution(env = {}) {
  const parsed = parseDatabaseUrl(env.DATABASE_URL);
  const checks = [
    [env.NODE_ENV === EXPECTED_IDENTITY.NODE_ENV, "AUTH_NODE_ENV_MISMATCH"],
    [
      env.RAILWAY_PROJECT_NAME === EXPECTED_IDENTITY.RAILWAY_PROJECT_NAME,
      "AUTH_PROJECT_MISMATCH",
    ],
    [
      env.RAILWAY_ENVIRONMENT_NAME ===
        EXPECTED_IDENTITY.RAILWAY_ENVIRONMENT_NAME,
      "AUTH_ENVIRONMENT_MISMATCH",
    ],
    [
      env.RAILWAY_SERVICE_NAME === EXPECTED_IDENTITY.RAILWAY_SERVICE_NAME,
      "AUTH_SERVICE_MISMATCH",
    ],
    ...Object.entries(REQUIRED_CONFIRMATIONS).map(([name, value]) => [
      env[name] === value,
      `AUTH_${name}_MISMATCH`,
    ]),
    [Boolean(parsed), "AUTH_DATABASE_URL_INVALID"],
    [
      Boolean(parsed && isRailwayPrivateHost(parsed.hostname)),
      "AUTH_DATABASE_TARGET_INVALID",
    ],
  ];
  const failed = checks.find(([passed]) => !passed);
  return {
    authorized: !failed,
    code: failed ? failed[1] : "PRODUCTION_EMERGENCY_MIGRATION_AUTHORIZED",
    target: sanitizedTarget(env, parsed),
  };
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stripSqlComments(sql) {
  return String(sql)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\r\n]*/g, " ");
}

function inspectMigrationSqlScope(filename, sql) {
  const expected = REQUIRED_SQL_SCOPE[filename];
  if (!expected) fail("MIGRATION_SCOPE_UNAPPROVED");
  const withoutComments = stripSqlComments(sql);
  if (FORBIDDEN_SQL.some((pattern) => pattern.test(withoutComments))) {
    fail("MIGRATION_SQL_FORBIDDEN");
  }
  if (!expected.every((pattern) => pattern.test(withoutComments))) {
    fail("MIGRATION_SQL_SCOPE_MISMATCH");
  }
  return true;
}

function validatePinnedManifest(manifest = APPROVED_MIGRATIONS) {
  if (!Array.isArray(manifest) || manifest.length !== APPROVED_MIGRATIONS.length) {
    fail("MIGRATION_MANIFEST_MISMATCH");
  }
  const seen = new Set();
  for (let index = 0; index < APPROVED_MIGRATIONS.length; index += 1) {
    const expected = APPROVED_MIGRATIONS[index];
    const actual = manifest[index];
    if (
      !actual ||
      actual.filename !== expected.filename ||
      actual.checksum !== expected.checksum ||
      seen.has(actual.filename)
    ) {
      fail("MIGRATION_MANIFEST_MISMATCH");
    }
    seen.add(actual.filename);
  }
  return true;
}

function loadApprovedMigrations(options = {}) {
  validatePinnedManifest();
  const fileSystem = options.fileSystem || fs;
  const migrationsDirectory = path.resolve(
    options.migrationsDirectory || MIGRATIONS_DIRECTORY
  );
  const directoryStat = fileSystem.lstatSync(migrationsDirectory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    fail("MIGRATION_DIRECTORY_INVALID");
  }
  const realDirectory = fileSystem.realpathSync(migrationsDirectory);
  if (path.resolve(realDirectory) !== migrationsDirectory) {
    fail("MIGRATION_DIRECTORY_ESCAPE");
  }
  const entries = fileSystem.readdirSync(migrationsDirectory, {
    withFileTypes: true,
  });
  const sqlNames = entries
    .map((entry) => (typeof entry === "string" ? entry : entry.name))
    .filter((name) => name.toLowerCase().endsWith(".sql"));
  if (sqlNames.some((name) => !MIGRATION_FILENAME_PATTERN.test(name))) {
    fail("MIGRATION_FILENAME_INVALID");
  }
  const normalizedCounts = new Map();
  for (const name of sqlNames) {
    const normalized = name.toLowerCase();
    normalizedCounts.set(normalized, (normalizedCounts.get(normalized) || 0) + 1);
  }

  return APPROVED_MIGRATIONS.map((approved) => {
    if (
      normalizedCounts.get(approved.filename.toLowerCase()) !== 1 ||
      !sqlNames.includes(approved.filename)
    ) {
      fail("MIGRATION_FILE_MISSING_OR_DUPLICATE");
    }
    const filePath = path.resolve(migrationsDirectory, approved.filename);
    if (path.dirname(filePath) !== migrationsDirectory) {
      fail("MIGRATION_PATH_ESCAPE");
    }
    const stat = fileSystem.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      fail("MIGRATION_PATH_ESCAPE");
    }
    if (path.resolve(fileSystem.realpathSync(filePath)) !== filePath) {
      fail("MIGRATION_PATH_ESCAPE");
    }
    const sql = fileSystem.readFileSync(filePath, "utf8");
    const checksum = sha256(sql);
    if (checksum !== approved.checksum) {
      fail("MIGRATION_CHECKSUM_MISMATCH");
    }
    inspectMigrationSqlScope(approved.filename, sql);
    return {
      filename: approved.filename,
      checksum,
      sql,
      verificationSql: VERIFICATION_SQL[approved.filename],
    };
  });
}

function publicMigrations(migrations = APPROVED_MIGRATIONS) {
  return migrations.map(({ filename, checksum }) => ({ filename, checksum }));
}

function summarizeInspection(report) {
  return {
    success: report?.success === true,
    decision: typeof report?.decision === "string" ? report.decision : "FAIL",
    code: typeof report?.code === "string" ? report.code : "INSPECTION_INVALID",
    readOnly: report?.readOnly === true,
    schema: {
      classification: report?.schema?.classification || null,
      foundationComplete: report?.schema?.foundationComplete === true,
      emergencyFoundationComplete:
        report?.schema?.emergencyFoundationComplete === true,
      exactMigration1Prefix:
        report?.schema?.exactMigration1Prefix === true,
      migration2Residue:
        report?.schema?.migration2Residue === true,
      dispatchComplete: report?.schema?.dispatchComplete === true,
      singleActiveComplete: report?.schema?.singleActiveComplete === true,
      emergencyTableExists: report?.schema?.emergencyTableExists === true,
      safetyTableExists: report?.schema?.safetyTableExists === true,
      unsupportedStatuses: Array.isArray(report?.schema?.unsupportedStatuses)
        ? report.schema.unsupportedStatuses.map(() => "unsupported_status")
        : [],
      relationship: {
        emergencyRequestColumn:
          report?.schema?.relationship?.emergencyRequestColumn === true,
        sourceConstraint: report?.schema?.relationship?.sourceConstraint === true,
        singleActiveIndex:
          report?.schema?.relationship?.singleActiveIndex === true,
      },
      dispatchColumns: Object.fromEntries(
        ["en_route_at", "arrived_at", "work_started_at", "completed_at"].map(
          (name) => [name, report?.schema?.dispatchColumns?.[name] === true]
        )
      ),
    },
    prerequisites: {
      requestRelationshipsTableExists:
        report?.prerequisites?.requestRelationshipsTableExists === true,
      conversationsTableExists:
        report?.prerequisites?.conversationsTableExists === true,
      complete:
        report?.prerequisites?.complete === true,
    },
    ledger: {
      entries: Array.isArray(report?.ledger?.entries)
        ? report.ledger.entries.map((entry) => ({
            filename: entry.filename,
            checksum: entry.checksum,
            executionTarget:
              entry.executionTarget,
            applied:
              entry.applied === true,
          }))
        : [],
      missing: Array.isArray(report?.ledger?.missing)
        ? [...report.ledger.missing]
        : [],
      checksumDrift: Array.isArray(report?.ledger?.checksumDrift)
        ? [...report.ledger.checksumDrift]
        : [],
      duplicateFilenames: Array.isArray(report?.ledger?.duplicateFilenames)
        ? [...report.ledger.duplicateFilenames]
        : [],
      allRecorded: report?.ledger?.allRecorded === true,
      allChecksumsMatch: report?.ledger?.allChecksumsMatch === true,
    },
  };
}

function exactApprovedEntries(entries) {
  if (!Array.isArray(entries) || entries.length !== APPROVED_MIGRATIONS.length) {
    return false;
  }
  return APPROVED_MIGRATIONS.every((approved, index) => {
    const entry = entries[index];
    return (
      entry?.filename ===
        approved.filename &&
      entry?.checksum ===
        approved.checksum &&
      entry?.executionTarget ===
        EXECUTION_TARGET &&
      entry?.applied === true
    );
  });
}

function exactMigration1PrefixEntries(
  entries
) {
  const first =
    APPROVED_MIGRATIONS[0];

  return (
    Array.isArray(entries) &&
    entries.length === 1 &&
    entries[0]?.filename ===
      first.filename &&
    entries[0]?.checksum ===
      first.checksum &&
    entries[0]?.executionTarget ===
      EXECUTION_TARGET &&
    entries[0]?.applied === true
  );
}

function isReadyPreflight(summary) {
  const schema = summary.schema;
  const ledger = summary.ledger;
  return (
    summary.success &&
    summary.decision === "PASS_READY_FOR_MIGRATION_PLANNING" &&
    summary.code === "PRODUCTION_EMERGENCY_MIGRATIONS_MISSING" &&
    summary.readOnly &&
    summary.prerequisites.complete &&
    summary.prerequisites.requestRelationshipsTableExists &&
    summary.prerequisites.conversationsTableExists &&
    schema.classification === "ABSENT" &&
    !schema.emergencyTableExists &&
    !schema.safetyTableExists &&
    !schema.relationship.emergencyRequestColumn &&
    !schema.relationship.sourceConstraint &&
    !schema.relationship.singleActiveIndex &&
    Object.values(schema.dispatchColumns).every((value) => !value) &&
    schema.unsupportedStatuses.length === 0 &&
    ledger.entries.length === 0 &&
    ledger.checksumDrift.length === 0 &&
    ledger.duplicateFilenames.length === 0 &&
    !ledger.allRecorded &&
    ledger.missing.length === APPROVED_MIGRATIONS.length &&
    APPROVED_MIGRATIONS.every((migration) =>
      ledger.missing.includes(migration.filename)
    )
  );
}

function isSafePrefixPreflight(
  summary
) {
  const schema = summary.schema;
  const ledger = summary.ledger;

  return (
    summary.success &&
    summary.decision ===
      "SAFE_PARTIAL_PREFIX_READY_TO_RESUME" &&
    summary.code ===
      "PRODUCTION_EMERGENCY_SAFE_PREFIX_READY" &&
    summary.readOnly &&
    summary.prerequisites.complete &&
    summary.prerequisites.requestRelationshipsTableExists &&
    summary.prerequisites.conversationsTableExists &&
    schema.classification === "PARTIAL" &&
    schema.emergencyFoundationComplete &&
    schema.exactMigration1Prefix &&
    !schema.migration2Residue &&
    schema.emergencyTableExists &&
    !schema.safetyTableExists &&
    !schema.relationship.emergencyRequestColumn &&
    !schema.relationship.sourceConstraint &&
    !schema.relationship.singleActiveIndex &&
    Object.values(
      schema.dispatchColumns
    ).every((value) => !value) &&
    schema.unsupportedStatuses.length === 0 &&
    exactMigration1PrefixEntries(
      ledger.entries
    ) &&
    ledger.missing.length ===
      APPROVED_MIGRATIONS.length - 1 &&
    APPROVED_MIGRATIONS
      .slice(1)
      .every((migration) =>
        ledger.missing.includes(
          migration.filename
        )
      ) &&
    ledger.checksumDrift.length === 0 &&
    ledger.duplicateFilenames.length === 0 &&
    !ledger.allRecorded &&
    ledger.allChecksumsMatch
  );
}

function isAlreadyApplied(summary) {
  const schema = summary.schema;
  const ledger = summary.ledger;
  return (
    summary.success &&
    summary.decision === "ALREADY_APPLIED" &&
    summary.code === "PRODUCTION_EMERGENCY_READY" &&
    summary.readOnly &&
    summary.prerequisites.complete &&
    summary.prerequisites.requestRelationshipsTableExists &&
    summary.prerequisites.conversationsTableExists &&
    schema.classification === "COMPLETE" &&
    schema.foundationComplete &&
    schema.dispatchComplete &&
    schema.singleActiveComplete &&
    schema.emergencyTableExists &&
    schema.safetyTableExists &&
    schema.relationship.emergencyRequestColumn &&
    schema.relationship.sourceConstraint &&
    schema.relationship.singleActiveIndex &&
    Object.values(schema.dispatchColumns).every((value) => value) &&
    schema.unsupportedStatuses.length === 0 &&
    ledger.missing.length === 0 &&
    ledger.checksumDrift.length === 0 &&
    ledger.duplicateFilenames.length === 0 &&
    ledger.allRecorded &&
    ledger.allChecksumsMatch &&
    exactApprovedEntries(ledger.entries)
  );
}

function emptyExecution({
  startIndex = 0,
  skippedVerifiedPrefix = [],
} = {}) {
  return {
    committed: [],
    skippedVerifiedPrefix:
      [...skippedVerifiedPrefix],
    failedMigration: null,
    notAttempted: APPROVED_MIGRATIONS
      .slice(startIndex)
      .map(({ filename }) => filename),
  };
}

function failureResult({
  code,
  target,
  mutationStarted = false,
  execution = emptyExecution(),
  preflight = null,
  postflight = null,
}) {
  return {
    success: false,
    decision: "FAIL",
    code,
    target,
    migrations: publicMigrations(),
    preflight,
    execution,
    postflight,
    mutationStarted,
  };
}

function inspectionOptions(env, inspectPoolFactory) {
  return {
    env: {
      ...env,
      CONFIRM_PRODUCTION_EMERGENCY_INSPECTION: "YES",
    },
    ...(inspectPoolFactory ? { poolFactory: inspectPoolFactory } : {}),
  };
}

async function runProductionEmergencyMigrations(options = {}) {
  const env = options.env || process.env;
  const authorization = authorizeExecution(env);
  const target = authorization.target;
  if (!authorization.authorized) {
    return failureResult({ code: authorization.code, target });
  }

  let migrations;
  try {
    migrations = loadApprovedMigrations({
      migrationsDirectory: options.migrationsDirectory,
      fileSystem: options.fileSystem,
    });
  } catch (error) {
    return failureResult({
      code:
        error instanceof RunnerFailure
          ? error.code
          : "MIGRATION_SOURCE_VALIDATION_FAILED",
      target,
    });
  }

  const inspect = options.inspect || inspectProductionEmergencyState;
  let preflightReport;
  try {
    preflightReport = await inspect(
      inspectionOptions(env, options.inspectionPoolFactory)
    );
  } catch {
    return failureResult({ code: "PREFLIGHT_INSPECTION_FAILED", target });
  }
  const preflight = summarizeInspection(preflightReport);

  if (isAlreadyApplied(preflight)) {
    return {
      success: true,
      decision: "ALREADY_APPLIED",
      code: "PRODUCTION_EMERGENCY_MIGRATIONS_ALREADY_APPLIED",
      target,
      migrations: publicMigrations(migrations),
      preflight,
      execution: emptyExecution(),
      postflight: preflight,
      mutationStarted: false,
    };
  }

  const blockedOnPrerequisites =
    preflight.code ===
      "CANONICAL_PREREQUISITES_MISSING" &&
    [
      "BLOCKED_MISSING_CANONICAL_PREREQUISITES",
      "SAFE_PARTIAL_PREFIX_BLOCKED_ON_PREREQUISITES",
    ].includes(
      preflight.decision
    );

  if (blockedOnPrerequisites) {
    return failureResult({
      code:
        "CANONICAL_PREREQUISITES_MISSING",
      target,
      preflight,
      execution:
        emptyExecution({
          startIndex:
            preflight.decision ===
            "SAFE_PARTIAL_PREFIX_BLOCKED_ON_PREREQUISITES"
              ? 1
              : 0,
          skippedVerifiedPrefix:
            preflight.decision ===
            "SAFE_PARTIAL_PREFIX_BLOCKED_ON_PREREQUISITES"
              ? [
                  APPROVED_MIGRATIONS[0]
                    .filename,
                ]
              : [],
        }),
    });
  }

  const freshExecution =
    isReadyPreflight(preflight);
  const safePrefixExecution =
    isSafePrefixPreflight(
      preflight
    );

  if (
    !freshExecution &&
    !safePrefixExecution
  ) {
    return failureResult({
      code: "PREFLIGHT_STATE_BLOCKED",
      target,
      preflight,
    });
  }

  const startIndex =
    safePrefixExecution ? 1 : 0;
  const skippedVerifiedPrefix =
    safePrefixExecution
      ? [
          APPROVED_MIGRATIONS[0]
            .filename,
        ]
      : [];

  const poolFactory = options.poolFactory || ((configuration) => new Pool(configuration));
  let pool;
  let client;
  let transactionStarted = false;
  let mutationStarted = false;
  const execution = emptyExecution({
    startIndex,
    skippedVerifiedPrefix,
  });

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
        // Stable failure remains authoritative.
      }
    }
    return failureResult({
      code: "DATABASE_CONNECTION_FAILED",
      target,
      preflight,
    });
  }

  let executionFailure = null;
  try {
    for (
      let index = startIndex;
      index < migrations.length;
      index += 1
    ) {
      const migration = migrations[index];
      execution.notAttempted = migrations
        .slice(index)
        .map(({ filename }) => filename);
      try {
        await client.query("BEGIN");
        transactionStarted = true;
        await client.query("SELECT pg_advisory_xact_lock($1)", [ADVISORY_LOCK_ID]);
        const existing = await client.query(LEDGER_SELECT_SQL, [migration.filename]);
        if (existing.rows.length !== 0) fail("MIGRATION_LEDGER_CONFLICT");

        mutationStarted = true;
        await client.query(migration.sql);
        const verification = await client.query(migration.verificationSql);
        if (verification.rows?.[0]?.verified !== true) {
          fail("MIGRATION_EFFECT_VERIFICATION_FAILED");
        }
        await client.query(LEDGER_INSERT_SQL, [
          migration.filename,
          migration.checksum,
          EXECUTION_TARGET,
        ]);
        const recorded = await client.query(LEDGER_SELECT_SQL, [migration.filename]);
        if (
          recorded.rows.length !== 1 ||
          recorded.rows[0].filename !== migration.filename ||
          recorded.rows[0].checksum !== migration.checksum
        ) {
          fail("MIGRATION_LEDGER_VERIFICATION_FAILED");
        }
        await client.query("COMMIT");
        transactionStarted = false;
        execution.committed.push(migration.filename);
        execution.notAttempted = migrations
          .slice(index + 1)
          .map(({ filename }) => filename);
      } catch (error) {
        if (transactionStarted) {
          try {
            await client.query("ROLLBACK");
          } catch {
            // Preserve the first governed failure.
          }
          transactionStarted = false;
        }
        execution.failedMigration = migration.filename;
        executionFailure =
          error instanceof RunnerFailure
            ? error.code
            : "MIGRATION_EXECUTION_FAILED";
        break;
      }
    }
  } finally {
    if (client && typeof client.release === "function") {
      try {
        client.release();
      } catch {
        // Resource details are intentionally suppressed.
      }
    }
    if (pool && typeof pool.end === "function") {
      try {
        await pool.end();
      } catch {
        if (!executionFailure) executionFailure = "DATABASE_RESOURCE_RELEASE_FAILED";
      }
    }
  }

  if (executionFailure) {
    return failureResult({
      code: executionFailure,
      target,
      mutationStarted,
      execution,
      preflight,
    });
  }

  let postflightReport;
  try {
    postflightReport = await inspect(
      inspectionOptions(env, options.postInspectionPoolFactory)
    );
  } catch {
    return failureResult({
      code: "POSTFLIGHT_INSPECTION_FAILED",
      target,
      mutationStarted,
      execution,
      preflight,
    });
  }
  const postflight = summarizeInspection(postflightReport);
  if (!isAlreadyApplied(postflight)) {
    return failureResult({
      code: "POSTFLIGHT_STATE_INVALID",
      target,
      mutationStarted,
      execution,
      preflight,
      postflight,
    });
  }

  return {
    success: true,
    decision: "APPLIED_AND_VERIFIED",
    code: "PRODUCTION_EMERGENCY_MIGRATIONS_APPLIED",
    target,
    migrations: publicMigrations(migrations),
    preflight,
    execution,
    postflight,
    mutationStarted,
  };
}

function isValidCliResult(result) {
  return (
    result &&
    typeof result === "object" &&
    typeof result.success === "boolean" &&
    ["APPLIED_AND_VERIFIED", "ALREADY_APPLIED", "FAIL"].includes(
      result.decision
    ) &&
    typeof result.code === "string" &&
    typeof result.mutationStarted === "boolean"
  );
}

function exitCodeForResult(result) {
  if (result.success && result.decision === "APPLIED_AND_VERIFIED") return 0;
  if (result.success && result.decision === "ALREADY_APPLIED") return 2;
  return 1;
}

async function runCli(options = {}) {
  const env = options.env || process.env;
  const run = options.run || runProductionEmergencyMigrations;
  const write = options.write || ((value) => process.stdout.write(value));
  let result;
  try {
    result = await run({ ...options, env });
    if (!isValidCliResult(result)) {
      result = failureResult({
        code: "RUNNER_RESULT_INVALID",
        target: authorizeExecution(env).target,
      });
    }
  } catch {
    result = failureResult({
      code: "RUNNER_UNEXPECTED_FAILURE",
      target: authorizeExecution(env).target,
    });
  }
  write(`${JSON.stringify(result)}\n`);
  return exitCodeForResult(result);
}

if (require.main === module) {
  runCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}

module.exports = Object.freeze({
  APPROVED_MIGRATIONS,
  REQUIRED_CONFIRMATIONS,
  authorizeExecution,
  inspectMigrationSqlScope,
  loadApprovedMigrations,
  runCli,
  runProductionEmergencyMigrations,
  validatePinnedManifest,
});
