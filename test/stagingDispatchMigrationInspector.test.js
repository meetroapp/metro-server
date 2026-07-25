"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {
  readFileSync,
} = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  classifyInspectionTarget,
  inspectDispatchMigrationState,
  runInspectionCli,
  sanitizeTargetMetadata,
  validateInspectionEnvironment,
} = require("../scripts/inspect-staging-dispatch-migration");

const repositoryRoot = path.join(__dirname, "..");
const migrationsDirectory = path.join(
  repositoryRoot,
  "migrations"
);
const inspectorPath = path.join(
  repositoryRoot,
  "scripts",
  "inspect-staging-dispatch-migration.js"
);
const migrationFilename =
  "202607250001_add_emergency_dispatch_lifecycle.sql";
const approvedChecksum =
  "aa39d8311f8a73970e20069dad8fd1e4a4bfa0b65acc7e09cffaa0e33be21462";
const prerequisites = [
  "202607230001_create_emergency_requests.sql",
  "202607230002_add_emergency_relationship_source.sql",
  "202607230003_create_emergency_safety_assessments.sql",
  "202607240001_add_single_active_emergency_relationship.sql",
];
const legacyStatuses = [
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
];
const dispatchStatuses = [
  "professional_en_route",
  "professional_arrived",
  "work_in_progress",
  "completed",
];
const allStatuses = [
  ...legacyStatuses,
  ...dispatchStatuses,
];
const dispatchColumns = [
  "en_route_at",
  "arrived_at",
  "work_started_at",
  "completed_at",
];

function checksum(value) {
  return crypto
    .createHash("sha256")
    .update(value)
    .digest("hex");
}

function localMigrationChecksum(filename) {
  return checksum(
    readFileSync(
      path.join(migrationsDirectory, filename),
      "utf8"
    )
  );
}

function validEnvironment(overrides = {}) {
  return {
    DATABASE_URL:
      "postgresql://private-user:private-password@containers.railway.internal/railway?sslmode=require&token=private-token",
    NODE_ENV: "staging",
    RAILWAY_PROJECT_NAME: "profound-magic",
    RAILWAY_ENVIRONMENT_NAME: "staging",
    RAILWAY_SERVICE_NAME: "athletic-rebirth",
    CONFIRM_STAGING_DISPATCH_INSPECTION: "YES",
    ...overrides,
  };
}

function prerequisiteLedgerRows() {
  return prerequisites.map((filename) => ({
    filename,
    checksum: localMigrationChecksum(filename),
    applied_at: "2026-07-24T00:00:00.000Z",
  }));
}

function statusConstraint(statuses = legacyStatuses) {
  const values = statuses
    .map((status) => `'${status}'::text`)
    .join(", ");
  return {
    constraint_name:
      "emergency_requests_status_check",
    constraint_type: "CHECK",
    constraint_definition:
      `CHECK ((status = ANY (ARRAY[${values}])))`,
  };
}

function primaryKeyConstraint() {
  return {
    constraint_name:
      "emergency_requests_pkey",
    constraint_type: "PRIMARY KEY",
    constraint_definition: "PRIMARY KEY (id)",
  };
}

function baseColumns() {
  return [
    {
      column_name: "id",
      data_type: "integer",
      is_nullable: "NO",
      column_default:
        "nextval('emergency_requests_id_seq'::regclass)",
    },
    {
      column_name: "status",
      data_type: "text",
      is_nullable: "NO",
      column_default: "'draft'::text",
    },
  ];
}

function completeDispatchColumns(overrides = {}) {
  return dispatchColumns.map((columnName) => ({
    column_name: columnName,
    data_type: "timestamp without time zone",
    is_nullable: "YES",
    column_default: null,
    ...(overrides[columnName] || {}),
  }));
}

function defaultDatabaseState(overrides = {}) {
  return {
    databaseName: "railway",
    ledgerExists: true,
    ledgerRows: prerequisiteLedgerRows(),
    emergencyTableExists: true,
    columns: baseColumns(),
    constraints: [
      primaryKeyConstraint(),
      statusConstraint(),
    ],
    indexes: [
      {
        index_name: "emergency_requests_pkey",
        index_definition:
          "UNIQUE INDEX emergency_requests_pkey",
      },
    ],
    rowCount: "2",
    statusCounts: [
      { status: "assigned", count: "1" },
      { status: "draft", count: "1" },
    ],
    ...overrides,
  };
}

