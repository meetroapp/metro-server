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

const runner = require(
  "../scripts/run-production-conversation-prerequisites"
);
const genericRunner = require(
  "../scripts/run-migrations"
);

const REPOSITORY_ROOT = path.join(
  __dirname,
  ".."
);
const MIGRATIONS_DIRECTORY =
  path.join(
    REPOSITORY_ROOT,
    "migrations"
  );
const RUNNER_PATH = path.join(
  REPOSITORY_ROOT,
  "scripts",
  "run-production-conversation-prerequisites.js"
);
const README_PATH = path.join(
  MIGRATIONS_DIRECTORY,
  "README.md"
);
const PACKAGE_PATH = path.join(
  REPOSITORY_ROOT,
  "package.json"
);

const SAFE_ENV = Object.freeze({
  NODE_ENV: "production",
  RAILWAY_PROJECT_NAME:
    "profound-magic",
  RAILWAY_ENVIRONMENT_NAME:
    "production",
  RAILWAY_SERVICE_NAME:
    "athletic-rebirth",
  CONFIRM_PRODUCTION_PREREQUISITE_MIGRATION:
    "YES",
  CONFIRM_PRODUCTION_TARGET:
    "profound-magic/production/athletic-rebirth",
  CONFIRM_PREREQUISITE_MIGRATION_CHAIN:
    "202607200002-202607200003",
  CONFIRM_PRODUCTION_MUTATION:
    "EXECUTE",
  DATABASE_URL:
    "postgresql://runner:private-password@postgres.railway.internal/railway",
});

const APPROVED_FILENAMES =
  runner.APPROVED_MIGRATIONS.map(
    ({ filename }) =>
      filename
  );
const LOADED_MIGRATIONS =
  runner.loadApprovedMigrations();

function approvedLedgerRows() {
  return runner
    .APPROVED_MIGRATIONS
    .map((migration) => ({
      filename:
        migration.filename,
      checksum:
        migration.checksum,
      execution_target:
        "production-governed-conversation-prerequisites",
      applied_at:
        "2026-07-26T00:00:00.000Z",
    }));
}

function publicLedgerEntries() {
  return approvedLedgerRows().map(
    (row) => ({
      filename:
        row.filename,
      checksum:
        row.checksum,
      executionTarget:
        row.execution_target,
      applied: true,
    })
  );
}

function requestColumns() {
  const definitions = {
    id: [
      "integer",
      "NO",
      "nextval('request_relationships_id_seq'::regclass)",
    ],
    post_id: [
      "integer",
      "NO",
      null,
    ],
    homeowner_id: [
      "integer",
      "NO",
      null,
    ],
    contractor_id: [
      "integer",
      "NO",
      null,
    ],
    professional_user_id: [
      "integer",
      "NO",
      null,
    ],
    status: [
      "text",
      "NO",
      "'pending'::text",
    ],
    introduction_text: [
      "text",
      "NO",
      "''::text",
    ],
    responded_at: [
      "timestamp without time zone",
      "NO",
      "CURRENT_TIMESTAMP",
    ],
    accepted_at: [
      "timestamp without time zone",
      "YES",
      null,
    ],
    declined_at: [
      "timestamp without time zone",
      "YES",
      null,
    ],
    withdrawn_at: [
      "timestamp without time zone",
      "YES",
      null,
    ],
    closed_at: [
      "timestamp without time zone",
      "YES",
      null,
    ],
    created_at: [
      "timestamp without time zone",
      "NO",
      "CURRENT_TIMESTAMP",
    ],
    updated_at: [
      "timestamp without time zone",
      "NO",
      "CURRENT_TIMESTAMP",
    ],
  };

  return Object.entries(
    definitions
  ).map(
    ([
      column_name,
      [
        data_type,
        is_nullable,
        column_default,
      ],
    ]) => ({
      column_name,
      data_type,
      is_nullable,
      column_default,
    })
  );
}

function conversationColumns() {
  const definitions = {
    id: [
      "integer",
      "NO",
      "nextval('conversations_id_seq'::regclass)",
    ],
    relationship_id: [
      "integer",
      "NO",
      null,
    ],
    homeowner_id: [
      "integer",
      "NO",
      null,
    ],
    contractor_id: [
      "integer",
      "NO",
      null,
    ],
    professional_user_id: [
      "integer",
      "NO",
      null,
    ],
    status: [
      "text",
      "NO",
      "'active'::text",
    ],
    homeowner_archived_at: [
      "timestamp without time zone",
      "YES",
      null,
    ],
    professional_archived_at: [
      "timestamp without time zone",
      "YES",
      null,
    ],
    closed_at: [
      "timestamp without time zone",
      "YES",
      null,
    ],
    created_at: [
      "timestamp without time zone",
      "NO",
      "CURRENT_TIMESTAMP",
    ],
    updated_at: [
      "timestamp without time zone",
      "NO",
      "CURRENT_TIMESTAMP",
    ],
  };

  return Object.entries(
    definitions
  ).map(
    ([
      column_name,
      [
        data_type,
        is_nullable,
        column_default,
      ],
    ]) => ({
      column_name,
      data_type,
      is_nullable,
      column_default,
    })
  );
}

function requestConstraints() {
  return [
    [
      "request_relationships_pkey",
      "PRIMARY KEY",
      "PRIMARY KEY (id)",
    ],
    [
      "request_relationships_post_id_fkey",
      "FOREIGN KEY",
      "FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE",
    ],
    [
      "request_relationships_homeowner_id_fkey",
      "FOREIGN KEY",
      "FOREIGN KEY (homeowner_id) REFERENCES users(id) ON DELETE CASCADE",
    ],
    [
      "request_relationships_contractor_id_fkey",
      "FOREIGN KEY",
      "FOREIGN KEY (contractor_id) REFERENCES contractor_profiles(id) ON DELETE CASCADE",
    ],
    [
      "request_relationships_professional_user_id_fkey",
      "FOREIGN KEY",
      "FOREIGN KEY (professional_user_id) REFERENCES users(id) ON DELETE CASCADE",
    ],
    [
      "request_relationships_status_check",
      "CHECK",
      "CHECK ((status = ANY (ARRAY['pending'::text, 'active'::text, 'declined'::text, 'withdrawn'::text, 'closed'::text])))",
    ],
    [
      "request_relationships_unique_response",
      "UNIQUE",
      "UNIQUE (post_id, contractor_id)",
    ],
    [
      "request_relationships_different_users",
      "CHECK",
      "CHECK ((homeowner_id <> professional_user_id))",
    ],
  ].map(
    ([
      constraint_name,
      constraint_type,
      constraint_definition,
    ]) => ({
      constraint_name,
      constraint_type,
      constraint_definition,
    })
  );
}

