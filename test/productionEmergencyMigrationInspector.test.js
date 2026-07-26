"use strict";

const assert =
  require("node:assert/strict");
const test =
  require("node:test");

const inspector =
  require(
    "../scripts/inspect-production-emergency-migrations"
  );

const SAFE_ENV = Object.freeze({
  NODE_ENV: "production",
  DATABASE_URL:
    "postgresql://redacted:secret@postgres.railway.internal/railway",
  RAILWAY_PROJECT_NAME:
    "profound-magic",
  RAILWAY_ENVIRONMENT_NAME:
    "production",
  RAILWAY_SERVICE_NAME:
    "athletic-rebirth",
  CONFIRM_PRODUCTION_EMERGENCY_INSPECTION:
    "YES",
});

function ledgerRows() {
  return inspector
    .EMERGENCY_MIGRATIONS
    .map((migration) => ({
      filename:
        migration.filename,
      checksum:
        migration.checksum,
      execution_target:
        "production-governed-additive",
      applied_at:
        "2026-07-26T00:00:00.000Z",
    }));
}

function createPool({
  fullSchema = true,
  canonicalSafetyTable = fullSchema,
  ledger = ledgerRows(),
  databaseName = "railway",
} = {}) {
  const calls = [];

  const emergencyColumns =
    fullSchema
      ? [
          "id",
          "homeowner_id",
          "status",
          "assigned_at",
          "en_route_at",
          "arrived_at",
          "work_started_at",
          "completed_at",
        ].map((column_name) => ({
          column_name,
          data_type:
            column_name === "id"
              ? "bigint"
              : column_name === "status"
                ? "text"
                : "timestamp without time zone",
          is_nullable:
            ["id", "homeowner_id", "status"].includes(
              column_name
            )
              ? "NO"
              : "YES",
          column_default: null,
        }))
      : [];

  function normalizeSql(sql) {
    return String(sql)
      .replace(/\s+/g, " ")
      .trim();
  }

  function compactSql(sql) {
    return normalizeSql(sql)
      .toLowerCase()
      .replace(/\s+/g, "");
  }

  const client = {
    async query(sql) {
      const normalized =
        normalizeSql(sql);

      const compact =
        compactSql(sql);

      calls.push(normalized);

      if (
        compact ===
        "begintransactionreadonly"
      ) {
        return { rows: [] };
      }

      if (compact === "rollback") {
        return { rows: [] };
      }

      if (
        compact ===
        "selectcurrent_database()asdatabase_name"
      ) {
        return {
          rows: [
            {
              database_name:
                databaseName,
            },
          ],
        };
      }

      if (
        compact.includes(
          "to_regclass('public.schema_migrations')"
        )
      ) {
        return {
          rows: [
            {
              exists:
                ledger !== null,
            },
          ],
        };
      }

      if (
        compact.startsWith(
          "selectfilename,checksum,execution_target,applied_atfromschema_migrations"
        )
      ) {
        return {
          rows:
            ledger || [],
        };
      }

      if (
        compact.includes(
          "to_regclass('public.emergency_requests')"
        )
      ) {
        return {
          rows: [
            {
              exists:
                fullSchema,
            },
          ],
        };
      }

      if (
        compact.includes(
          "frominformation_schema.columns"
        ) &&
        compact.includes(
          "table_name='emergency_requests'"
        )
      ) {
        return {
          rows:
            emergencyColumns,
        };
      }

      if (
        compact.includes(
          "frominformation_schema.table_constraints"
        ) &&
        compact.includes(
          "table_name='emergency_requests'"
        )
      ) {
        return {
          rows:
            fullSchema
              ? [
                  {
                    constraint_name:
                      "emergency_requests_status_check",
                    constraint_type:
                      "CHECK",
                    constraint_definition:
                      "CHECK (status IS NOT NULL)",
                  },
                ]
              : [],
        };
      }

      if (
        compact.includes(
          "frompg_catalog.pg_indexes"
        ) &&
        compact.includes(
          "tablename='emergency_requests'"
        )
      ) {
        return {
          rows:
            fullSchema
              ? [
                  {
                    index_name:
                      "idx_emergency_requests_status",
                    index_definition:
                      "CREATE INDEX idx_emergency_requests_status ON emergency_requests(status)",
                  },
                ]
              : [],
        };
      }

      if (
        compact.includes(
          "to_regclass('public.emergency_request_safety_assessments')"
        )
      ) {
        return {
          rows: [
            {
              exists:
                canonicalSafetyTable,
            },
          ],
        };
      }

      if (
        compact.includes(
          "frominformation_schema.columns"
        ) &&
        compact.includes(
          "table_name='emergency_request_safety_assessments'"
        )
      ) {
        return {
          rows:
            canonicalSafetyTable
              ? [
                  {
                    column_name:
                      "emergency_request_id",
                    data_type:
                      "bigint",
                    is_nullable:
                      "NO",
                    column_default:
                      null,
                  },
                ]
              : [],
        };
      }

      if (
        compact.includes(
          "frominformation_schema.columns"
        ) &&
        compact.includes(
          "table_name='request_relationships'"
        )
      ) {
        return {
          rows:
            fullSchema
              ? [
                  {
                    column_name:
                      "emergency_request_id",
                    data_type:
                      "bigint",
                    is_nullable:
                      "YES",
                    column_default:
                      null,
                  },
                ]
              : [],
        };
      }

      if (
        compact.includes(
          "frominformation_schema.table_constraints"
        ) &&
        compact.includes(
          "table_name='request_relationships'"
        )
      ) {
        return {
          rows:
            fullSchema
              ? [
                  {
                    constraint_name:
                      "request_relationship_source_check",
                    constraint_type:
                      "CHECK",
                    constraint_definition:
                      "CHECK (emergency_request_id IS NOT NULL OR post_id IS NOT NULL)",
                  },
                ]
              : [],
        };
      }

      if (
        compact.includes(
          "frompg_catalog.pg_indexes"
        ) &&
        compact.includes(
          "tablename='request_relationships'"
        )
      ) {
        return {
          rows:
            fullSchema
              ? [
                  {
                    index_name:
                      "idx_request_relationships_one_active_emergency",
                    index_definition:
                      "CREATE UNIQUE INDEX idx_request_relationships_one_active_emergency ON request_relationships(emergency_request_id) WHERE emergency_request_id IS NOT NULL",
                  },
                ]
              : [],
        };
      }

      if (
        compact.includes(
          "to_regclass('public.conversations')"
        )
      ) {
        return {
          rows: [
            {
              exists:
                fullSchema,
            },
          ],
        };
      }

      if (
        compact.startsWith(
          "selectstatus,count(*)::bigintascountfromemergency_requests"
        )
      ) {
        return {
          rows:
            fullSchema
              ? [
                  {
                    status:
                      "completed",
                    count: "1",
                  },
                ]
              : [],
        };
      }

      throw new Error(
        `Unexpected mock inspection query: ${normalized}`
      );
    },

    release() {
      calls.push("RELEASE");
    },
  };

  return {
    calls,

    factory() {
      return {
        async connect() {
          return client;
        },

        async end() {
          calls.push("POOL_END");
        },
      };
    },
  };
}