function normalizeSql(value) {
  return String(value)
    .replace(/\s+/g, " ")
    .trim();
}

function queryStage(sql) {
  if (sql === "BEGIN TRANSACTION READ ONLY") {
    return "begin";
  }
  if (sql === "ROLLBACK") return "rollback";
  if (sql.includes("current_database()")) {
    return "databaseIdentity";
  }
  if (
    sql.includes(
      "to_regclass('public.schema_migrations')"
    )
  ) {
    return "ledgerExists";
  }
  if (sql.includes("FROM schema_migrations")) {
    return "ledgerRows";
  }
  if (
    sql.includes(
      "to_regclass('public.emergency_requests')"
    )
  ) {
    return "emergencyTableExists";
  }
  if (
    sql.includes(
      "FROM information_schema.columns"
    )
  ) {
    return "emergencyColumns";
  }
  if (
    sql.includes(
      "FROM information_schema.table_constraints"
    )
  ) {
    return "emergencyConstraints";
  }
  if (sql.includes("FROM pg_catalog.pg_indexes")) {
    return "emergencyIndexes";
  }
  if (sql.includes("COUNT(*)::bigint AS row_count")) {
    return "emergencyRowCount";
  }
  if (sql.includes("GROUP BY status")) {
    return "emergencyStatusCounts";
  }
  return "unknown";
}

function createDatabaseHarness(
  state = defaultDatabaseState(),
  options = {}
) {
  const calls = [];
  let releases = 0;
  let poolEnds = 0;
  const client = {
    async query(text) {
      const sql = normalizeSql(text);
      const stage = queryStage(sql);
      calls.push({ stage, sql });

      if (options.failAt === stage) {
        throw new Error(
          "postgres://private-user:private-password@private-host/private-db"
        );
      }

      if (stage === "databaseIdentity") {
        return {
          rows: [
            {
              database_name: state.databaseName,
              password: "must-not-escape",
            },
          ],
        };
      }
      if (stage === "ledgerExists") {
        return {
          rows: [{ exists: state.ledgerExists }],
        };
      }
      if (stage === "ledgerRows") {
        return { rows: state.ledgerRows };
      }
      if (stage === "emergencyTableExists") {
        return {
          rows: [
            {
              exists: state.emergencyTableExists,
            },
          ],
        };
      }
      if (stage === "emergencyColumns") {
        return { rows: state.columns };
      }
      if (stage === "emergencyConstraints") {
        return { rows: state.constraints };
      }
      if (stage === "emergencyIndexes") {
        return { rows: state.indexes };
      }
      if (stage === "emergencyRowCount") {
        return {
          rows: [{ row_count: state.rowCount }],
        };
      }
      if (stage === "emergencyStatusCounts") {
        return { rows: state.statusCounts };
      }
      return { rows: [] };
    },
    release() {
      releases += 1;
      if (options.failRelease) {
        throw new Error(
          "private release failure"
        );
      }
    },
  };
  const pool = {
    async connect() {
      calls.push({
        stage: "connect",
        sql: "",
      });
      if (options.failConnect) {
        throw new Error(
          "private connection failure"
        );
      }
      return client;
    },
    async end() {
      poolEnds += 1;
      if (options.failPoolEnd) {
        throw new Error(
          "private pool failure"
        );
      }
    },
  };

  return {
    calls,
    client,
    poolFactory() {
      return pool;
    },
    get releases() {
      return releases;
    },
    get poolEnds() {
      return poolEnds;
    },
  };
}

async function inspectState(
  state = defaultDatabaseState(),
  harnessOptions = {},
  inspectOptions = {}
) {
  const harness = createDatabaseHarness(
    state,
    harnessOptions
  );
  const report =
    await inspectDispatchMigrationState({
      env: validEnvironment(),
      poolFactory: harness.poolFactory,
      ...inspectOptions,
    });
  return { harness, report };
}

test("module import is inert and exports only the narrow inspection API", () => {
  const imported = require(
    "../scripts/inspect-staging-dispatch-migration"
  );

  assert.deepEqual(
    Object.keys(imported).sort(),
    [
      "classifyInspectionTarget",
      "inspectDispatchMigrationState",
      "runInspectionCli",
      "sanitizeTargetMetadata",
      "validateInspectionEnvironment",
    ].sort()
  );
  assert.equal(process.exitCode, undefined);
});