function conversationConstraints() {
  return [
    [
      "conversations_pkey",
      "PRIMARY KEY",
      "PRIMARY KEY (id)",
    ],
    [
      "conversations_relationship_id_fkey",
      "FOREIGN KEY",
      "FOREIGN KEY (relationship_id) REFERENCES request_relationships(id) ON DELETE RESTRICT",
    ],
    [
      "conversations_homeowner_id_fkey",
      "FOREIGN KEY",
      "FOREIGN KEY (homeowner_id) REFERENCES users(id) ON DELETE RESTRICT",
    ],
    [
      "conversations_contractor_id_fkey",
      "FOREIGN KEY",
      "FOREIGN KEY (contractor_id) REFERENCES contractor_profiles(id) ON DELETE RESTRICT",
    ],
    [
      "conversations_professional_user_id_fkey",
      "FOREIGN KEY",
      "FOREIGN KEY (professional_user_id) REFERENCES users(id) ON DELETE RESTRICT",
    ],
    [
      "conversations_status_check",
      "CHECK",
      "CHECK ((status = ANY (ARRAY['active'::text, 'closed'::text])))",
    ],
    [
      "conversations_unique_relationship",
      "UNIQUE",
      "UNIQUE (relationship_id)",
    ],
    [
      "conversations_different_users",
      "CHECK",
      "CHECK ((homeowner_id <> professional_user_id))",
    ],
  ].map(
    ([
      constraint_name,
      constraint_type,
      constraint_definition,
    ]) => ({
      constraint_name,
      constraint_type,
      constraint_definition,
    })
  );
}

function requestIndexes() {
  return [
    [
      "request_relationships_homeowner_idx",
      "CREATE INDEX request_relationships_homeowner_idx ON public.request_relationships USING btree (homeowner_id)",
    ],
    [
      "request_relationships_professional_idx",
      "CREATE INDEX request_relationships_professional_idx ON public.request_relationships USING btree (professional_user_id)",
    ],
    [
      "request_relationships_post_idx",
      "CREATE INDEX request_relationships_post_idx ON public.request_relationships USING btree (post_id)",
    ],
  ].map(
    ([
      index_name,
      index_definition,
    ]) => ({
      index_name,
      index_definition,
    })
  );
}

function conversationIndexes() {
  return [
    [
      "conversations_homeowner_idx",
      "CREATE INDEX conversations_homeowner_idx ON public.conversations USING btree (homeowner_id)",
    ],
    [
      "conversations_professional_idx",
      "CREATE INDEX conversations_professional_idx ON public.conversations USING btree (professional_user_id)",
    ],
    [
      "conversations_contractor_idx",
      "CREATE INDEX conversations_contractor_idx ON public.conversations USING btree (contractor_id)",
    ],
    [
      "conversations_status_idx",
      "CREATE INDEX conversations_status_idx ON public.conversations USING btree (status)",
    ],
  ].map(
    ([
      index_name,
      index_definition,
    ]) => ({
      index_name,
      index_definition,
    })
  );
}

function dependencyColumns({
  users = true,
  posts = true,
  contractorProfiles = true,
  schemaMigrations = true,
} = {}) {
  const rows = [];
  for (const [
    table_name,
    present,
  ] of [
    ["users", users],
    ["posts", posts],
    [
      "contractor_profiles",
      contractorProfiles,
    ],
  ]) {
    if (present) {
      rows.push({
        table_name,
        column_name: "id",
        data_type: "integer",
        is_nullable: "NO",
      });
    }
  }

  if (schemaMigrations) {
    for (const [
      column_name,
      data_type,
      is_nullable,
    ] of [
      ["id", "integer", "NO"],
      ["filename", "text", "NO"],
      ["checksum", "text", "NO"],
      [
        "execution_target",
        "text",
        "NO",
      ],
      [
        "applied_at",
        "timestamp without time zone",
        "YES",
      ],
    ]) {
      rows.push({
        table_name:
          "schema_migrations",
        column_name,
        data_type,
        is_nullable,
      });
    }
  }

  return rows;
}

function dependencyConstraints({
  users = true,
  posts = true,
  contractorProfiles = true,
  schemaMigrations = true,
} = {}) {
  const rows = [];
  for (const [
    table_name,
    present,
  ] of [
    ["users", users],
    ["posts", posts],
    [
      "contractor_profiles",
      contractorProfiles,
    ],
  ]) {
    if (present) {
      rows.push({
        table_name,
        constraint_type: "p",
        constraint_definition:
          "PRIMARY KEY (id)",
      });
    }
  }

  if (schemaMigrations) {
    rows.push(
      {
        table_name:
          "schema_migrations",
        constraint_type: "p",
        constraint_definition:
          "PRIMARY KEY (id)",
      },
      {
        table_name:
          "schema_migrations",
        constraint_type: "u",
        constraint_definition:
          "UNIQUE (filename)",
      }
    );
  }

  return rows;
}

