"use strict";

const assert = require("node:assert/strict");
const {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const test = require("node:test");

const runner = require("../scripts/run-production-emergency-migrations");
const genericRunner = require("../scripts/run-migrations");

const REPOSITORY_ROOT = path.join(__dirname, "..");
const MIGRATIONS_DIRECTORY = path.join(REPOSITORY_ROOT, "migrations");
const RUNNER_PATH = path.join(
  REPOSITORY_ROOT,
  "scripts",
  "run-production-emergency-migrations.js"
);
const README_PATH = path.join(MIGRATIONS_DIRECTORY, "README.md");
const PACKAGE_PATH = path.join(REPOSITORY_ROOT, "package.json");

const SAFE_ENV = Object.freeze({
  NODE_ENV: "production",
  RAILWAY_PROJECT_NAME: "profound-magic",
  RAILWAY_ENVIRONMENT_NAME: "production",
  RAILWAY_SERVICE_NAME: "athletic-rebirth",
  CONFIRM_PRODUCTION_EMERGENCY_MIGRATION: "YES",
  CONFIRM_PRODUCTION_TARGET:
    "profound-magic/production/athletic-rebirth",
  CONFIRM_EMERGENCY_MIGRATION_CHAIN:
    "202607230001-202607250001",
  CONFIRM_PRODUCTION_MUTATION: "EXECUTE",
  DATABASE_URL:
    "postgresql://runner:private-password@postgres.railway.internal/railway",
});

const APPROVED_FILENAMES = runner.APPROVED_MIGRATIONS.map(
  ({ filename }) => filename
);
const LOADED_MIGRATIONS = runner.loadApprovedMigrations();

function absentSchema() {
  return {
    classification: "ABSENT",
    foundationComplete: false,
    dispatchComplete: false,
    singleActiveComplete: false,
    emergencyTableExists: false,
    safetyTableExists: false,
    unsupportedStatuses: [],
    relationship: {
      emergencyRequestColumn: false,
      sourceConstraint: false,
      singleActiveIndex: false,
    },
    dispatchColumns: {
      en_route_at: false,
      arrived_at: false,
      work_started_at: false,
      completed_at: false,
    },
  };
}

function completeSchema() {
  return {
    classification: "COMPLETE",
    foundationComplete: true,
    dispatchComplete: true,
    singleActiveComplete: true,
    emergencyTableExists: true,
    safetyTableExists: true,
    unsupportedStatuses: [],
    relationship: {
      emergencyRequestColumn: true,
      sourceConstraint: true,
      singleActiveIndex: true,
    },
    dispatchColumns: {
      en_route_at: true,
      arrived_at: true,
      work_started_at: true,
      completed_at: true,
    },
  };
}

function absentReport(overrides = {}) {
  return {
    success: true,
    decision: "PASS_READY_FOR_MIGRATION_PLANNING",
    code: "PRODUCTION_EMERGENCY_MIGRATIONS_MISSING",
    readOnly: true,
    schema: absentSchema(),
    ledger: {
      entries: [],
      missing: [...APPROVED_FILENAMES],
      checksumDrift: [],
      duplicateFilenames: [],
      allRecorded: false,
      allChecksumsMatch: true,
    },
    ...overrides,
  };
}

function completeReport(overrides = {}) {
  return {
    success: true,
    decision: "ALREADY_APPLIED",
    code: "PRODUCTION_EMERGENCY_READY",
    readOnly: true,
    schema: completeSchema(),
    ledger: {
      entries: runner.APPROVED_MIGRATIONS.map((migration) => ({
        filename: migration.filename,
        checksum: migration.checksum,
      })),
      missing: [],
      checksumDrift: [],
      duplicateFilenames: [],
      allRecorded: true,
      allChecksumsMatch: true,
    },
    ...overrides,
  };
}

function sequenceInspector(reports) {
  const calls = [];
  const inspect = async (options) => {
    calls.push(options);
    return reports[Math.min(calls.length - 1, reports.length - 1)];
  };
  inspect.calls = calls;
  return inspect;
}

function createExecutionPool({
  failMigrationIndex = -1,
  failVerificationIndex = -1,
  failLedgerIndex = -1,
  connectFailure = false,
  rawError = "private database failure",
} = {}) {
  const calls = [];
  const ledger = new Map();
  const resources = {
    connectCount: 0,
    releaseCount: 0,
    endCount: 0,
  };
  const migrationSqlIndex = new Map(
    LOADED_MIGRATIONS.map((migration, index) => [migration.sql, index])
  );
  const verificationSqlIndex = new Map(
    LOADED_MIGRATIONS.map((migration, index) => [
      migration.verificationSql,
      index,
    ])
  );

  const client = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      if (migrationSqlIndex.has(sql)) {
        if (migrationSqlIndex.get(sql) === failMigrationIndex) {
          throw new Error(rawError);
        }
        return { rows: [] };
      }
      if (verificationSqlIndex.has(sql)) {
        return {
          rows: [
            {
              verified:
                verificationSqlIndex.get(sql) !== failVerificationIndex,
            },
          ],
        };
      }
      if (
        normalized.startsWith("SELECT filename, checksum") &&
        normalized.includes("FROM schema_migrations")
      ) {
        const row = ledger.get(values[0]);
        return { rows: row ? [row] : [] };
      }
      if (normalized.startsWith("INSERT INTO schema_migrations")) {
        const index = APPROVED_FILENAMES.indexOf(values[0]);
        if (index === failLedgerIndex) throw new Error(rawError);
        ledger.set(values[0], {
          filename: values[0],
          checksum: values[1],
          execution_target: values[2],
          applied_at: "2026-07-26T00:00:00.000Z",
        });
        return { rows: [] };
      }
      return { rows: [] };
    },
    release() {
      resources.releaseCount += 1;
    },
  };

  const pool = {
    async connect() {
      resources.connectCount += 1;
      if (connectFailure) throw new Error(rawError);
      return client;
    },
    async end() {
      resources.endCount += 1;
    },
  };

  return {
    calls,
    ledger,
    resources,
    factory: () => pool,
  };
}