test("target classification accepts only exact staging identity", () => {
  assert.equal(
    classifyInspectionTarget(validEnvironment()),
    "staging"
  );
  assert.equal(
    classifyInspectionTarget(
      validEnvironment({
        DATABASE_URL:
          "postgresql://user:pass@roundhouse.proxy.rlwy.net/meetro_staging",
      })
    ),
    "staging"
  );

  const cases = [
    [{ DATABASE_URL: "" }, "invalid"],
    [
      validEnvironment({
        DATABASE_URL: "not-a-url",
      }),
      "invalid",
    ],
    [
      validEnvironment({
        DATABASE_URL:
          "mysql://user:pass@containers.railway.internal/railway",
      }),
      "invalid",
    ],
    [
      validEnvironment({
        RAILWAY_ENVIRONMENT_NAME: "production",
      }),
      "rejected-railway-production",
    ],
    [
      validEnvironment({
        RAILWAY_SERVICE_NAME:
          "athletic-rebirth-production-0a28",
      }),
      "rejected-railway-production",
    ],
    [
      validEnvironment({
        RAILWAY_PROJECT_NAME:
          "profound-magic-production",
      }),
      "rejected-production",
    ],
    [
      validEnvironment({
        DATABASE_URL:
          "postgresql://user:pass@containers.railway.internal/meetro_prod",
      }),
      "rejected-production",
    ],
    [
      validEnvironment({
        DATABASE_URL:
          "postgresql://user:pass@localhost/railway",
      }),
      "rejected-local",
    ],
    [
      validEnvironment({
        DATABASE_URL:
          "postgresql://user:pass@db.example.test/railway",
      }),
      "rejected-unknown",
    ],
    [
      validEnvironment({
        RAILWAY_PROJECT_NAME: "another-project",
      }),
      "rejected-unknown",
    ],
    [
      validEnvironment({
        CONFIRM_STAGING_DISPATCH_INSPECTION:
          undefined,
      }),
      "rejected-unknown",
    ],
    [
      validEnvironment({
        CONFIRM_STAGING_DISPATCH_INSPECTION:
          "yes",
      }),
      "rejected-unknown",
    ],
  ];

  for (const [env, expected] of cases) {
    assert.equal(
      classifyInspectionTarget(env),
      expected
    );
  }
});

test("environment validation returns stable target and confirmation failures", () => {
  assert.deepEqual(
    validateInspectionEnvironment(
      validEnvironment()
    ).valid,
    true
  );

  const missing = validateInspectionEnvironment({});
  assert.equal(missing.valid, false);
  assert.equal(
    missing.code,
    "INSPECTION_TARGET_INVALID"
  );

  const unconfirmed =
    validateInspectionEnvironment(
      validEnvironment({
        CONFIRM_STAGING_DISPATCH_INSPECTION:
          "NO",
      })
    );
  assert.equal(unconfirmed.valid, false);
  assert.equal(
    unconfirmed.code,
    "INSPECTION_CONFIRMATION_REQUIRED"
  );

  const wrongService =
    validateInspectionEnvironment(
      validEnvironment({
        RAILWAY_SERVICE_NAME: "other",
      })
    );
  assert.equal(wrongService.valid, false);
  assert.equal(
    wrongService.code,
    "INSPECTION_TARGET_NOT_STAGING"
  );
});

test("sanitized target metadata contains no credentials or raw hosts", () => {
  const env = validEnvironment();
  const target = sanitizeTargetMetadata(env);
  const serialized = JSON.stringify(target);

  assert.deepEqual(target, {
    classification: "staging",
    protocol: "postgresql",
    hostType: "railway-private",
    databaseNameClass: "railway-default",
    projectName: "profound-magic",
    environmentName: "staging",
    serviceName: "athletic-rebirth",
  });
  for (const secret of [
    "private-user",
    "private-password",
    "private-token",
    "containers.railway.internal",
    "sslmode",
    "DATABASE_URL",
  ]) {
    assert.equal(
      serialized.includes(secret),
      false
    );
  }
});

test("rejected target metadata does not echo untrusted identity values", () => {
  const target = sanitizeTargetMetadata(
    validEnvironment({
      RAILWAY_PROJECT_NAME:
        "secret-project-token-value",
      RAILWAY_SERVICE_NAME:
        "secret-service-token-value",
    })
  );
  const serialized = JSON.stringify(target);

  assert.equal(target.projectName, "unrecognized");
  assert.equal(target.serviceName, "unrecognized");
  assert.doesNotMatch(
    serialized,
    /secret-project-token-value|secret-service-token-value/
  );
});