test(
  "module import is inert and exposes narrow inspection API",
  () => {
    assert.equal(
      typeof inspector
        .inspectProductionEmergencyState,
      "function"
    );

    assert.equal(
      typeof inspector
        .runInspectionCli,
      "function"
    );
  }
);

test(
  "production authorization requires exact identity and confirmation",
  () => {
    assert.equal(
      inspector
        .validateInspectionEnvironment(
          SAFE_ENV
        ).valid,
      true
    );

    assert.equal(
      inspector
        .validateInspectionEnvironment({
          ...SAFE_ENV,
          CONFIRM_PRODUCTION_EMERGENCY_INSPECTION:
            undefined,
        }).valid,
      false
    );
  }
);

test(
  "staging, local, and unknown targets are rejected",
  () => {
    const targets = [
      {
        ...SAFE_ENV,
        NODE_ENV:
          "staging",
        RAILWAY_ENVIRONMENT_NAME:
          "staging",
        RAILWAY_SERVICE_NAME:
          "athletic-rebirth",
      },
      {
        ...SAFE_ENV,
        DATABASE_URL:
          "postgresql://user:secret@localhost/production",
      },
      {
        ...SAFE_ENV,
        RAILWAY_SERVICE_NAME:
          "other-service",
      },
    ];

    for (const env of targets) {
      assert.notEqual(
        inspector
          .classifyInspectionTarget(
            env
          ),
        "production"
      );
    }
  }
);

test(
  "sanitized target metadata exposes no credentials or raw host",
  () => {
    const target =
      inspector
        .sanitizeTargetMetadata(
          SAFE_ENV
        );

    const serialized =
      JSON.stringify(target);

    assert.equal(
      serialized.includes("secret"),
      false
    );

    assert.equal(
      serialized.includes(
        "postgres.railway.internal"
      ),
      false
    );
  }
);

test(
  "local migration checksums are pinned and valid",
  () => {
    const migrations =
      inspector
        .loadLocalMigrationChecksums();

    assert.equal(
      migrations.length,
      5
    );

    assert.equal(
      migrations.every(
        (migration) =>
          migration
            .checksumMatches ===
          true
      ),
      true
    );
  }
);