function createInspectionPool({
  dependencies = {},
  requestState = "absent",
  conversationState = "absent",
  ledger = [],
  databaseName = "railway",
  serverVersion = 160003,
  failQuery = null,
} = {}) {
  const calls = [];
  const resources = {
    connectCount: 0,
    releaseCount: 0,
    endCount: 0,
  };

  const client = {
    async query(
      sql,
      values = []
    ) {
      calls.push({
        sql,
        values,
      });
      const compact =
        String(sql)
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();

      if (
        failQuery &&
        compact.includes(
          failQuery
        )
      ) {
        throw new Error(
          "private-password raw database failure"
        );
      }

      if (
        compact.includes(
          "current_database()"
        )
      ) {
        return {
          rows: [
            {
              database_name:
                databaseName,
              server_version_num:
                serverVersion,
            },
          ],
        };
      }

      if (
        compact.includes(
          "from information_schema.columns"
        ) &&
        compact.includes(
          "table_name = any"
        )
      ) {
        return {
          rows:
            dependencyColumns(
              dependencies
            ),
        };
      }

      if (
        compact.includes(
          "relation.relname = any"
        )
      ) {
        return {
          rows:
            dependencyConstraints(
              dependencies
            ),
        };
      }

      if (
        compact.includes(
          "from schema_migrations"
        ) &&
        compact.includes(
          "filename = any"
        )
      ) {
        return {
          rows:
            ledger,
        };
      }

      if (
        compact.includes(
          "to_regclass($1)"
        )
      ) {
        const tableName =
          values[0].replace(
            "public.",
            ""
          );
        return {
          rows: [
            {
              exists:
                tableName ===
                "request_relationships"
                  ? requestState !==
                    "absent"
                  : conversationState !==
                    "absent",
            },
          ],
        };
      }

      if (
        compact.includes(
          "from information_schema.columns"
        ) &&
        compact.includes(
          "table_name = $1"
        )
      ) {
        const [
          tableName,
        ] = values;
        if (
          tableName ===
          "request_relationships"
        ) {
          const rows =
            requestColumns();
          return {
            rows:
              requestState ===
              "incomplete"
                ? rows.slice(1)
                : rows,
          };
        }
        const rows =
          conversationColumns();
        return {
          rows:
            conversationState ===
            "incomplete"
              ? rows.slice(1)
              : rows,
        };
      }

      if (
        compact.includes(
          "relation.relname = $1"
        )
      ) {
        return {
          rows:
            values[0] ===
            "request_relationships"
              ? requestConstraints()
              : conversationConstraints(),
        };
      }

      if (
        compact.includes(
          "from pg_catalog.pg_indexes"
        )
      ) {
        return {
          rows:
            values[0] ===
            "request_relationships"
              ? requestIndexes()
              : conversationIndexes(),
        };
      }

      return {
        rows: [],
      };
    },
    release() {
      resources.releaseCount +=
        1;
    },
  };

  const pool = {
    async connect() {
      resources.connectCount +=
        1;
      return client;
    },
    async end() {
      resources.endCount +=
        1;
    },
  };

  return {
    calls,
    resources,
    factory: () =>
      pool,
  };
}

function completeDependencies() {
  return {
    users: true,
    posts: true,
    contractorProfiles: true,
    schemaMigrations: true,
    complete: true,
  };
}

function publicLedger() {
  return {
    entries:
      publicLedgerEntries(),
    missing: [],
    checksumDrift: [],
    duplicateFilenames: [],
    unexpectedEntryCount:
      0,
    allRecorded: true,
    allChecksumsMatch: true,
  };
}

function readyReport(
  overrides = {}
) {
  return {
    success: true,
    decision:
      "PASS_READY_FOR_PREREQUISITE_MIGRATION",
    code:
      "PRODUCTION_CONVERSATION_PREREQUISITES_MISSING",
    readOnly: true,
    dependencies:
      completeDependencies(),
    ledger: {
      entries: [],
      missing: [
        ...APPROVED_FILENAMES,
      ],
      checksumDrift: [],
      duplicateFilenames:
        [],
      unexpectedEntryCount:
        0,
      allRecorded: false,
      allChecksumsMatch:
        true,
    },
    schema: {
      classification:
        "ABSENT",
      requestRelationships: {
        exists: false,
        complete: false,
      },
      conversations: {
        exists: false,
        complete: false,
      },
    },
    ...overrides,
  };
}

function completeReport(
  overrides = {}
) {
  return {
    success: true,
    decision:
      "ALREADY_APPLIED",
    code:
      "PRODUCTION_CONVERSATION_PREREQUISITES_READY",
    readOnly: true,
    dependencies:
      completeDependencies(),
    ledger:
      publicLedger(),
    schema: {
      classification:
        "COMPLETE",
      requestRelationships: {
        exists: true,
        complete: true,
      },
      conversations: {
        exists: true,
        complete: true,
      },
    },
    ...overrides,
  };
}

function sequenceInspector(
  reports
) {
  const calls = [];
  const inspect =
    async (options) => {
      calls.push(options);
      return reports[
        Math.min(
          calls.length - 1,
          reports.length - 1
        )
      ];
    };
  inspect.calls =
    calls;
  return inspect;
}

function createExecutionPool({
  failMigrationIndex = -1,
  failVerificationIndex = -1,
  failLedgerIndex = -1,
  initialRequestTable = false,
  initialConversationTable = false,
  connectFailure = false,
  rawError =
    "private-password postgres.railway.internal",
} = {}) {
  const calls = [];
  const ledger =
    new Map();
  const tableState = {
    request_relationships:
      initialRequestTable,
    conversations:
      initialConversationTable,
  };
  const resources = {
    connectCount: 0,
    releaseCount: 0,
    endCount: 0,
  };
  const migrationIndex =
    new Map(
      LOADED_MIGRATIONS.map(
        (migration, index) => [
          migration.sql,
          index,
        ]
      )
    );

  const client = {
    async query(
      sql,
      values = []
    ) {
      calls.push({
        sql,
        values,
      });
      const compact =
        String(sql)
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();

      if (
        migrationIndex.has(
          sql
        )
      ) {
        const index =
          migrationIndex.get(
            sql
          );
        if (
          index ===
          failMigrationIndex
        ) {
          throw new Error(
            rawError
          );
        }
        tableState[
          index === 0
            ? "request_relationships"
            : "conversations"
        ] = true;
        return {
          rows: [],
        };
      }

      if (
        compact.includes(
          "from schema_migrations"
        ) &&
        compact.includes(
          "where filename = $1"
        )
      ) {
        const row =
          ledger.get(values[0]);
        return {
          rows:
            row
              ? [row]
              : [],
        };
      }

      if (
        compact.startsWith(
          "insert into schema_migrations"
        )
      ) {
        const index =
          APPROVED_FILENAMES.indexOf(
            values[0]
          );
        if (
          index ===
          failLedgerIndex
        ) {
          throw new Error(
            rawError
          );
        }
        ledger.set(
          values[0],
          {
            filename:
              values[0],
            checksum:
              values[1],
            execution_target:
              values[2],
            applied_at:
              "2026-07-26T00:00:00.000Z",
          }
        );
        return {
          rows: [],
        };
      }

      if (
        compact.includes(
          "to_regclass($1)"
        )
      ) {
        const tableName =
          values[0].replace(
            "public.",
            ""
          );
        return {
          rows: [
            {
              exists:
                tableState[
                  tableName
                ],
            },
          ],
        };
      }

      if (
        compact.includes(
          "from information_schema.columns"
        ) &&
        compact.includes(
          "table_name = $1"
        )
      ) {
        const tableName =
          values[0];
        const rows =
          tableName ===
          "request_relationships"
            ? requestColumns()
            : conversationColumns();
        const index =
          tableName ===
          "request_relationships"
            ? 0
            : 1;
        return {
          rows:
            index ===
            failVerificationIndex
              ? rows.slice(1)
              : rows,
        };
      }

      if (
        compact.includes(
          "relation.relname = $1"
        )
      ) {
        return {
          rows:
            values[0] ===
            "request_relationships"
              ? requestConstraints()
              : conversationConstraints(),
        };
      }

      if (
        compact.includes(
          "from pg_catalog.pg_indexes"
        )
      ) {
        return {
          rows:
            values[0] ===
            "request_relationships"
              ? requestIndexes()
              : conversationIndexes(),
        };
      }

      if (
        compact.includes(
          "select count(*)::bigint as row_count"
        )
      ) {
        return {
          rows: [
            {
              row_count: 0,
            },
          ],
        };
      }

      return {
        rows: [],
      };
    },
    release() {
      resources.releaseCount +=
        1;
    },
  };

  const pool = {
    async connect() {
      resources.connectCount +=
        1;
      if (
        connectFailure
      ) {
        throw new Error(
          rawError
        );
      }
      return client;
    },
    async end() {
      resources.endCount +=
        1;
    },
  };

  return {
    calls,
    ledger,
    resources,
    factory: () =>
      pool,
  };
}