test("target rejection occurs before pool construction", async () => {
  let poolCreated = false;
  const report =
    await inspectDispatchMigrationState({
      env: validEnvironment({
        RAILWAY_ENVIRONMENT_NAME: "production",
      }),
      poolFactory() {
        poolCreated = true;
        throw new Error("must not run");
      },
    });

  assert.equal(poolCreated, false);
  assert.equal(
    report.decision,
    "BLOCKED_TARGET_NOT_PROVEN"
  );
  assert.equal(
    report.code,
    "INSPECTION_TARGET_NOT_STAGING"
  );
});

test("local checksum guard permits the reviewed migration", async () => {
  const { harness, report } = await inspectState();

  assert.equal(
    report.migration.localChecksum,
    approvedChecksum
  );
  assert.equal(
    report.migration.checksumMatches,
    true
  );
  assert.equal(
    harness.calls[0].stage,
    "connect"
  );
});

test("changed or missing migration source blocks before connection", async () => {
  for (const mode of ["changed", "missing"]) {
    let poolCreated = false;
    const report =
      await inspectDispatchMigrationState({
        env: validEnvironment(),
        readFile(filePath, encoding) {
          if (
            path.basename(filePath) ===
            migrationFilename
          ) {
            if (mode === "missing") {
              throw new Error("missing");
            }
            return "changed migration";
          }
          return readFileSync(
            filePath,
            encoding
          );
        },
        poolFactory() {
          poolCreated = true;
          throw new Error("must not connect");
        },
      });

    assert.equal(poolCreated, false);
    assert.equal(report.decision, "FAIL");
    assert.equal(
      report.code,
      "MIGRATION_CHECKSUM_MISMATCH"
    );
  }
});

test("successful inspection uses one read-only transaction then rolls back and releases", async () => {
  const { harness, report } = await inspectState();
  const stages = harness.calls.map(
    ({ stage }) => stage
  );

  assert.deepEqual(stages, [
    "connect",
    "begin",
    "databaseIdentity",
    "ledgerExists",
    "ledgerRows",
    "emergencyTableExists",
    "emergencyColumns",
    "emergencyConstraints",
    "emergencyIndexes",
    "emergencyRowCount",
    "emergencyStatusCounts",
    "rollback",
  ]);
  assert.equal(
    harness.calls[1].sql,
    "BEGIN TRANSACTION READ ONLY"
  );
  assert.equal(
    stages.includes("commit"),
    false
  );
  assert.equal(harness.releases, 1);
  assert.equal(harness.poolEnds, 1);
  assert.deepEqual(report.tests, {
    readOnlyTransaction: true,
    rollbackCompleted: true,
  });
});

test("every executed database statement is fixed and read-only", async () => {
  const { harness } = await inspectState();
  const sqlCalls = harness.calls
    .map(({ sql }) => sql)
    .filter(Boolean);

  for (const sql of sqlCalls) {
    assert.match(
      sql,
      /^(?:SELECT|BEGIN TRANSACTION READ ONLY|ROLLBACK)\b/i
    );
    assert.doesNotMatch(
      sql,
      /\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|GRANT|REVOKE|COMMIT)\b/i
    );
  }
});

test("missing and empty ledgers remain blocked without fabrication", async () => {
  const missing = await inspectState(
    defaultDatabaseState({
      ledgerExists: false,
      ledgerRows: [],
    })
  );
  assert.equal(missing.report.ledger.exists, false);
  assert.deepEqual(
    missing.report.ledger.entries,
    []
  );
  assert.equal(
    missing.report.schema.classification,
    "PARTIAL"
  );

  const empty = await inspectState(
    defaultDatabaseState({
      ledgerRows: [],
    })
  );
  assert.equal(empty.report.ledger.exists, true);
  assert.deepEqual(
    empty.report.ledger.prerequisitesMissing,
    prerequisites
  );
  assert.equal(
    empty.report.decision,
    "BLOCKED_PARTIAL_SCHEMA"
  );
});