function createFixture() {
  const directory = realpathSync(
    mkdtempSync(
      path.join(tmpdir(), "meetro-production-emergency-")
    )
  );
  for (const migration of runner.APPROVED_MIGRATIONS) {
    copyFileSync(
      path.join(MIGRATIONS_DIRECTORY, migration.filename),
      path.join(directory, migration.filename)
    );
  }
  return directory;
}

function mutationCalls(pool) {
  return pool.calls.filter(({ sql }) =>
    /\b(INSERT|ALTER|CREATE|DROP|TRUNCATE|DELETE|UPDATE)\b/i.test(
      String(sql).replace(/--[^\r\n]*/g, " ")
    )
  );
}

test("module import is inert and exports only the governed API", () => {
  assert.deepEqual(Object.keys(runner).sort(), [
    "APPROVED_MIGRATIONS",
    "REQUIRED_CONFIRMATIONS",
    "authorizeExecution",
    "inspectMigrationSqlScope",
    "loadApprovedMigrations",
    "runCli",
    "runProductionEmergencyMigrations",
    "validatePinnedManifest",
  ]);
  const source = readFileSync(RUNNER_PATH, "utf8");
  assert.match(source, /if \(require\.main === module\)/);
  assert.doesNotMatch(source, /node:child_process|require\(["']child_process/);
  assert.doesNotMatch(source, /\bpsql\b|railway\s+ssh/i);
});

test("exact production identity and confirmations authorize safely", () => {
  const result = runner.authorizeExecution(SAFE_ENV);
  assert.equal(result.authorized, true);
  assert.equal(result.target.classification, "production");
  assert.deepEqual(result.target, {
    classification: "production",
    protocol: "postgresql",
    hostType: "railway-private",
    projectName: "profound-magic",
    environmentName: "production",
    serviceName: "athletic-rebirth",
  });
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /private-password|postgres\.railway\.internal/);
});

test("authorization rejects every identity, confirmation, and URL mismatch", () => {
  const cases = [
    ["missing confirmation", "CONFIRM_PRODUCTION_MUTATION", undefined],
    ["wrong confirmation", "CONFIRM_PRODUCTION_MUTATION", "execute"],
    ["staging", "RAILWAY_ENVIRONMENT_NAME", "staging"],
    ["development", "NODE_ENV", "development"],
    ["test", "NODE_ENV", "test"],
    ["local", "DATABASE_URL", "postgresql://user:pass@localhost/db"],
    ["wrong project", "RAILWAY_PROJECT_NAME", "other-project"],
    ["wrong service", "RAILWAY_SERVICE_NAME", "other-service"],
    [
      "hostname as service",
      "RAILWAY_SERVICE_NAME",
      "athletic-rebirth-production-0a28.up.railway.app",
    ],
    ["malformed URL", "DATABASE_URL", "not-a-url"],
    ["non-PostgreSQL URL", "DATABASE_URL", "https://user:pass@example.com/db"],
    ["credential-less URL", "DATABASE_URL", "postgresql://example.com/db"],
    ["missing URL", "DATABASE_URL", undefined],
  ];
  for (const [label, name, value] of cases) {
    const env = { ...SAFE_ENV };
    if (value === undefined) delete env[name];
    else env[name] = value;
    assert.equal(
      runner.authorizeExecution(env).authorized,
      false,
      label
    );
  }
});

test("authorization failure occurs before inspection or pool construction", async () => {
  let inspectionCalls = 0;
  let poolCalls = 0;
  const result = await runner.runProductionEmergencyMigrations({
    env: { ...SAFE_ENV, RAILWAY_PROJECT_NAME: "wrong" },
    inspect: async () => {
      inspectionCalls += 1;
    },
    poolFactory: () => {
      poolCalls += 1;
    },
  });
  assert.equal(result.success, false);
  assert.equal(inspectionCalls, 0);
  assert.equal(poolCalls, 0);
  assert.doesNotMatch(JSON.stringify(result), /private-password|railway\.internal/);
});

test("pinned manifest and exact five local files pass", () => {
  assert.equal(runner.validatePinnedManifest(), true);
  const migrations = runner.loadApprovedMigrations();
  assert.deepEqual(
    migrations.map(({ filename, checksum }) => ({ filename, checksum })),
    runner.APPROVED_MIGRATIONS.map(({ filename, checksum }) => ({
      filename,
      checksum,
    }))
  );
});

test("reordered and duplicated manifests fail closed", () => {
  assert.throws(
    () => runner.validatePinnedManifest([...runner.APPROVED_MIGRATIONS].reverse()),
    { code: "MIGRATION_MANIFEST_MISMATCH" }
  );
  const duplicate = [...runner.APPROVED_MIGRATIONS];
  duplicate[1] = duplicate[0];
  assert.throws(() => runner.validatePinnedManifest(duplicate), {
    code: "MIGRATION_MANIFEST_MISMATCH",
  });
});

test("missing, changed, malformed, and symlinked migration files fail", (t) => {
  const missing = createFixture();
  const changed = createFixture();
  const malformed = createFixture();
  const escaped = createFixture();
  t.after(() => {
    for (const directory of [missing, changed, malformed, escaped]) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  unlinkSync(path.join(missing, APPROVED_FILENAMES[0]));
  assert.throws(
    () => runner.loadApprovedMigrations({ migrationsDirectory: missing }),
    { code: "MIGRATION_FILE_MISSING_OR_DUPLICATE" }
  );

  writeFileSync(
    path.join(changed, APPROVED_FILENAMES[0]),
    `${readFileSync(path.join(changed, APPROVED_FILENAMES[0]), "utf8")}\n`
  );
  assert.throws(
    () => runner.loadApprovedMigrations({ migrationsDirectory: changed }),
    { code: "MIGRATION_CHECKSUM_MISMATCH" }
  );

  writeFileSync(path.join(malformed, "bad migration.sql"), "SELECT 1");
  assert.throws(
    () => runner.loadApprovedMigrations({ migrationsDirectory: malformed }),
    { code: "MIGRATION_FILENAME_INVALID" }
  );

  const outside = path.join(tmpdir(), `outside-${process.pid}.sql`);
  writeFileSync(outside, readFileSync(path.join(escaped, APPROVED_FILENAMES[0])));
  unlinkSync(path.join(escaped, APPROVED_FILENAMES[0]));
  symlinkSync(outside, path.join(escaped, APPROVED_FILENAMES[0]));
  t.after(() => rmSync(outside, { force: true }));
  assert.throws(
    () => runner.loadApprovedMigrations({ migrationsDirectory: escaped }),
    { code: "MIGRATION_PATH_ESCAPE" }
  );
});

test("extra migrations cannot enter the pinned execution collection", (t) => {
  const directory = createFixture();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(
    path.join(directory, "202607260001_unrelated_valid_migration.sql"),
    "CREATE TABLE unrelated_fixture (id INTEGER);"
  );
  const loaded = runner.loadApprovedMigrations({ migrationsDirectory: directory });
  assert.deepEqual(
    loaded.map(({ filename }) => filename),
    APPROVED_FILENAMES
  );
});

test("destructive and out-of-scope SQL are rejected before connection", () => {
  const migration = LOADED_MIGRATIONS[0];
  assert.throws(
    () =>
      runner.inspectMigrationSqlScope(
        migration.filename,
        `${migration.sql}\nTRUNCATE users;`
      ),
    { code: "MIGRATION_SQL_FORBIDDEN" }
  );
  assert.throws(
    () => runner.inspectMigrationSqlScope(migration.filename, "SELECT 1"),
    { code: "MIGRATION_SQL_SCOPE_MISMATCH" }
  );
});

test("exact absent preflight executes five transactions in order", async () => {
  const inspect = sequenceInspector([absentReport(), completeReport()]);
  const pool = createExecutionPool();
  const result = await runner.runProductionEmergencyMigrations({
    env: SAFE_ENV,
    inspect,
    poolFactory: pool.factory,
  });

  assert.equal(result.success, true);
  assert.equal(result.decision, "APPLIED_AND_VERIFIED");
  assert.equal(result.mutationStarted, true);
  assert.deepEqual(result.execution.committed, APPROVED_FILENAMES);
  assert.deepEqual(result.execution.notAttempted, []);
  assert.equal(inspect.calls.length, 2);
  assert.equal(
    inspect.calls[0].env.CONFIRM_PRODUCTION_EMERGENCY_INSPECTION,
    "YES"
  );
  assert.deepEqual(pool.resources, {
    connectCount: 1,
    releaseCount: 1,
    endCount: 1,
  });

  const sqlCalls = pool.calls.map(({ sql }) => sql);
  assert.equal(sqlCalls.filter((sql) => sql === "BEGIN").length, 5);
  assert.equal(sqlCalls.filter((sql) => sql === "COMMIT").length, 5);
  assert.equal(sqlCalls.filter((sql) => sql === "ROLLBACK").length, 0);
  for (const migration of LOADED_MIGRATIONS) {
    const migrationIndex = sqlCalls.indexOf(migration.sql);
    const verificationIndex = sqlCalls.indexOf(migration.verificationSql);
    const ledgerIndex = pool.calls.findIndex(
      ({ sql, values }) =>
        /INSERT INTO schema_migrations/.test(sql) &&
        values[0] === migration.filename
    );
    const commitIndex = sqlCalls.indexOf("COMMIT", ledgerIndex);
    assert.ok(migrationIndex < verificationIndex);
    assert.ok(verificationIndex < ledgerIndex);
    assert.ok(ledgerIndex < commitIndex);
  }
});

test("migration failure rolls back current work and stops later files", async () => {
  const pool = createExecutionPool({
    failMigrationIndex: 1,
    rawError:
      "postgresql://user:private-password@postgres.railway.internal/railway",
  });
  const result = await runner.runProductionEmergencyMigrations({
    env: SAFE_ENV,
    inspect: sequenceInspector([absentReport()]),
    poolFactory: pool.factory,
  });
  assert.equal(result.success, false);
  assert.equal(result.code, "MIGRATION_EXECUTION_FAILED");
  assert.equal(result.mutationStarted, true);
  assert.deepEqual(result.execution.committed, [APPROVED_FILENAMES[0]]);
  assert.equal(result.execution.failedMigration, APPROVED_FILENAMES[1]);
  assert.deepEqual(result.execution.notAttempted, APPROVED_FILENAMES.slice(1));
  assert.equal(pool.calls.filter(({ sql }) => sql === "ROLLBACK").length, 1);
  assert.equal(
    pool.calls.some(({ sql }) => sql === LOADED_MIGRATIONS[2].sql),
    false
  );
  assert.doesNotMatch(
    JSON.stringify(result),
    /private-password|postgres\.railway\.internal/
  );
  assert.equal(pool.resources.releaseCount, 1);
  assert.equal(pool.resources.endCount, 1);
});

test("verification and ledger failures never commit the current migration", async () => {
  for (const options of [
    { failVerificationIndex: 0, code: "MIGRATION_EFFECT_VERIFICATION_FAILED" },
    { failLedgerIndex: 0, code: "MIGRATION_EXECUTION_FAILED" },
  ]) {
    const pool = createExecutionPool(options);
    const result = await runner.runProductionEmergencyMigrations({
      env: SAFE_ENV,
      inspect: sequenceInspector([absentReport()]),
      poolFactory: pool.factory,
    });
    assert.equal(result.code, options.code);
    assert.deepEqual(result.execution.committed, []);
    assert.equal(pool.calls.filter(({ sql }) => sql === "COMMIT").length, 0);
    assert.equal(pool.calls.filter(({ sql }) => sql === "ROLLBACK").length, 1);
  }
});

test("connection failure is sanitized and reports no mutation", async () => {
  const pool = createExecutionPool({
    connectFailure: true,
    rawError: "private-password postgres.railway.internal",
  });
  const result = await runner.runProductionEmergencyMigrations({
    env: SAFE_ENV,
    inspect: sequenceInspector([absentReport()]),
    poolFactory: pool.factory,
  });
  assert.equal(result.code, "DATABASE_CONNECTION_FAILED");
  assert.equal(result.mutationStarted, false);
  assert.doesNotMatch(JSON.stringify(result), /private-password|railway\.internal/);
  assert.equal(pool.resources.endCount, 1);
});

test("partial, conflicting, and unsupported preflight states block mutation", async () => {
  const cases = [
    absentReport({
      success: false,
      decision: "BLOCKED_PARTIAL_OR_UNRECORDED_SCHEMA",
      code: "PRODUCTION_EMERGENCY_SCHEMA_REQUIRES_REVIEW",
      schema: { ...absentSchema(), classification: "PARTIAL", emergencyTableExists: true },
    }),
    absentReport({
      ledger: {
        ...absentReport().ledger,
        entries: [runner.APPROVED_MIGRATIONS[0]],
      },
    }),
    absentReport({
      ledger: {
        ...absentReport().ledger,
        duplicateFilenames: [APPROVED_FILENAMES[0]],
      },
    }),
    absentReport({
      ledger: {
        ...absentReport().ledger,
        checksumDrift: [APPROVED_FILENAMES[0]],
      },
    }),
    absentReport({
      schema: { ...absentSchema(), unsupportedStatuses: ["unexpected"] },
    }),
    completeReport({
      success: false,
      decision: "BLOCKED_PARTIAL_OR_UNRECORDED_SCHEMA",
      code: "PRODUCTION_EMERGENCY_SCHEMA_REQUIRES_REVIEW",
      ledger: absentReport().ledger,
    }),
    {
      success: false,
      decision: "FAIL",
      code: "INSPECTION_TARGET_IDENTITY_MISMATCH",
      readOnly: true,
    },
  ];

  for (const report of cases) {
    let poolCalls = 0;
    const result = await runner.runProductionEmergencyMigrations({
      env: SAFE_ENV,
      inspect: sequenceInspector([report]),
      poolFactory: () => {
        poolCalls += 1;
      },
    });
    assert.equal(result.code, "PREFLIGHT_STATE_BLOCKED");
    assert.equal(result.mutationStarted, false);
    assert.equal(poolCalls, 0);
  }
});

test("already-applied state is idempotent and constructs no execution pool", async () => {
  let poolCalls = 0;
  const result = await runner.runProductionEmergencyMigrations({
    env: SAFE_ENV,
    inspect: sequenceInspector([completeReport()]),
    poolFactory: () => {
      poolCalls += 1;
    },
  });
  assert.equal(result.success, true);
  assert.equal(result.decision, "ALREADY_APPLIED");
  assert.equal(
    result.code,
    "PRODUCTION_EMERGENCY_MIGRATIONS_ALREADY_APPLIED"
  );
  assert.equal(result.mutationStarted, false);
  assert.deepEqual(result.execution.committed, []);
  assert.equal(poolCalls, 0);
});

test("postflight must prove complete canonical state", async () => {
  const pool = createExecutionPool();
  const result = await runner.runProductionEmergencyMigrations({
    env: SAFE_ENV,
    inspect: sequenceInspector([
      absentReport(),
      absentReport({
        success: false,
        decision: "BLOCKED_PARTIAL_OR_UNRECORDED_SCHEMA",
        code: "PRODUCTION_EMERGENCY_SCHEMA_REQUIRES_REVIEW",
      }),
    ]),
    poolFactory: pool.factory,
  });
  assert.equal(result.code, "POSTFLIGHT_STATE_INVALID");
  assert.deepEqual(result.execution.committed, APPROVED_FILENAMES);
  assert.equal(
    pool.calls.some(({ sql }) =>
      /\b(DELETE\s+FROM|TRUNCATE|DROP\s+(TABLE|SCHEMA|DATABASE))\b/i.test(
        sql
      )
    ),
    false
  );
});

test("CLI emits exactly one safe JSON object with exit codes 0, 1, and 2", async () => {
  const cases = [
    [
      0,
      {
        success: true,
        decision: "APPLIED_AND_VERIFIED",
        code: "PRODUCTION_EMERGENCY_MIGRATIONS_APPLIED",
        mutationStarted: true,
      },
    ],
    [
      2,
      {
        success: true,
        decision: "ALREADY_APPLIED",
        code: "PRODUCTION_EMERGENCY_MIGRATIONS_ALREADY_APPLIED",
        mutationStarted: false,
      },
    ],
    [
      1,
      {
        success: false,
        decision: "FAIL",
        code: "SAFE_FAILURE",
        mutationStarted: false,
      },
    ],
  ];
  for (const [expectedExit, result] of cases) {
    const output = [];
    const exitCode = await runner.runCli({
      env: SAFE_ENV,
      run: async () => result,
      write: (value) => output.push(value),
    });
    assert.equal(exitCode, expectedExit);
    assert.equal(output.length, 1);
    assert.deepEqual(JSON.parse(output[0]), result);
  }
});

test("CLI normalizes malformed results and unexpected exceptions", async () => {
  for (const run of [
    async () => ({ malformed: true }),
    async () => {
      throw new Error("private-password raw SQL DROP TABLE users");
    },
  ]) {
    const output = [];
    const exitCode = await runner.runCli({
      env: SAFE_ENV,
      run,
      write: (value) => output.push(value),
    });
    assert.equal(exitCode, 1);
    assert.equal(output.length, 1);
    const serialized = output[0];
    assert.doesNotMatch(
      serialized,
      /private-password|DROP TABLE|postgres\.railway\.internal/
    );
    assert.equal(JSON.parse(serialized).decision, "FAIL");
  }
});

test("package and README preserve narrow production governance", () => {
  const packageJson = JSON.parse(readFileSync(PACKAGE_PATH, "utf8"));
  assert.equal(
    packageJson.scripts["migrate:production:emergency"],
    undefined
  );
  assert.equal(
    packageJson.scripts.test,
    "node --test test/*.test.js test/characterization/*.test.js"
  );

  const readme = readFileSync(README_PATH, "utf8");
  assert.match(readme, /dedicated Emergency production runner/i);
  assert.match(readme, /not a general production runner/i);
  assert.match(
    readme,
    /inside the approved Railway production application\s+container/i
  );

  const genericProduction = genericRunner.inspectMigrationExecutionTarget({
    DATABASE_URL: "postgresql://user:pass@example.com/meetro_production",
    MIGRATION_TARGET: "production",
    CONFIRM_MIGRATION_TARGET: "production",
  });
  assert.equal(genericProduction.safe, false);
});

test("mock execution contains no unapproved application-data mutation", async () => {
  const pool = createExecutionPool();
  await runner.runProductionEmergencyMigrations({
    env: SAFE_ENV,
    inspect: sequenceInspector([absentReport(), completeReport()]),
    poolFactory: pool.factory,
  });
  const mutations = mutationCalls(pool);
  assert.equal(
    mutations.some(({ sql }) => /\b(DELETE FROM|TRUNCATE|DROP DATABASE)\b/i.test(sql)),
    false
  );
});