test(
  "inspector uses only the canonical Emergency safety-assessment table",
  () => {
    assert.match(
      inspector.INSPECTION_SQL.safetyTableExists,
      /emergency_request_safety_assessments/
    );
    assert.match(
      inspector.INSPECTION_SQL.safetyColumns,
      /emergency_request_safety_assessments/
    );
    assert.doesNotMatch(
      inspector.INSPECTION_SQL.safetyTableExists,
      /public\.emergency_safety_assessments/
    );
    assert.doesNotMatch(
      inspector.INSPECTION_SQL.safetyColumns,
      /table_name\s*=\s*'emergency_safety_assessments'/
    );
  }
);

test(
  "complete production schema and ledger report already applied",
  async () => {
    const pool =
      createPool();

    const result =
      await inspector
        .inspectProductionEmergencyState({
          env:
            SAFE_ENV,
          poolFactory:
            pool.factory,
        });

    assert.equal(
      result.decision,
      "ALREADY_APPLIED"
    );

    assert.equal(
      result.code,
      "PRODUCTION_EMERGENCY_READY"
    );

    assert.equal(
      result.schema.classification,
      "COMPLETE"
    );

    assert.equal(
      result.ledger.allRecorded,
      true
    );

    assert.equal(
      result.readOnly,
      true
    );

    assert.equal(
      pool.calls[0],
      "BEGIN TRANSACTION READ ONLY"
    );

    assert.ok(
      pool.calls.includes(
        "ROLLBACK"
      )
    );

    assert.equal(
      pool.calls.some(
        (sql) =>
          /\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE)\b/i.test(
            sql
          )
      ),
      false
    );
  }
);

test(
  "missing canonical safety table blocks an otherwise migrated schema",
  async () => {
    const pool = createPool({
      canonicalSafetyTable: false,
    });

    const result =
      await inspector.inspectProductionEmergencyState({
        env: SAFE_ENV,
        poolFactory: pool.factory,
      });

    assert.equal(
      result.decision,
      "BLOCKED_PARTIAL_OR_UNRECORDED_SCHEMA"
    );
    assert.equal(
      result.schema.classification,
      "PARTIAL"
    );
    assert.equal(
      result.schema.safetyTableExists,
      false
    );
    assert.ok(pool.calls.includes("ROLLBACK"));
  }
);

test(
  "absent Emergency schema and ledger allow migration planning only",
  async () => {
    const pool =
      createPool({
        fullSchema:
          false,
        ledger: [],
      });

    const result =
      await inspector
        .inspectProductionEmergencyState({
          env:
            SAFE_ENV,
          poolFactory:
            pool.factory,
        });

    assert.equal(
      result.decision,
      "PASS_READY_FOR_MIGRATION_PLANNING"
    );

    assert.equal(
      result.schema.classification,
      "ABSENT"
    );

    assert.equal(
      result.ledger.allRecorded,
      false
    );
  }
);

test(
  "partial or unrecorded production schema blocks automatically",
  async () => {
    const pool =
      createPool({
        fullSchema:
          true,
        ledger: [],
      });

    const result =
      await inspector
        .inspectProductionEmergencyState({
          env:
            SAFE_ENV,
          poolFactory:
            pool.factory,
        });

    assert.equal(
      result.decision,
      "BLOCKED_PARTIAL_OR_UNRECORDED_SCHEMA"
    );
  }
);

test(
  "database identity mismatch fails safely",
  async () => {
    const pool =
      createPool({
        databaseName:
          "other_database",
      });

    const result =
      await inspector
        .inspectProductionEmergencyState({
          env:
            SAFE_ENV,
          poolFactory:
            pool.factory,
        });

    assert.equal(
      result.decision,
      "FAIL"
    );

    assert.equal(
      result.code,
      "INSPECTION_TARGET_IDENTITY_MISMATCH"
    );
  }
);

test(
  "ledger checksum drift fails closed",
  async () => {
    const rows =
      ledgerRows();

    rows[0] = {
      ...rows[0],
      checksum:
        "0".repeat(64),
    };

    const pool =
      createPool({
        ledger:
          rows,
      });

    const result =
      await inspector
        .inspectProductionEmergencyState({
          env:
            SAFE_ENV,
          poolFactory:
            pool.factory,
        });

    assert.equal(
      result.decision,
      "FAIL"
    );

    assert.equal(
      result.code,
      "MIGRATION_LEDGER_CONFLICT"
    );
  }
);

test(
  "CLI emits one JSON object with deterministic exit codes",
  async () => {
    const output = [];

    const exitCode =
      await inspector
        .runInspectionCli({
          env:
            SAFE_ENV,
          inspect:
            async () => ({
              decision:
                "ALREADY_APPLIED",
            }),
          write:
            (value) =>
              output.push(value),
        });

    assert.equal(
      exitCode,
      0
    );

    assert.equal(
      output.length,
      1
    );

    assert.deepEqual(
      JSON.parse(output[0]),
      {
        decision:
          "ALREADY_APPLIED",
      }
    );
  }
);