test("ledger analysis reports prerequisites, latest entry, and missing prerequisites", async () => {
  const rows = prerequisiteLedgerRows();
  const full = await inspectState(
    defaultDatabaseState({
      ledgerRows: rows,
    })
  );
  assert.deepEqual(
    full.report.ledger.prerequisitesPresent,
    prerequisites
  );
  assert.deepEqual(
    full.report.ledger.prerequisitesMissing,
    []
  );
  assert.equal(
    full.report.ledger.latestFilename,
    prerequisites.at(-1)
  );

  const missing = await inspectState(
    defaultDatabaseState({
      ledgerRows: rows.slice(0, -1),
    })
  );
  assert.deepEqual(
    missing.report.ledger.prerequisitesMissing,
    [prerequisites.at(-1)]
  );
  assert.equal(
    missing.report.schema.classification,
    "PARTIAL"
  );
});

test("duplicate ledger names and applied local checksum drift conflict", async () => {
  const duplicate = prerequisiteLedgerRows();
  duplicate.push({ ...duplicate[0] });
  const duplicateResult = await inspectState(
    defaultDatabaseState({
      ledgerRows: duplicate,
    })
  );
  assert.deepEqual(
    duplicateResult.report.ledger
      .duplicateFilenames,
    [prerequisites[0]]
  );
  assert.equal(
    duplicateResult.report.schema.classification,
    "CONFLICTING"
  );
  assert.equal(
    duplicateResult.report.decision,
    "FAIL"
  );

  const drift = prerequisiteLedgerRows();
  drift[0] = {
    ...drift[0],
    checksum: "0".repeat(64),
  };
  const driftResult = await inspectState(
    defaultDatabaseState({
      ledgerRows: drift,
    })
  );
  assert.deepEqual(
    driftResult.report.ledger.checksumDrift,
    [prerequisites[0]]
  );
  assert.equal(
    driftResult.report.schema.classification,
    "CONFLICTING"
  );

  const duplicateTimestamp = [
    ...prerequisiteLedgerRows(),
    {
      filename:
        "202607230001_conflicting_name.sql",
      checksum: "a".repeat(64),
      applied_at: null,
    },
  ];
  const timestampResult = await inspectState(
    defaultDatabaseState({
      ledgerRows: duplicateTimestamp,
    })
  );
  assert.deepEqual(
    timestampResult.report.ledger
      .duplicateTimestampPrefixes,
    ["202607230001"]
  );
  assert.equal(
    timestampResult.report.schema.classification,
    "CONFLICTING"
  );
});

test("malformed ledger metadata is counted but never echoed", async () => {
  const result = await inspectState(
    defaultDatabaseState({
      ledgerRows: [
        ...prerequisiteLedgerRows(),
        {
          filename:
            "secret-ledger-filename-value",
          checksum:
            "secret-ledger-checksum-value",
          applied_at:
            "secret-ledger-date-value",
        },
      ],
    })
  );
  const serialized = JSON.stringify(
    result.report
  );

  assert.equal(
    result.report.ledger.invalidEntries,
    1
  );
  assert.equal(
    result.report.schema.classification,
    "CONFLICTING"
  );
  assert.doesNotMatch(
    serialized,
    /secret-ledger-filename-value|secret-ledger-checksum-value|secret-ledger-date-value/
  );
});

test("dispatch ledger presence and checksum are governed exactly", async () => {
  const matchingRows = [
    ...prerequisiteLedgerRows(),
    {
      filename: migrationFilename,
      checksum: approvedChecksum,
      applied_at: "2026-07-25T00:00:00.000Z",
    },
  ];
  const matching = await inspectState(
    defaultDatabaseState({
      ledgerRows: matchingRows,
      columns: [
        ...baseColumns(),
        ...completeDispatchColumns(),
      ],
      constraints: [
        primaryKeyConstraint(),
        statusConstraint(allStatuses),
      ],
    })
  );
  assert.equal(
    matching.report.migration.recorded,
    true
  );
  assert.equal(
    matching.report.migration.recordedChecksum,
    approvedChecksum
  );
  assert.equal(
    matching.report.decision,
    "ALREADY_APPLIED"
  );

  const mismatchRows = [
    ...prerequisiteLedgerRows(),
    {
      filename: migrationFilename,
      checksum: "f".repeat(64),
      applied_at: null,
    },
  ];
  const mismatch = await inspectState(
    defaultDatabaseState({
      ledgerRows: mismatchRows,
    })
  );
  assert.equal(
    mismatch.report.schema.classification,
    "CONFLICTING"
  );
  assert.equal(mismatch.report.decision, "FAIL");
});