function createFixture() {
  const directory =
    realpathSync(
      mkdtempSync(
        path.join(
          tmpdir(),
          "meetro-production-conversation-prerequisites-"
        )
      )
    );
  for (
    const migration
    of runner.APPROVED_MIGRATIONS
  ) {
    copyFileSync(
      path.join(
        MIGRATIONS_DIRECTORY,
        migration.filename
      ),
      path.join(
        directory,
        migration.filename
      )
    );
  }
  return directory;
}

test(
  "module import is inert and exports only the governed API",
  () => {
    assert.deepEqual(
      Object.keys(
        runner
      ).sort(),
      [
        "APPROVED_MIGRATIONS",
        "REQUIRED_CONFIRMATIONS",
        "authorizeExecution",
        "inspectMigrationSqlScope",
        "inspectProductionConversationPrerequisiteState",
        "loadApprovedMigrations",
        "runCli",
        "runProductionConversationPrerequisites",
        "validatePinnedManifest",
      ]
    );

    const source =
      readFileSync(
        RUNNER_PATH,
        "utf8"
      );
    assert.match(
      source,
      /if\s*\(\s*require\.main\s*===\s*module\s*\)/
    );
    assert.doesNotMatch(
      source,
      /node:child_process|require\(["']child_process/
    );
    assert.doesNotMatch(
      source,
      /\bpsql\b|railway\s+ssh|execSync|spawnSync/i
    );
  }
);

test(
  "exact identity and confirmations authorize with sanitized metadata",
  () => {
    const result =
      runner.authorizeExecution(
        SAFE_ENV
      );
    assert.equal(
      result.authorized,
      true
    );
    assert.deepEqual(
      result.target,
      {
        classification:
          "production",
        protocol:
          "postgresql",
        hostType:
          "railway-private",
        projectName:
          "profound-magic",
        environmentName:
          "production",
        serviceName:
          "athletic-rebirth",
      }
    );
    assert.doesNotMatch(
      JSON.stringify(
        result
      ),
      /private-password|postgres\.railway\.internal/
    );
  }
);

test(
  "authorization rejects every identity confirmation and database mismatch",
  () => {
    const cases = [
      [
        "missing confirmation",
        "CONFIRM_PRODUCTION_PREREQUISITE_MIGRATION",
        undefined,
      ],
      [
        "wrong confirmation",
        "CONFIRM_PRODUCTION_MUTATION",
        "execute",
      ],
      [
        "wrong target",
        "CONFIRM_PRODUCTION_TARGET",
        "profound-magic/production/other",
      ],
      [
        "wrong chain",
        "CONFIRM_PREREQUISITE_MIGRATION_CHAIN",
        "202607200003-202607200002",
      ],
      [
        "staging",
        "RAILWAY_ENVIRONMENT_NAME",
        "staging",
      ],
      [
        "development",
        "NODE_ENV",
        "development",
      ],
      [
        "test",
        "NODE_ENV",
        "test",
      ],
      [
        "wrong project",
        "RAILWAY_PROJECT_NAME",
        "other-project",
      ],
      [
        "wrong service",
        "RAILWAY_SERVICE_NAME",
        "other-service",
      ],
      [
        "hostname as service",
        "RAILWAY_SERVICE_NAME",
        "athletic-rebirth-production.up.railway.app",
      ],
      [
        "local",
        "DATABASE_URL",
        "postgresql://user:pass@localhost/railway",
      ],
      [
        "malformed URL",
        "DATABASE_URL",
        "not-a-url",
      ],
      [
        "non PostgreSQL",
        "DATABASE_URL",
        "https://user:pass@example.com/railway",
      ],
      [
        "missing credentials",
        "DATABASE_URL",
        "postgresql://example.com/railway",
      ],
      [
        "missing URL",
        "DATABASE_URL",
        undefined,
      ],
    ];

    for (const [
      label,
      name,
      value,
    ] of cases) {
      const env = {
        ...SAFE_ENV,
      };
      if (
        value === undefined
      ) {
        delete env[name];
      } else {
        env[name] = value;
      }
      assert.equal(
        runner.authorizeExecution(
          env
        ).authorized,
        false,
        label
      );
    }
  }
);

test(
  "authorization failure occurs before inspection and pool construction",
  async () => {
    let inspectCalls = 0;
    let poolCalls = 0;
    const result =
      await runner
        .runProductionConversationPrerequisites({
          env: {
            ...SAFE_ENV,
            NODE_ENV:
              "staging",
          },
          inspect:
            async () => {
              inspectCalls +=
                1;
            },
          poolFactory:
            () => {
              poolCalls += 1;
            },
        });
    assert.equal(
      result.success,
      false
    );
    assert.equal(
      result.mutationStarted,
      false
    );
    assert.equal(
      inspectCalls,
      0
    );
    assert.equal(
      poolCalls,
      0
    );
  }
);

test(
  "pinned manifest and exact local migration files pass",
  () => {
    assert.equal(
      runner.validatePinnedManifest(),
      true
    );
    assert.deepEqual(
      LOADED_MIGRATIONS.map(
        ({
          filename,
          checksum,
        }) => ({
          filename,
          checksum,
        })
      ),
      runner.APPROVED_MIGRATIONS.map(
        ({
          filename,
          checksum,
        }) => ({
          filename,
          checksum,
        })
      )
    );
  }
);

test(
  "reordered and duplicate manifests fail closed",
  () => {
    assert.throws(
      () =>
        runner.validatePinnedManifest(
          [
            ...runner
              .APPROVED_MIGRATIONS,
          ].reverse()
        ),
      {
        code:
          "MIGRATION_MANIFEST_MISMATCH",
      }
    );
    assert.throws(
      () =>
        runner.validatePinnedManifest(
          [
            runner
              .APPROVED_MIGRATIONS[0],
            runner
              .APPROVED_MIGRATIONS[0],
          ]
        ),
      {
        code:
          "MIGRATION_MANIFEST_MISMATCH",
      }
    );
  }
);

test(
  "missing changed malformed and symlinked migration sources fail",
  (t) => {
    const missing =
      createFixture();
    t.after(() =>
      rmSync(
        missing,
        {
          recursive: true,
          force: true,
        }
      )
    );
    unlinkSync(
      path.join(
        missing,
        APPROVED_FILENAMES[0]
      )
    );
    assert.throws(
      () =>
        runner.loadApprovedMigrations({
          migrationsDirectory:
            missing,
        }),
      {
        code:
          "MIGRATION_FILE_MISSING_OR_DUPLICATE",
      }
    );

    const changed =
      createFixture();
    t.after(() =>
      rmSync(
        changed,
        {
          recursive: true,
          force: true,
        }
      )
    );
    writeFileSync(
      path.join(
        changed,
        APPROVED_FILENAMES[0]
      ),
      "CREATE TABLE request_relationships (id INTEGER);"
    );
    assert.throws(
      () =>
        runner.loadApprovedMigrations({
          migrationsDirectory:
            changed,
        }),
      {
        code:
          "MIGRATION_CHECKSUM_MISMATCH",
      }
    );

    const malformed =
      createFixture();
    t.after(() =>
      rmSync(
        malformed,
        {
          recursive: true,
          force: true,
        }
      )
    );
    writeFileSync(
      path.join(
        malformed,
        "bad-name.sql"
      ),
      "SELECT 1;"
    );
    assert.throws(
      () =>
        runner.loadApprovedMigrations({
          migrationsDirectory:
            malformed,
        }),
      {
        code:
          "MIGRATION_FILENAME_INVALID",
      }
    );

    const escaped =
      createFixture();
    t.after(() =>
      rmSync(
        escaped,
        {
          recursive: true,
          force: true,
        }
      )
    );
    const outside =
      path.join(
        tmpdir(),
        `prerequisite-outside-${process.pid}.sql`
      );
    writeFileSync(
      outside,
      readFileSync(
        path.join(
          escaped,
          APPROVED_FILENAMES[0]
        )
      )
    );
    t.after(() =>
      rmSync(
        outside,
        {
          force: true,
        }
      )
    );
    unlinkSync(
      path.join(
        escaped,
        APPROVED_FILENAMES[0]
      )
    );
    symlinkSync(
      outside,
      path.join(
        escaped,
        APPROVED_FILENAMES[0]
      )
    );
    assert.throws(
      () =>
        runner.loadApprovedMigrations({
          migrationsDirectory:
            escaped,
        }),
      {
        code:
          "MIGRATION_PATH_ESCAPE",
      }
    );
  }
);

test(
  "extra migrations cannot enter the pinned execution collection",
  (t) => {
    const directory =
      createFixture();
    t.after(() =>
      rmSync(
        directory,
        {
          recursive: true,
          force: true,
        }
      )
    );
    writeFileSync(
      path.join(
        directory,
        "202607260001_unrelated_valid_migration.sql"
      ),
      "CREATE TABLE unrelated_fixture (id INTEGER);"
    );
    assert.deepEqual(
      runner
        .loadApprovedMigrations({
          migrationsDirectory:
            directory,
        })
        .map(
          ({ filename }) =>
            filename
        ),
      APPROVED_FILENAMES
    );
  }
);

test(
  "destructive expanded and wrong-object SQL fail before connection",
  () => {
    const migration =
      LOADED_MIGRATIONS[0];
    assert.throws(
      () =>
        runner.inspectMigrationSqlScope(
          migration.filename,
          `${migration.sql}\nTRUNCATE users;`
        ),
      {
        code:
          "MIGRATION_SQL_FORBIDDEN",
      }
    );
    assert.throws(
      () =>
        runner.inspectMigrationSqlScope(
          migration.filename,
          `${migration.sql}\nCREATE INDEX IF NOT EXISTS extra_idx ON request_relationships(status);`
        ),
      {
        code:
          "MIGRATION_SQL_SCOPE_MISMATCH",
      }
    );
    assert.throws(
      () =>
        runner.inspectMigrationSqlScope(
          migration.filename,
          "CREATE TABLE IF NOT EXISTS users (id INTEGER);"
        ),
      {
        code:
          "MIGRATION_SQL_SCOPE_MISMATCH",
      }
    );
  }
);

test(
  "fresh production-shaped preflight is read-only and ready",
  async () => {
    const pool =
      createInspectionPool();
    const result =
      await runner
        .inspectProductionConversationPrerequisiteState({
          env:
            SAFE_ENV,
          poolFactory:
            pool.factory,
        });

    assert.equal(
      result.success,
      true
    );
    assert.equal(
      result.decision,
      "PASS_READY_FOR_PREREQUISITE_MIGRATION"
    );
    assert.equal(
      result.schema
        .classification,
      "ABSENT"
    );
    assert.equal(
      result.dependencies
        .complete,
      true
    );
    assert.deepEqual(
      pool.resources,
      {
        connectCount: 1,
        releaseCount: 1,
        endCount: 1,
      }
    );
    assert.equal(
      pool.calls[0].sql,
      "BEGIN TRANSACTION READ ONLY"
    );
    assert.equal(
      pool.calls.at(-1).sql,
      "ROLLBACK"
    );
    assert.equal(
      pool.calls.some(
        ({ sql }) =>
          /\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE)\b/i.test(
            String(sql)
          )
      ),
      false
    );
  }
);

test(
  "every missing required dependency blocks preflight",
  async () => {
    for (const name of [
      "users",
      "posts",
      "contractorProfiles",
      "schemaMigrations",
    ]) {
      const pool =
        createInspectionPool({
          dependencies: {
            [name]:
              false,
          },
        });
      const result =
        await runner
          .inspectProductionConversationPrerequisiteState({
            env:
              SAFE_ENV,
            poolFactory:
              pool.factory,
          });
      assert.equal(
        result.decision,
        "BLOCKED_MISSING_REQUIRED_DEPENDENCIES",
        name
      );
      assert.equal(
        result.code,
        "PRODUCTION_PREREQUISITE_DEPENDENCIES_MISSING",
        name
      );
      assert.equal(
        result.readOnly,
        true
      );
    }
  }
);

test(
  "partial unrecorded and noncontiguous prerequisite states fail closed",
  async () => {
    const cases = [
      {
        requestState:
          "complete",
      },
      {
        conversationState:
          "complete",
      },
      {
        requestState:
          "complete",
        conversationState:
          "complete",
      },
      {
        requestState:
          "complete",
        ledger:
          approvedLedgerRows()
            .slice(0, 1),
      },
      {
        conversationState:
          "complete",
        ledger:
          approvedLedgerRows()
            .slice(1),
      },
      {
        requestState:
          "incomplete",
        ledger:
          approvedLedgerRows()
            .slice(0, 1),
      },
    ];

    for (const options of cases) {
      const pool =
        createInspectionPool(
          options
        );
      const result =
        await runner
          .inspectProductionConversationPrerequisiteState({
            env:
              SAFE_ENV,
            poolFactory:
              pool.factory,
          });
      assert.equal(
        result.decision,
        "BLOCKED_PARTIAL_OR_UNRECORDED_PREREQUISITES"
      );
      assert.equal(
        result.success,
        false
      );
    }
  }
);

test(
  "checksum drift and duplicate prerequisite ledger entries fail closed",
  async () => {
    const drift =
      approvedLedgerRows();
    drift[0] = {
      ...drift[0],
      checksum:
        "0".repeat(64),
    };
    const duplicate = [
      ...approvedLedgerRows(),
      approvedLedgerRows()[0],
    ];

    const unexpected = [
      {
        filename:
          "202607200002_unapproved_prerequisite.sql",
        checksum:
          "1".repeat(64),
        execution_target:
          "production-governed-conversation-prerequisites",
        applied_at:
          "2026-07-26T00:00:00.000Z",
      },
    ];

    for (const ledger of [
      drift,
      duplicate,
      unexpected,
    ]) {
      const pool =
        createInspectionPool({
          requestState:
            "complete",
          conversationState:
            "complete",
          ledger,
        });
      const result =
        await runner
          .inspectProductionConversationPrerequisiteState({
            env:
              SAFE_ENV,
            poolFactory:
              pool.factory,
          });
      assert.equal(
        result.decision,
        "BLOCKED_PREREQUISITE_LEDGER_CONFLICT"
      );
      assert.equal(
        result.success,
        false
      );
    }
  }
);

test(
  "wrong ledger authority and unapplied rows cannot claim idempotency",
  async () => {
    const wrongTarget =
      approvedLedgerRows();
    wrongTarget[0] = {
      ...wrongTarget[0],
      execution_target:
        "staging",
    };
    const unapplied =
      approvedLedgerRows();
    unapplied[1] = {
      ...unapplied[1],
      applied_at:
        null,
    };

    for (const ledger of [
      wrongTarget,
      unapplied,
    ]) {
      const pool =
        createInspectionPool({
          requestState:
            "complete",
          conversationState:
            "complete",
          ledger,
        });
      const result =
        await runner
          .inspectProductionConversationPrerequisiteState({
            env:
              SAFE_ENV,
            poolFactory:
              pool.factory,
          });
      assert.equal(
        result.decision,
        "BLOCKED_PARTIAL_OR_UNRECORDED_PREREQUISITES"
      );
      assert.equal(
        result.success,
        false
      );
    }
  }
);

test(
  "complete matching prerequisite state is idempotently recognized",
  async () => {
    const pool =
      createInspectionPool({
        requestState:
          "complete",
        conversationState:
          "complete",
        ledger:
          approvedLedgerRows(),
      });
    const result =
      await runner
        .inspectProductionConversationPrerequisiteState({
          env:
            SAFE_ENV,
          poolFactory:
            pool.factory,
        });
    assert.equal(
      result.success,
      true
    );
    assert.equal(
      result.decision,
      "ALREADY_APPLIED"
    );
    assert.equal(
      result.code,
      "PRODUCTION_CONVERSATION_PREREQUISITES_READY"
    );
  }
);

test(
  "database identity mismatch and query failures are sanitized and rolled back",
  async () => {
    for (const options of [
      {
        databaseName:
          "other_database",
      },
      {
        serverVersion:
          110000,
      },
      {
        failQuery:
          "from information_schema.columns",
      },
    ]) {
      const pool =
        createInspectionPool(
          options
        );
      const result =
        await runner
          .inspectProductionConversationPrerequisiteState({
            env:
              SAFE_ENV,
            poolFactory:
              pool.factory,
          });
      assert.equal(
        result.success,
        false
      );
      assert.equal(
        pool.calls.at(-1).sql,
        "ROLLBACK"
      );
      assert.doesNotMatch(
        JSON.stringify(
          result
        ),
        /private-password|postgres\.railway\.internal|other_database/
      );
    }
  }
);

test(
  "fresh execution applies both migrations in exact governed order",
  async () => {
    const inspect =
      sequenceInspector([
        readyReport(),
        completeReport(),
      ]);
    const pool =
      createExecutionPool();
    const result =
      await runner
        .runProductionConversationPrerequisites({
          env:
            SAFE_ENV,
          inspect,
          poolFactory:
            pool.factory,
        });

    assert.equal(
      result.success,
      true
    );
    assert.equal(
      result.decision,
      "APPLIED_AND_VERIFIED"
    );
    assert.equal(
      result.code,
      "PRODUCTION_CONVERSATION_PREREQUISITES_APPLIED"
    );
    assert.equal(
      result.mutationStarted,
      true
    );
    assert.deepEqual(
      result.execution
        .committed,
      APPROVED_FILENAMES
    );
    assert.deepEqual(
      result.execution
        .notAttempted,
      []
    );
    assert.equal(
      inspect.calls.length,
      2
    );
    assert.deepEqual(
      pool.resources,
      {
        connectCount: 1,
        releaseCount: 1,
        endCount: 1,
      }
    );

    const sqlCalls =
      pool.calls.map(
        ({ sql }) => sql
      );
    assert.equal(
      sqlCalls.filter(
        (sql) =>
          sql === "BEGIN"
      ).length,
      2
    );
    assert.equal(
      sqlCalls.filter(
        (sql) =>
          sql === "COMMIT"
      ).length,
      2
    );
    assert.equal(
      pool.calls.filter(
        ({ sql }) =>
          String(sql).includes(
            "pg_advisory_xact_lock"
          )
      ).length,
      2
    );

    for (
      let index = 0;
      index <
      LOADED_MIGRATIONS.length;
      index += 1
    ) {
      const migration =
        LOADED_MIGRATIONS[
          index
        ];
      const migrationPosition =
        sqlCalls.indexOf(
          migration.sql
        );
      const verificationPosition =
        pool.calls.findIndex(
          (
            {
              sql,
              values,
            },
            position
          ) =>
            position >
              migrationPosition &&
            String(sql).includes(
              "to_regclass($1)"
            ) &&
            values[0] ===
              `public.${
                index === 0
                  ? "request_relationships"
                  : "conversations"
              }`
        );
      const ledgerPosition =
        pool.calls.findIndex(
          (
            {
              sql,
              values,
            },
            position
          ) =>
            position >
              verificationPosition &&
            /INSERT INTO schema_migrations/.test(
              sql
            ) &&
            values[0] ===
              migration.filename
        );
      const commitPosition =
        sqlCalls.indexOf(
          "COMMIT",
          ledgerPosition
        );
      assert.ok(
        migrationPosition <
          verificationPosition
      );
      assert.ok(
        verificationPosition <
          ledgerPosition
      );
      assert.ok(
        ledgerPosition <
          commitPosition
      );
    }
  }
);

test(
  "preflight rejection constructs no mutation pool",
  async () => {
    const reports = [
      readyReport({
        success: false,
        decision:
          "BLOCKED_MISSING_REQUIRED_DEPENDENCIES",
        code:
          "PRODUCTION_PREREQUISITE_DEPENDENCIES_MISSING",
        dependencies: {
          ...completeDependencies(),
          posts: false,
          complete: false,
        },
      }),
      readyReport({
        ledger: {
          ...readyReport()
            .ledger,
          entries:
            publicLedgerEntries()
              .slice(1),
        },
      }),
      readyReport({
        schema: {
          classification:
            "PARTIAL",
          requestRelationships: {
            exists: true,
            complete: true,
          },
          conversations: {
            exists: false,
            complete: false,
          },
        },
      }),
    ];

    for (const report of reports) {
      let poolCalls = 0;
      const result =
        await runner
          .runProductionConversationPrerequisites({
            env:
              SAFE_ENV,
            inspect:
              sequenceInspector([
                report,
              ]),
            poolFactory:
              () => {
                poolCalls +=
                  1;
              },
          });
      assert.equal(
        result.code,
        "PREFLIGHT_STATE_BLOCKED"
      );
      assert.equal(
        result.mutationStarted,
        false
      );
      assert.equal(
        poolCalls,
        0
      );
    }
  }
);

test(
  "migration failures roll back current work and stop later files",
  async () => {
    for (const [
      failMigrationIndex,
      committed,
      notAttempted,
    ] of [
      [
        0,
        [],
        [
          APPROVED_FILENAMES[1],
        ],
      ],
      [
        1,
        [
          APPROVED_FILENAMES[0],
        ],
        [],
      ],
    ]) {
      const pool =
        createExecutionPool({
          failMigrationIndex,
        });
      const result =
        await runner
          .runProductionConversationPrerequisites({
            env:
              SAFE_ENV,
            inspect:
              sequenceInspector([
                readyReport(),
              ]),
            poolFactory:
              pool.factory,
          });
      assert.equal(
        result.code,
        "MIGRATION_EXECUTION_FAILED"
      );
      assert.deepEqual(
        result.execution
          .committed,
        committed
      );
      assert.equal(
        result.execution
          .failedMigration,
        APPROVED_FILENAMES[
          failMigrationIndex
        ]
      );
      assert.deepEqual(
        result.execution
          .notAttempted,
        notAttempted
      );
      assert.equal(
        pool.calls.filter(
          ({ sql }) =>
            sql ===
            "ROLLBACK"
        ).length,
        1
      );
      if (
        failMigrationIndex ===
        0
      ) {
        assert.equal(
          pool.calls.some(
            ({ sql }) =>
              sql ===
              LOADED_MIGRATIONS[1]
                .sql
          ),
          false
        );
      }
      assert.doesNotMatch(
        JSON.stringify(
          result
        ),
        /private-password|postgres\.railway\.internal/
      );
    }
  }
);

test(
  "schema changes after preflight are rejected under the advisory lock",
  async () => {
    const pool =
      createExecutionPool({
        initialRequestTable:
          true,
      });
    const result =
      await runner
        .runProductionConversationPrerequisites({
          env:
            SAFE_ENV,
          inspect:
            sequenceInspector([
              readyReport(),
            ]),
          poolFactory:
            pool.factory,
        });

    assert.equal(
      result.code,
      "MIGRATION_SCHEMA_CONFLICT"
    );
    assert.equal(
      result.mutationStarted,
      false
    );
    assert.deepEqual(
      result.execution
        .committed,
      []
    );
    assert.equal(
      pool.calls.some(
        ({ sql }) =>
          sql ===
          LOADED_MIGRATIONS[0]
            .sql
      ),
      false
    );
  }
);

test(
  "effect and ledger failures never commit the current migration",
  async () => {
    for (const [
      options,
      code,
    ] of [
      [
        {
          failVerificationIndex:
            0,
        },
        "MIGRATION_EFFECT_VERIFICATION_FAILED",
      ],
      [
        {
          failLedgerIndex:
            0,
        },
        "MIGRATION_EXECUTION_FAILED",
      ],
    ]) {
      const pool =
        createExecutionPool(
          options
        );
      const result =
        await runner
          .runProductionConversationPrerequisites({
            env:
              SAFE_ENV,
            inspect:
              sequenceInspector([
                readyReport(),
              ]),
            poolFactory:
              pool.factory,
          });
      assert.equal(
        result.code,
        code
      );
      assert.deepEqual(
        result.execution
          .committed,
        []
      );
      assert.equal(
        pool.calls.filter(
          ({ sql }) =>
            sql === "COMMIT"
        ).length,
        0
      );
      assert.equal(
        pool.calls.filter(
          ({ sql }) =>
            sql ===
            "ROLLBACK"
        ).length,
        1
      );
    }
  }
);

test(
  "connection failure is sanitized and releases the pool",
  async () => {
    const pool =
      createExecutionPool({
        connectFailure: true,
      });
    const result =
      await runner
        .runProductionConversationPrerequisites({
          env:
            SAFE_ENV,
          inspect:
            sequenceInspector([
              readyReport(),
            ]),
          poolFactory:
            pool.factory,
        });
    assert.equal(
      result.code,
      "DATABASE_CONNECTION_FAILED"
    );
    assert.equal(
      result.mutationStarted,
      false
    );
    assert.equal(
      pool.resources.endCount,
      1
    );
    assert.doesNotMatch(
      JSON.stringify(
        result
      ),
      /private-password|postgres\.railway\.internal/
    );
  }
);

test(
  "already applied state executes no SQL and returns idempotent success",
  async () => {
    let poolCalls = 0;
    const result =
      await runner
        .runProductionConversationPrerequisites({
          env:
            SAFE_ENV,
          inspect:
            sequenceInspector([
              completeReport(),
            ]),
          poolFactory:
            () => {
              poolCalls += 1;
            },
        });
    assert.equal(
      result.success,
      true
    );
    assert.equal(
      result.decision,
      "ALREADY_APPLIED"
    );
    assert.equal(
      result.code,
      "PRODUCTION_CONVERSATION_PREREQUISITES_ALREADY_APPLIED"
    );
    assert.equal(
      result.mutationStarted,
      false
    );
    assert.equal(
      poolCalls,
      0
    );
  }
);

test(
  "postflight must prove complete schema and exact ledger without correction",
  async () => {
    const pool =
      createExecutionPool();
    const result =
      await runner
        .runProductionConversationPrerequisites({
          env:
            SAFE_ENV,
          inspect:
            sequenceInspector([
              readyReport(),
              readyReport({
                success: false,
                decision:
                  "BLOCKED_PARTIAL_OR_UNRECORDED_PREREQUISITES",
                code:
                  "PRODUCTION_CONVERSATION_PREREQUISITES_REQUIRE_REVIEW",
              }),
            ]),
          poolFactory:
            pool.factory,
        });
    assert.equal(
      result.code,
      "POSTFLIGHT_STATE_INVALID"
    );
    assert.deepEqual(
      result.execution
        .committed,
      APPROVED_FILENAMES
    );
    assert.equal(
      pool.calls.some(
        ({ sql }) =>
          /\b(DELETE\s+FROM|UPDATE|TRUNCATE|DROP)\b/i.test(
            String(sql)
          )
      ),
      false
    );
  }
);

test(
  "CLI emits one sanitized JSON object with exit codes zero one and two",
  async () => {
    const cases = [
      [
        0,
        {
          success: true,
          decision:
            "APPLIED_AND_VERIFIED",
          code:
            "PRODUCTION_CONVERSATION_PREREQUISITES_APPLIED",
          mutationStarted:
            true,
        },
      ],
      [
        2,
        {
          success: true,
          decision:
            "ALREADY_APPLIED",
          code:
            "PRODUCTION_CONVERSATION_PREREQUISITES_ALREADY_APPLIED",
          mutationStarted:
            false,
        },
      ],
      [
        1,
        {
          success: false,
          decision:
            "FAIL",
          code:
            "SAFE_FAILURE",
          mutationStarted:
            false,
        },
      ],
    ];

    for (const [
      expectedExit,
      result,
    ] of cases) {
      const output = [];
      const exitCode =
        await runner.runCli({
          env:
            SAFE_ENV,
          run:
            async () =>
              result,
          write:
            (value) =>
              output.push(
                value
              ),
        });
      assert.equal(
        exitCode,
        expectedExit
      );
      assert.equal(
        output.length,
        1
      );
      assert.deepEqual(
        JSON.parse(
          output[0]
        ),
        result
      );
    }
  }
);

test(
  "CLI normalizes malformed results and unexpected exceptions",
  async () => {
    for (const run of [
      async () => ({
        malformed: true,
      }),
      async () => {
        throw new Error(
          "private-password raw SQL DROP TABLE users"
        );
      },
    ]) {
      const output = [];
      const exitCode =
        await runner.runCli({
          env:
            SAFE_ENV,
          run,
          write:
            (value) =>
              output.push(
                value
              ),
        });
      assert.equal(
        exitCode,
        1
      );
      assert.equal(
        output.length,
        1
      );
      assert.equal(
        JSON.parse(
          output[0]
        ).decision,
        "FAIL"
      );
      assert.doesNotMatch(
        output[0],
        /private-password|DROP TABLE|postgres\.railway\.internal/
      );
    }
  }
);

test(
  "README package and generic runner preserve separate production governance",
  () => {
    const packageJson =
      JSON.parse(
        readFileSync(
          PACKAGE_PATH,
          "utf8"
        )
      );
    assert.equal(
      packageJson.scripts[
        "migrate:production:conversation-prerequisites"
      ],
      undefined
    );

    const readme =
      readFileSync(
        README_PATH,
        "utf8"
      );
    assert.match(
      readme,
      /conversation prerequisite/i
    );
    assert.match(
      readme,
      /separate dedicated production\s+conversation prerequisite runner/i
    );

    const genericProduction =
      genericRunner
        .inspectMigrationExecutionTarget({
          DATABASE_URL:
            "postgresql://user:pass@example.com/meetro_production",
          MIGRATION_TARGET:
            "production",
          CONFIRM_MIGRATION_TARGET:
            "production",
        });
    assert.equal(
      genericProduction.safe,
      false
    );
  }
);

test(
  "mock execution contains no unapproved application-data mutation",
  async () => {
    const pool =
      createExecutionPool();
    await runner
      .runProductionConversationPrerequisites({
        env:
          SAFE_ENV,
        inspect:
          sequenceInspector([
            readyReport(),
            completeReport(),
          ]),
        poolFactory:
          pool.factory,
      });

    const mutationSql =
      pool.calls
        .map(
          ({ sql }) =>
            String(sql)
        )
        .filter(
          (sql) =>
            /\b(INSERT|CREATE|ALTER|UPDATE|DELETE|DROP|TRUNCATE)\b/i.test(
              sql.replace(
                /--[^\r\n]*/g,
                " "
              )
            )
        );
    assert.equal(
      mutationSql.some(
        (sql) =>
          /\b(UPDATE|DELETE\s+FROM|DROP|TRUNCATE)\b/i.test(
            sql
          )
      ),
      false
    );
    assert.equal(
      mutationSql.filter(
        (sql) =>
          /INSERT INTO schema_migrations/i.test(
            sql
          )
      ).length,
      2
    );
  }
);