test("schema classifier returns ABSENT for the exact pre-migration shape", async () => {
  const { report } = await inspectState();

  assert.equal(
    report.schema.classification,
    "ABSENT"
  );
  assert.equal(
    report.decision,
    "PASS_READY_FOR_EXECUTION_APPROVAL"
  );
  assert.equal(
    report.code,
    "STAGING_DISPATCH_PREFLIGHT_READY"
  );
  assert.equal(report.success, true);
});

test("schema classifier returns COMPLETE_AND_RECORDED for the exact applied shape", async () => {
  const { report } = await inspectState(
    defaultDatabaseState({
      ledgerRows: [
        ...prerequisiteLedgerRows(),
        {
          filename: migrationFilename,
          checksum: approvedChecksum,
          applied_at:
            "2026-07-25T00:00:00.000Z",
        },
      ],
      columns: [
        ...baseColumns(),
        ...completeDispatchColumns(),
      ],
      constraints: [
        primaryKeyConstraint(),
        statusConstraint(allStatuses),
      ],
    })
  );

  assert.equal(
    report.schema.classification,
    "COMPLETE_AND_RECORDED"
  );
  assert.equal(report.decision, "ALREADY_APPLIED");
  assert.equal(report.success, true);
});

test("schema classifier returns COMPLETE_BUT_UNRECORDED for matching unrecorded schema", async () => {
  const { report } = await inspectState(
    defaultDatabaseState({
      columns: [
        ...baseColumns(),
        ...completeDispatchColumns(),
      ],
      constraints: [
        primaryKeyConstraint(),
        statusConstraint(allStatuses),
      ],
    })
  );

  assert.equal(
    report.schema.classification,
    "COMPLETE_BUT_UNRECORDED"
  );
  assert.equal(
    report.decision,
    "BLOCKED_PARTIAL_SCHEMA"
  );
  assert.equal(report.success, false);
});

test("schema classifier returns PARTIAL for mixed column state", async () => {
  const { report } = await inspectState(
    defaultDatabaseState({
      columns: [
        ...baseColumns(),
        ...completeDispatchColumns().slice(0, 2),
      ],
      constraints: [
        primaryKeyConstraint(),
        statusConstraint([
          ...legacyStatuses,
          dispatchStatuses[0],
        ]),
      ],
    })
  );

  assert.equal(
    report.schema.classification,
    "PARTIAL"
  );
  assert.equal(
    report.decision,
    "BLOCKED_PARTIAL_SCHEMA"
  );
});

test("column validation rejects wrong type, default, nullability, and missing columns", async (t) => {
  const cases = [
    [
      "wrong type",
      {
        en_route_at: {
          data_type: "timestamp with time zone",
        },
      },
    ],
    [
      "default",
      {
        en_route_at: {
          column_default: "CURRENT_TIMESTAMP",
        },
      },
    ],
    [
      "not null",
      {
        en_route_at: {
          is_nullable: "NO",
        },
      },
    ],
  ];

  for (const [name, overrides] of cases) {
    await t.test(name, async () => {
      const { report } = await inspectState(
        defaultDatabaseState({
          columns: [
            ...baseColumns(),
            ...completeDispatchColumns(
              overrides
            ),
            {
              column_name:
                "unrelated_column",
              data_type: "text",
              is_nullable: "YES",
              column_default: null,
            },
          ],
          constraints: [
            primaryKeyConstraint(),
            statusConstraint(allStatuses),
          ],
        })
      );
      assert.equal(
        report.schema.classification,
        "PARTIAL"
      );
    });
  }

  const missing = await inspectState(
    defaultDatabaseState({
      columns: [
        ...baseColumns(),
        ...completeDispatchColumns().slice(0, -1),
      ],
      constraints: [
        primaryKeyConstraint(),
        statusConstraint(allStatuses),
      ],
    })
  );
  assert.equal(
    missing.report.schema.classification,
    "PARTIAL"
  );
});

test("status validation distinguishes legacy, complete, partial, missing, and malformed checks", async (t) => {
  const cases = [
    [
      "legacy",
      statusConstraint(legacyStatuses),
      "ABSENT",
    ],
    [
      "all",
      statusConstraint(allStatuses),
      "COMPLETE_BUT_UNRECORDED",
    ],
    [
      "partial dispatch",
      statusConstraint([
        ...legacyStatuses,
        dispatchStatuses[0],
      ]),
      "PARTIAL",
    ],
    [
      "missing legacy",
      statusConstraint(
        allStatuses.filter(
          (status) => status !== "draft"
        )
      ),
      "PARTIAL",
    ],
    [
      "malformed",
      {
        constraint_name:
          "emergency_requests_status_check",
        constraint_type: "CHECK",
        constraint_definition: "CHECK (true)",
      },
      "PARTIAL",
    ],
  ];

  for (const [name, constraint, expected] of cases) {
    await t.test(name, async () => {
      const complete =
        expected ===
        "COMPLETE_BUT_UNRECORDED";
      const { report } = await inspectState(
        defaultDatabaseState({
          columns: complete
            ? [
                ...baseColumns(),
                ...completeDispatchColumns(),
              ]
            : baseColumns(),
          constraints: [
            primaryKeyConstraint(),
            {
              constraint_name:
                "unrelated_check",
              constraint_type: "CHECK",
              constraint_definition:
                "CHECK (id > 0)",
            },
            constraint,
          ],
        })
      );
      assert.equal(
        report.schema.classification,
        expected
      );
    });
  }
});

test("aggregate output retains only row and governed status counts", async () => {
  const { report } = await inspectState(
    defaultDatabaseState({
      rowCount: "7",
      statusCounts: [
        {
          status: "draft",
          count: "5",
          homeowner_id: 99,
          address: "sensitive-address-value",
          description: "sensitive-description-value",
        },
        {
          status: "assigned",
          count: "2",
          access_instructions:
            "sensitive-access-value",
        },
        {
          status: "forged",
          count: "100",
        },
      ],
      columns: [
        ...baseColumns(),
        {
          column_name: "address",
          data_type: "text",
          is_nullable: "YES",
          column_default: null,
          sample_value: "sensitive-sample-value",
        },
      ],
    })
  );

  assert.deepEqual(report.counts, {
    rowCount: 7,
    statusCounts: [
      { status: "assigned", count: 2 },
      { status: "draft", count: 5 },
      { status: "forged", count: 100 },
    ],
  });
  assert.deepEqual(
    report.schema.unsupportedRowStatuses,
    ["forged"]
  );
  assert.equal(
    report.schema.classification,
    "CONFLICTING"
  );
  assert.equal(report.decision, "FAIL");
  const serialized = JSON.stringify(report);
  for (const privateValue of [
    "homeowner_id",
    "address",
    "description",
    "access_instructions",
    "sample_value",
    "sensitive-address-value",
    "sensitive-description-value",
    "sensitive-access-value",
    "sensitive-sample-value",
  ]) {
    assert.equal(
      serialized.includes(privateValue),
      false
    );
  }
});

test("database identity mismatch blocks target and rolls back", async () => {
  const { harness, report } = await inspectState(
    defaultDatabaseState({
      databaseName: "different_database",
    })
  );

  assert.equal(
    report.decision,
    "BLOCKED_TARGET_NOT_PROVEN"
  );
  assert.equal(
    report.code,
    "INSPECTION_TARGET_NOT_STAGING"
  );
  assert.equal(
    harness.calls.at(-1).stage,
    "rollback"
  );
  assert.equal(harness.releases, 1);
});

test("connection and read-only begin failures are sanitized", async () => {
  const connection = await inspectState(
    defaultDatabaseState(),
    { failConnect: true }
  );
  assert.equal(
    connection.report.code,
    "INSPECTION_DATABASE_UNAVAILABLE"
  );
  assert.equal(connection.harness.releases, 0);
  assert.equal(connection.harness.poolEnds, 1);

  const begin = await inspectState(
    defaultDatabaseState(),
    { failAt: "begin" }
  );
  assert.equal(
    begin.report.code,
    "INSPECTION_READ_ONLY_BEGIN_FAILED"
  );
  assert.equal(
    begin.harness.calls.some(
      ({ stage }) => stage === "rollback"
    ),
    false
  );
  assert.equal(begin.harness.releases, 1);
});

test("every query-stage failure rolls back, releases once, and exposes no raw error", async () => {
  for (const stage of [
    "databaseIdentity",
    "ledgerExists",
    "ledgerRows",
    "emergencyTableExists",
    "emergencyColumns",
    "emergencyConstraints",
    "emergencyIndexes",
    "emergencyRowCount",
    "emergencyStatusCounts",
  ]) {
    const { harness, report } =
      await inspectState(
        defaultDatabaseState(),
        { failAt: stage }
      );
    assert.equal(
      report.code,
      "INSPECTION_QUERY_FAILED",
      stage
    );
    assert.equal(
      harness.calls.at(-1).stage,
      "rollback",
      stage
    );
    assert.equal(harness.releases, 1, stage);
    assert.doesNotMatch(
      JSON.stringify(report),
      /private-user|private-password|private-host|private-db|postgres:\/\//i
    );
  }
});

test("rollback and release failures return stable sanitized failures", async () => {
  const rollback = await inspectState(
    defaultDatabaseState(),
    { failAt: "rollback" }
  );
  assert.equal(
    rollback.report.code,
    "INSPECTION_ROLLBACK_FAILED"
  );
  assert.equal(rollback.harness.releases, 1);

  const release = await inspectState(
    defaultDatabaseState(),
    { failRelease: true }
  );
  assert.equal(
    release.report.code,
    "INSPECTION_DATABASE_UNAVAILABLE"
  );
  assert.equal(release.harness.releases, 1);
  assert.equal(release.harness.poolEnds, 1);
});

test("CLI emits one JSON object with deterministic exit codes", async () => {
  const cases = [
    ["PASS_READY_FOR_EXECUTION_APPROVAL", 0],
    ["ALREADY_APPLIED", 0],
    ["BLOCKED_TARGET_NOT_PROVEN", 2],
    ["BLOCKED_PARTIAL_SCHEMA", 2],
    ["FAIL", 1],
  ];

  for (const [decision, expectedCode] of cases) {
    let output = "";
    const exitCode = await runInspectionCli({
      env: validEnvironment(),
      inspect: async () => ({
        success: expectedCode === 0,
        decision,
        code: "SAFE_CODE",
      }),
      write(value) {
        output += value;
      },
    });

    assert.equal(exitCode, expectedCode);
    assert.equal(output.split("\n").length, 2);
    assert.equal(
      JSON.parse(output).decision,
      decision
    );
  }
});

test("CLI normalizes unexpected failures without raw errors", async () => {
  let output = "";
  const exitCode = await runInspectionCli({
    env: validEnvironment(),
    inspect: async () => {
      throw new Error(
        "postgres://private-user:private-password@private-host/private-db"
      );
    },
    write(value) {
      output += value;
    },
  });

  assert.equal(exitCode, 1);
  const parsed = JSON.parse(output);
  assert.equal(parsed.decision, "FAIL");
  assert.equal(
    parsed.code,
    "INSPECTION_RESULT_INVALID"
  );
  assert.doesNotMatch(
    output,
    /private-user|private-password|private-host|private-db|postgres:\/\//i
  );
});

test("CLI rejects malformed inspector results deterministically", async () => {
  let output = "";
  const exitCode = await runInspectionCli({
    env: validEnvironment(),
    inspect: async () => ({
      decision: "UNSUPPORTED_DECISION",
      private: "must-not-escape",
    }),
    write(value) {
      output += value;
    },
  });

  assert.equal(exitCode, 1);
  const parsed = JSON.parse(output);
  assert.equal(parsed.decision, "FAIL");
  assert.equal(
    parsed.code,
    "INSPECTION_RESULT_INVALID"
  );
  assert.equal(
    output.includes("must-not-escape"),
    false
  );
});

test("inspector source contains no migration execution, arbitrary SQL, shell, or mutation path", () => {
  const source = readFileSync(
    inspectorPath,
    "utf8"
  );

  assert.doesNotMatch(
    source,
    /run-migrations|runMigrations/
  );
  assert.doesNotMatch(
    source,
    /\beval\s*\(|child_process|execFile|spawn\s*\(|\bpsql\b|railway\s+(?:run|ssh|up)/i
  );
  assert.doesNotMatch(
    source,
    /\bCOMMIT\b/
  );
  assert.doesNotMatch(
    source,
    /\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|GRANT|REVOKE)\b\s+(?:INTO|FROM|TABLE|TYPE|ROLE|ON)?/i
  );
  assert.doesNotMatch(
    source,
    /process\.argv|readline|stdin/
  );
  assert.match(
    source,
    /BEGIN TRANSACTION READ ONLY/
  );
  assert.match(source, /ROLLBACK/);
});
