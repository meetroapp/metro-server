#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");

const MIGRATIONS_DIRECTORY = path.join(
  __dirname,
  "..",
  "migrations"
);

const APPROVED_MIGRATIONS = Object.freeze([
  Object.freeze({
    filename:
      "202607200002_create_request_relationships.sql",
    checksum:
      "8b0ad74b021e7cf560ed1e7a88899013bf2c8363c07b45a49f2de631489acd54",
  }),
  Object.freeze({
    filename:
      "202607200003_create_conversations.sql",
    checksum:
      "5fa1e5a7d573c0ac62fbab255356435b1010f4c86458228c22fe9a7c23151556",
  }),
]);

const REQUIRED_CONFIRMATIONS = Object.freeze({
  CONFIRM_PRODUCTION_PREREQUISITE_MIGRATION:
    "YES",
  CONFIRM_PRODUCTION_TARGET:
    "profound-magic/production/athletic-rebirth",
  CONFIRM_PREREQUISITE_MIGRATION_CHAIN:
    "202607200002-202607200003",
  CONFIRM_PRODUCTION_MUTATION:
    "EXECUTE",
});

const EXPECTED_IDENTITY = Object.freeze({
  NODE_ENV: "production",
  RAILWAY_PROJECT_NAME: "profound-magic",
  RAILWAY_ENVIRONMENT_NAME: "production",
  RAILWAY_SERVICE_NAME: "athletic-rebirth",
});

const EXECUTION_TARGET =
  "production-governed-conversation-prerequisites";
const ADVISORY_LOCK_ID = 481005042;
const MINIMUM_POSTGRES_VERSION = 120000;
const MIGRATION_FILENAME_PATTERN =
  /^\d{12}_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;

const FORBIDDEN_SQL = Object.freeze([
  /\bDROP\s+(?:DATABASE|SCHEMA|TABLE|INDEX|VIEW|TYPE|FUNCTION|PROCEDURE)\b/i,
  /\bTRUNCATE\b/i,
  /\bDELETE\s+FROM\b/i,
  /\bUPDATE\b/i,
  /\bINSERT\s+INTO\b/i,
  /\bALTER\s+(?:TABLE|ROLE)\b/i,
  /\bCREATE\s+ROLE\b/i,
  /\bGRANT\b/i,
  /\bREVOKE\b/i,
  /(^|\s)\\?copy\b/i,
  /\bVACUUM\b/i,
  /\bREINDEX\b/i,
  /\bCLUSTER\b/i,
]);

const REQUIRED_SQL_SCOPE = Object.freeze({
  "202607200002_create_request_relationships.sql":
    Object.freeze({
      table: "request_relationships",
      references: Object.freeze([
        "contractor_profiles",
        "posts",
        "users",
      ]),
      indexes: Object.freeze([
        "request_relationships_homeowner_idx",
        "request_relationships_post_idx",
        "request_relationships_professional_idx",
      ]),
      patterns: Object.freeze([
        /post_id\s+INTEGER\s+NOT\s+NULL\s+REFERENCES\s+posts\(id\)/i,
        /homeowner_id\s+INTEGER\s+NOT\s+NULL\s+REFERENCES\s+users\(id\)/i,
        /contractor_id\s+INTEGER\s+NOT\s+NULL\s+REFERENCES\s+contractor_profiles\(id\)/i,
        /professional_user_id\s+INTEGER\s+NOT\s+NULL\s+REFERENCES\s+users\(id\)/i,
        /request_relationships_unique_response/i,
        /request_relationships_different_users/i,
        /status\s+IN\s*\(\s*'pending'[\s\S]*'active'[\s\S]*'declined'[\s\S]*'withdrawn'[\s\S]*'closed'/i,
      ]),
    }),
  "202607200003_create_conversations.sql":
    Object.freeze({
      table: "conversations",
      references: Object.freeze([
        "contractor_profiles",
        "request_relationships",
        "users",
      ]),
      indexes: Object.freeze([
        "conversations_contractor_idx",
        "conversations_homeowner_idx",
        "conversations_professional_idx",
        "conversations_status_idx",
      ]),
      patterns: Object.freeze([
        /relationship_id\s+INTEGER\s+NOT\s+NULL\s+REFERENCES\s+request_relationships\(id\)/i,
        /homeowner_id\s+INTEGER\s+NOT\s+NULL\s+REFERENCES\s+users\(id\)/i,
        /contractor_id\s+INTEGER\s+NOT\s+NULL\s+REFERENCES\s+contractor_profiles\(id\)/i,
        /professional_user_id\s+INTEGER\s+NOT\s+NULL\s+REFERENCES\s+users\(id\)/i,
        /conversations_unique_relationship/i,
        /conversations_different_users/i,
        /status\s+IN\s*\(\s*'active'[\s\S]*'closed'/i,
        /homeowner_archived_at\s+TIMESTAMP/i,
        /professional_archived_at\s+TIMESTAMP/i,
        /closed_at\s+TIMESTAMP/i,
      ]),
    }),
});

const EXPECTED_COLUMNS = Object.freeze({
  request_relationships: Object.freeze({
    id: Object.freeze(["integer", "NO", true]),
    post_id: Object.freeze(["integer", "NO", false]),
    homeowner_id: Object.freeze(["integer", "NO", false]),
    contractor_id: Object.freeze(["integer", "NO", false]),
    professional_user_id: Object.freeze([
      "integer",
      "NO",
      false,
    ]),
    status: Object.freeze(["text", "NO", true]),
    introduction_text: Object.freeze([
      "text",
      "NO",
      true,
    ]),
    responded_at: Object.freeze([
      "timestamp without time zone",
      "NO",
      true,
    ]),
    accepted_at: Object.freeze([
      "timestamp without time zone",
      "YES",
      false,
    ]),
    declined_at: Object.freeze([
      "timestamp without time zone",
      "YES",
      false,
    ]),
    withdrawn_at: Object.freeze([
      "timestamp without time zone",
      "YES",
      false,
    ]),
    closed_at: Object.freeze([
      "timestamp without time zone",
      "YES",
      false,
    ]),
    created_at: Object.freeze([
      "timestamp without time zone",
      "NO",
      true,
    ]),
    updated_at: Object.freeze([
      "timestamp without time zone",
      "NO",
      true,
    ]),
  }),
  conversations: Object.freeze({
    id: Object.freeze(["integer", "NO", true]),
    relationship_id: Object.freeze([
      "integer",
      "NO",
      false,
    ]),
    homeowner_id: Object.freeze(["integer", "NO", false]),
    contractor_id: Object.freeze(["integer", "NO", false]),
    professional_user_id: Object.freeze([
      "integer",
      "NO",
      false,
    ]),
    status: Object.freeze(["text", "NO", true]),
    homeowner_archived_at: Object.freeze([
      "timestamp without time zone",
      "YES",
      false,
    ]),
    professional_archived_at: Object.freeze([
      "timestamp without time zone",
      "YES",
      false,
    ]),
    closed_at: Object.freeze([
      "timestamp without time zone",
      "YES",
      false,
    ]),
    created_at: Object.freeze([
      "timestamp without time zone",
      "NO",
      true,
    ]),
    updated_at: Object.freeze([
      "timestamp without time zone",
      "NO",
      true,
    ]),
  }),
});

const EXPECTED_CONSTRAINTS = Object.freeze({
  request_relationships: Object.freeze([
    Object.freeze({
      type: "PRIMARY KEY",
      patterns: Object.freeze([/\(id\)/i]),
    }),
    Object.freeze({
      type: "FOREIGN KEY",
      patterns: Object.freeze([
        /\(post_id\)/i,
        /REFERENCES\s+(?:public\.)?posts\(id\)/i,
      ]),
    }),
    Object.freeze({
      type: "FOREIGN KEY",
      patterns: Object.freeze([
        /\(homeowner_id\)/i,
        /REFERENCES\s+(?:public\.)?users\(id\)/i,
      ]),
    }),
    Object.freeze({
      type: "FOREIGN KEY",
      patterns: Object.freeze([
        /\(contractor_id\)/i,
        /REFERENCES\s+(?:public\.)?contractor_profiles\(id\)/i,
      ]),
    }),
    Object.freeze({
      type: "FOREIGN KEY",
      patterns: Object.freeze([
        /\(professional_user_id\)/i,
        /REFERENCES\s+(?:public\.)?users\(id\)/i,
      ]),
    }),
    Object.freeze({
      type: "CHECK",
      patterns: Object.freeze([
        /status/i,
        /pending/i,
        /active/i,
        /declined/i,
        /withdrawn/i,
        /closed/i,
      ]),
    }),
    Object.freeze({
      type: "UNIQUE",
      patterns: Object.freeze([
        /\(post_id,\s*contractor_id\)/i,
      ]),
    }),
    Object.freeze({
      type: "CHECK",
      patterns: Object.freeze([
        /homeowner_id/i,
        /professional_user_id/i,
        /<>/,
      ]),
    }),
  ]),
  conversations: Object.freeze([
    Object.freeze({
      type: "PRIMARY KEY",
      patterns: Object.freeze([/\(id\)/i]),
    }),
    Object.freeze({
      type: "FOREIGN KEY",
      patterns: Object.freeze([
        /\(relationship_id\)/i,
        /REFERENCES\s+(?:public\.)?request_relationships\(id\)/i,
      ]),
    }),
    Object.freeze({
      type: "FOREIGN KEY",
      patterns: Object.freeze([
        /\(homeowner_id\)/i,
        /REFERENCES\s+(?:public\.)?users\(id\)/i,
      ]),
    }),
    Object.freeze({
      type: "FOREIGN KEY",
      patterns: Object.freeze([
        /\(contractor_id\)/i,
        /REFERENCES\s+(?:public\.)?contractor_profiles\(id\)/i,
      ]),
    }),
    Object.freeze({
      type: "FOREIGN KEY",
      patterns: Object.freeze([
        /\(professional_user_id\)/i,
        /REFERENCES\s+(?:public\.)?users\(id\)/i,
      ]),
    }),
    Object.freeze({
      type: "CHECK",
      patterns: Object.freeze([
        /status/i,
        /active/i,
        /closed/i,
      ]),
    }),
    Object.freeze({
      type: "UNIQUE",
      patterns: Object.freeze([
        /\(relationship_id\)/i,
      ]),
    }),
    Object.freeze({
      type: "CHECK",
      patterns: Object.freeze([
        /homeowner_id/i,
        /professional_user_id/i,
        /<>/,
      ]),
    }),
  ]),
});

const EXPECTED_STATUS_VALUES =
  Object.freeze({
    request_relationships:
      Object.freeze([
        "pending",
        "active",
        "declined",
        "withdrawn",
        "closed",
      ]),
    conversations:
      Object.freeze([
        "active",
        "closed",
      ]),
  });

const EXPECTED_INDEXES = Object.freeze({
  request_relationships: Object.freeze([
    Object.freeze({
      name: "request_relationships_homeowner_idx",
      patterns: Object.freeze([/\(homeowner_id\)/i]),
    }),
    Object.freeze({
      name: "request_relationships_professional_idx",
      patterns: Object.freeze([/\(professional_user_id\)/i]),
    }),
    Object.freeze({
      name: "request_relationships_post_idx",
      patterns: Object.freeze([/\(post_id\)/i]),
    }),
  ]),
  conversations: Object.freeze([
    Object.freeze({
      name: "conversations_homeowner_idx",
      patterns: Object.freeze([/\(homeowner_id\)/i]),
    }),
    Object.freeze({
      name: "conversations_professional_idx",
      patterns: Object.freeze([/\(professional_user_id\)/i]),
    }),
    Object.freeze({
      name: "conversations_contractor_idx",
      patterns: Object.freeze([/\(contractor_id\)/i]),
    }),
    Object.freeze({
      name: "conversations_status_idx",
      patterns: Object.freeze([/\(status\)/i]),
    }),
  ]),
});

const TABLES = Object.freeze([
  "request_relationships",
  "conversations",
]);

const INSPECTION_SQL = Object.freeze({
  databaseIdentity: `
    SELECT
      current_database() AS database_name,
      current_setting('server_version_num')::integer
        AS server_version_num
  `,
  dependencyColumns: `
    SELECT table_name, column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = ANY($1::text[])
    ORDER BY table_name, ordinal_position
  `,
  dependencyConstraints: `
    SELECT
      relation.relname AS table_name,
      constraint_record.contype AS constraint_type,
      pg_get_constraintdef(constraint_record.oid)
        AS constraint_definition
    FROM pg_catalog.pg_constraint constraint_record
    INNER JOIN pg_catalog.pg_class relation
      ON relation.oid = constraint_record.conrelid
    INNER JOIN pg_catalog.pg_namespace namespace
      ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relname = ANY($1::text[])
    ORDER BY relation.relname, constraint_record.conname
  `,
  ledger: `
    SELECT filename, checksum, execution_target, applied_at
    FROM schema_migrations
    WHERE filename = ANY($1::text[])
      OR filename LIKE '202607200002%'
      OR filename LIKE '202607200003%'
    ORDER BY filename, applied_at
  `,
  tableExists: `
    SELECT to_regclass($1) IS NOT NULL AS exists
  `,
  columns: `
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = $1
    ORDER BY ordinal_position
  `,
  constraints: `
    SELECT
      constraint_record.conname AS constraint_name,
      CASE constraint_record.contype
        WHEN 'p' THEN 'PRIMARY KEY'
        WHEN 'f' THEN 'FOREIGN KEY'
        WHEN 'u' THEN 'UNIQUE'
        WHEN 'c' THEN 'CHECK'
        ELSE constraint_record.contype::text
      END AS constraint_type,
      pg_get_constraintdef(constraint_record.oid)
        AS constraint_definition
    FROM pg_catalog.pg_constraint constraint_record
    INNER JOIN pg_catalog.pg_class relation
      ON relation.oid = constraint_record.conrelid
    INNER JOIN pg_catalog.pg_namespace namespace
      ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relname = $1
    ORDER BY constraint_record.conname
  `,
  indexes: `
    SELECT indexname AS index_name, indexdef AS index_definition
    FROM pg_catalog.pg_indexes
    WHERE schemaname = 'public'
      AND tablename = $1
    ORDER BY indexname
  `,
});

const EMPTY_ROW_SQL = Object.freeze({
  request_relationships: `
    SELECT COUNT(*)::bigint AS row_count
    FROM request_relationships
  `,
  conversations: `
    SELECT COUNT(*)::bigint AS row_count
    FROM conversations
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
  if (
    typeof value !== "string" ||
    !value.trim()
  ) {
    return null;
  }

  try {
    const parsed = new URL(value);
    if (
      ![
        "postgres:",
        "postgresql:",
      ].includes(parsed.protocol) ||
      !parsed.username ||
      !parsed.password ||
      !parsed.hostname ||
      !parsed.pathname ||
      parsed.pathname === "/"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function isRailwayPrivateHost(
  hostname = ""
) {
  const normalized =
    String(hostname).toLowerCase();
  return (
    normalized ===
      "railway.internal" ||
    normalized.endsWith(
      ".railway.internal"
    )
  );
}

function sanitizedTarget(
  env = {},
  parsed = parseDatabaseUrl(
    env.DATABASE_URL
  )
) {
  const identityMatches =
    Object.entries(
      EXPECTED_IDENTITY
    ).every(
      ([name, value]) =>
        env[name] === value
    );

  return {
    classification:
      identityMatches &&
      parsed &&
      isRailwayPrivateHost(
        parsed.hostname
      )
        ? "production"
        : "rejected",
    protocol:
      parsed
        ? parsed.protocol.replace(
            /:$/,
            ""
          )
        : "invalid",
    hostType:
      parsed &&
      isRailwayPrivateHost(
        parsed.hostname
      )
        ? "railway-private"
        : "rejected",
    projectName:
      env.RAILWAY_PROJECT_NAME ===
      EXPECTED_IDENTITY
        .RAILWAY_PROJECT_NAME
        ? EXPECTED_IDENTITY
            .RAILWAY_PROJECT_NAME
        : "mismatch",
    environmentName:
      env.RAILWAY_ENVIRONMENT_NAME ===
      EXPECTED_IDENTITY
        .RAILWAY_ENVIRONMENT_NAME
        ? EXPECTED_IDENTITY
            .RAILWAY_ENVIRONMENT_NAME
        : "mismatch",
    serviceName:
      env.RAILWAY_SERVICE_NAME ===
      EXPECTED_IDENTITY
        .RAILWAY_SERVICE_NAME
        ? EXPECTED_IDENTITY
            .RAILWAY_SERVICE_NAME
        : "mismatch",
  };
}

function authorizeExecution(
  env = {}
) {
  const parsed =
    parseDatabaseUrl(
      env.DATABASE_URL
    );
  const checks = [
    [
      env.NODE_ENV ===
        EXPECTED_IDENTITY.NODE_ENV,
      "AUTH_NODE_ENV_MISMATCH",
    ],
    [
      env.RAILWAY_PROJECT_NAME ===
        EXPECTED_IDENTITY
          .RAILWAY_PROJECT_NAME,
      "AUTH_PROJECT_MISMATCH",
    ],
    [
      env.RAILWAY_ENVIRONMENT_NAME ===
        EXPECTED_IDENTITY
          .RAILWAY_ENVIRONMENT_NAME,
      "AUTH_ENVIRONMENT_MISMATCH",
    ],
    [
      env.RAILWAY_SERVICE_NAME ===
        EXPECTED_IDENTITY
          .RAILWAY_SERVICE_NAME,
      "AUTH_SERVICE_MISMATCH",
    ],
    ...Object.entries(
      REQUIRED_CONFIRMATIONS
    ).map(
      ([name, value]) => [
        env[name] === value,
        `AUTH_${name}_MISMATCH`,
      ]
    ),
    [
      Boolean(parsed),
      "AUTH_DATABASE_URL_INVALID",
    ],
    [
      Boolean(
        parsed &&
          isRailwayPrivateHost(
            parsed.hostname
          )
      ),
      "AUTH_DATABASE_TARGET_INVALID",
    ],
  ];
  const failed =
    checks.find(
      ([passed]) => !passed
    );

  return {
    authorized:
      !failed,
    code:
      failed
        ? failed[1]
        : "PRODUCTION_CONVERSATION_PREREQUISITE_MIGRATION_AUTHORIZED",
    target:
      sanitizedTarget(
        env,
        parsed
      ),
  };
}

function sha256(value) {
  return crypto
    .createHash("sha256")
    .update(value)
    .digest("hex");
}

function stripSqlComments(sql) {
  return String(sql)
    .replace(
      /\/\*[\s\S]*?\*\//g,
      " "
    )
    .replace(
      /--[^\r\n]*/g,
      " "
    );
}

function sameStringSet(
  actual,
  expected
) {
  return (
    actual.length ===
      expected.length &&
    [...actual]
      .sort()
      .every(
        (value, index) =>
          value ===
          [...expected].sort()[
            index
          ]
      )
  );
}

function inspectMigrationSqlScope(
  filename,
  sql
) {
  const scope =
    REQUIRED_SQL_SCOPE[
      filename
    ];
  if (!scope) {
    fail(
      "MIGRATION_SCOPE_UNAPPROVED"
    );
  }

  const source =
    stripSqlComments(sql);
  if (
    FORBIDDEN_SQL.some(
      (pattern) =>
        pattern.test(source)
    )
  ) {
    fail(
      "MIGRATION_SQL_FORBIDDEN"
    );
  }

  const statements =
    source
      .split(";")
      .map(
        (statement) =>
          statement.trim()
      )
      .filter(Boolean);
  const expectedStatementCount =
    1 + scope.indexes.length;
  if (
    statements.length !==
      expectedStatementCount ||
    !new RegExp(
      `^CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+${scope.table}\\b`,
      "i"
    ).test(statements[0])
  ) {
    fail(
      "MIGRATION_SQL_SCOPE_MISMATCH"
    );
  }

  const indexes = [];
  for (
    const statement
    of statements.slice(1)
  ) {
    const match =
      statement.match(
        /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+([a-z0-9_]+)\s+ON\s+([a-z0-9_]+)\b/i
      );
    if (
      !match ||
      match[2].toLowerCase() !==
        scope.table
    ) {
      fail(
        "MIGRATION_SQL_SCOPE_MISMATCH"
      );
    }
    indexes.push(
      match[1].toLowerCase()
    );
  }

  const references =
    [
      ...source.matchAll(
        /\bREFERENCES\s+([a-z0-9_]+)\s*\(/gi
      ),
    ].map(
      (match) =>
        match[1].toLowerCase()
    );

  if (
    !sameStringSet(
      [...new Set(indexes)],
      scope.indexes
    ) ||
    !sameStringSet(
      [...new Set(references)],
      scope.references
    ) ||
    !scope.patterns.every(
      (pattern) =>
        pattern.test(source)
    )
  ) {
    fail(
      "MIGRATION_SQL_SCOPE_MISMATCH"
    );
  }

  return true;
}

function validatePinnedManifest(
  manifest = APPROVED_MIGRATIONS
) {
  if (
    !Array.isArray(manifest) ||
    manifest.length !==
      APPROVED_MIGRATIONS.length
  ) {
    fail(
      "MIGRATION_MANIFEST_MISMATCH"
    );
  }

  const seen = new Set();
  for (
    let index = 0;
    index <
    APPROVED_MIGRATIONS.length;
    index += 1
  ) {
    const expected =
      APPROVED_MIGRATIONS[index];
    const actual =
      manifest[index];
    if (
      !actual ||
      actual.filename !==
        expected.filename ||
      actual.checksum !==
        expected.checksum ||
      seen.has(actual.filename)
    ) {
      fail(
        "MIGRATION_MANIFEST_MISMATCH"
      );
    }
    seen.add(actual.filename);
  }

  return true;
}

function loadApprovedMigrations(
  options = {}
) {
  validatePinnedManifest();
  const fileSystem =
    options.fileSystem || fs;
  const migrationsDirectory =
    path.resolve(
      options.migrationsDirectory ||
        MIGRATIONS_DIRECTORY
    );
  const directoryStat =
    fileSystem.lstatSync(
      migrationsDirectory
    );

  if (
    !directoryStat.isDirectory() ||
    directoryStat.isSymbolicLink()
  ) {
    fail(
      "MIGRATION_DIRECTORY_INVALID"
    );
  }

  const realDirectory =
    fileSystem.realpathSync(
      migrationsDirectory
    );
  if (
    path.resolve(
      realDirectory
    ) !== migrationsDirectory
  ) {
    fail(
      "MIGRATION_DIRECTORY_ESCAPE"
    );
  }

  const sqlNames =
    fileSystem
      .readdirSync(
        migrationsDirectory,
        {
          withFileTypes: true,
        }
      )
      .map((entry) =>
        typeof entry === "string"
          ? entry
          : entry.name
      )
      .filter((name) =>
        name
          .toLowerCase()
          .endsWith(".sql")
      );

  if (
    sqlNames.some(
      (name) =>
        !MIGRATION_FILENAME_PATTERN.test(
          name
        )
    )
  ) {
    fail(
      "MIGRATION_FILENAME_INVALID"
    );
  }

  const normalizedCounts =
    new Map();
  for (
    const name
    of sqlNames
  ) {
    const normalized =
      name.toLowerCase();
    normalizedCounts.set(
      normalized,
      (
        normalizedCounts.get(
          normalized
        ) || 0
      ) + 1
    );
  }

  return APPROVED_MIGRATIONS.map(
    (approved) => {
      if (
        normalizedCounts.get(
          approved.filename.toLowerCase()
        ) !== 1 ||
        !sqlNames.includes(
          approved.filename
        )
      ) {
        fail(
          "MIGRATION_FILE_MISSING_OR_DUPLICATE"
        );
      }

      const filePath =
        path.resolve(
          migrationsDirectory,
          approved.filename
        );
      if (
        path.dirname(filePath) !==
        migrationsDirectory
      ) {
        fail(
          "MIGRATION_PATH_ESCAPE"
        );
      }

      const stat =
        fileSystem.lstatSync(
          filePath
        );
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        path.resolve(
          fileSystem.realpathSync(
            filePath
          )
        ) !== filePath
      ) {
        fail(
          "MIGRATION_PATH_ESCAPE"
        );
      }

      const sql =
        fileSystem.readFileSync(
          filePath,
          "utf8"
        );
      const checksum =
        sha256(sql);
      if (
        checksum !==
        approved.checksum
      ) {
        fail(
          "MIGRATION_CHECKSUM_MISMATCH"
        );
      }

      inspectMigrationSqlScope(
        approved.filename,
        sql
      );
      return {
        filename:
          approved.filename,
        checksum,
        sql,
      };
    }
  );
}

function publicMigrations(
  migrations =
    APPROVED_MIGRATIONS
) {
  return migrations.map(
    ({
      filename,
      checksum,
    }) => ({
      filename,
      checksum,
    })
  );
}

function sanitizeLedgerRows(
  rows = []
) {
  const approved =
    new Set(
      APPROVED_MIGRATIONS.map(
        ({ filename }) =>
          filename
      )
    );

  return rows
    .filter(
      (row) =>
        approved.has(
          row.filename
        )
    )
    .map((row) => ({
      filename:
        row.filename,
      checksum:
        typeof row.checksum ===
        "string"
          ? row.checksum
          : null,
      executionTarget:
        typeof row.execution_target ===
        "string"
          ? row.execution_target
          : null,
      applied:
        Boolean(
          row.applied_at
        ),
    }))
    .sort(
      (left, right) =>
        left.filename.localeCompare(
          right.filename
        )
    );
}

function analyzeLedger(
  rows = []
) {
  const approvedFilenames =
    new Set(
      APPROVED_MIGRATIONS.map(
        ({ filename }) =>
          filename
      )
    );
  const unexpectedEntryCount =
    rows.filter(
      (row) =>
        typeof row.filename !==
          "string" ||
        !approvedFilenames.has(
          row.filename
        )
    ).length;
  const entries =
    sanitizeLedgerRows(rows);
  const counts = new Map();
  for (
    const entry
    of entries
  ) {
    counts.set(
      entry.filename,
      (
        counts.get(
          entry.filename
        ) || 0
      ) + 1
    );
  }

  const duplicateFilenames =
    [...counts.entries()]
      .filter(
        ([, count]) =>
          count > 1
      )
      .map(
        ([filename]) =>
          filename
      )
      .sort();
  const byFilename =
    new Map(
      entries.map(
        (entry) => [
          entry.filename,
          entry,
        ]
      )
    );
  const missing = [];
  const checksumDrift = [];

  for (
    const migration
    of APPROVED_MIGRATIONS
  ) {
    const entry =
      byFilename.get(
        migration.filename
      );
    if (!entry) {
      missing.push(
        migration.filename
      );
    } else if (
      entry.checksum !==
        migration.checksum
    ) {
      checksumDrift.push(
        migration.filename
      );
    }
  }

  return {
    entries,
    missing,
    checksumDrift,
    duplicateFilenames,
    unexpectedEntryCount,
    allRecorded:
      missing.length === 0,
    allChecksumsMatch:
      checksumDrift.length === 0,
  };
}

function mapColumns(
  rows = []
) {
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
            row.data_type ||
            null,
          nullable:
            row.is_nullable ||
            null,
          hasDefault:
            row.column_default !=
            null,
        },
      ])
  );
}

function sanitizeConstraints(
  rows = []
) {
  return rows
    .filter(
      (row) =>
        typeof row.constraint_type ===
          "string" &&
        typeof row.constraint_definition ===
          "string"
    )
    .map((row) => ({
      type:
        row.constraint_type,
      definition:
        row.constraint_definition,
    }));
}

function sanitizeIndexes(
  rows = []
) {
  return rows
    .filter(
      (row) =>
        typeof row.index_name ===
          "string" &&
        typeof row.index_definition ===
          "string"
    )
    .map((row) => ({
      name:
        row.index_name,
      definition:
        row.index_definition,
    }));
}

function hasExpectedColumns(
  tableName,
  columns
) {
  return Object.entries(
    EXPECTED_COLUMNS[
      tableName
    ]
  ).every(
    ([
      name,
      [
        dataType,
        nullable,
        hasDefault,
      ],
    ]) => {
      const column =
        columns[name];
      return (
        column?.dataType ===
          dataType &&
        column?.nullable ===
          nullable &&
        column?.hasDefault ===
          hasDefault
      );
    }
  );
}

function hasExpectedConstraints(
  tableName,
  constraints
) {
  const expectedConstraints =
    EXPECTED_CONSTRAINTS[
      tableName
    ].every(
      (expected) =>
        constraints.some(
          (constraint) =>
            constraint.type ===
              expected.type &&
            expected.patterns.every(
              (pattern) =>
                pattern.test(
                  constraint.definition
                )
            )
        )
    );
  const statusConstraint =
    constraints.find(
      (constraint) =>
        constraint.type ===
          "CHECK" &&
        /\bstatus\b/i.test(
          constraint.definition
        )
    );
  const statusValues =
    statusConstraint
      ? [
          ...statusConstraint
            .definition.matchAll(
              /'([a-z][a-z0-9_]*)'/gi
            ),
        ].map(
          (match) =>
            match[1].toLowerCase()
        )
      : [];

  return (
    expectedConstraints &&
    sameStringSet(
      [
        ...new Set(
          statusValues
        ),
      ],
      EXPECTED_STATUS_VALUES[
        tableName
      ]
    )
  );
}

function hasExpectedIndexes(
  tableName,
  indexes
) {
  return EXPECTED_INDEXES[
    tableName
  ].every(
    (expected) =>
      indexes.some(
        (index) =>
          index.name ===
            expected.name &&
          expected.patterns.every(
            (pattern) =>
              pattern.test(
                index.definition
              )
          )
      )
  );
}

function classifyTable({
  tableName,
  exists,
  columnRows,
  constraintRows,
  indexRows,
}) {
  const columns =
    mapColumns(
      columnRows
    );
  const constraints =
    sanitizeConstraints(
      constraintRows
    );
  const indexes =
    sanitizeIndexes(
      indexRows
    );

  return {
    exists,
    complete:
      exists &&
      hasExpectedColumns(
        tableName,
        columns
      ) &&
      hasExpectedConstraints(
        tableName,
        constraints
      ) &&
      hasExpectedIndexes(
        tableName,
        indexes
      ),
    inventory: {
      columnCount:
        Object.keys(
          columns
        ).length,
      constraintCount:
        constraints.length,
      indexCount:
        indexes.length,
    },
  };
}

function classifyDependencies(
  columnRows = [],
  constraintRows = []
) {
  const columnsByTable =
    new Map();
  for (
    const row
    of columnRows
  ) {
    if (
      typeof row.table_name !==
        "string" ||
      typeof row.column_name !==
        "string"
    ) {
      continue;
    }
    if (
      !columnsByTable.has(
        row.table_name
      )
    ) {
      columnsByTable.set(
        row.table_name,
        new Map()
      );
    }
    columnsByTable
      .get(row.table_name)
      .set(
        row.column_name,
        row
      );
  }

  const constraintsByTable =
    new Map();
  for (
    const row
    of constraintRows
  ) {
    if (
      typeof row.table_name !==
        "string"
    ) {
      continue;
    }
    if (
      !constraintsByTable.has(
        row.table_name
      )
    ) {
      constraintsByTable.set(
        row.table_name,
        []
      );
    }
    constraintsByTable
      .get(row.table_name)
      .push(row);
  }

  const hasIntegerPrimaryKey =
    (tableName) => {
      const id =
        columnsByTable
          .get(tableName)
          ?.get("id");
      const constraints =
        constraintsByTable.get(
          tableName
        ) || [];
      return (
        id?.data_type ===
          "integer" &&
        id?.is_nullable ===
          "NO" &&
        constraints.some(
          (constraint) =>
            constraint.constraint_type ===
              "p" &&
            /\(id\)/i.test(
              constraint.constraint_definition ||
                ""
            )
        )
      );
    };

  const users =
    hasIntegerPrimaryKey(
      "users"
    );
  const posts =
    hasIntegerPrimaryKey(
      "posts"
    );
  const contractorProfiles =
    hasIntegerPrimaryKey(
      "contractor_profiles"
    );
  const ledgerColumns =
    columnsByTable.get(
      "schema_migrations"
    );
  const ledgerConstraints =
    constraintsByTable.get(
      "schema_migrations"
    ) || [];
  const schemaMigrations =
    Boolean(
      ledgerColumns &&
      ledgerColumns.get("id")
        ?.data_type ===
        "integer" &&
      ledgerColumns.get("id")
        ?.is_nullable ===
        "NO" &&
      ledgerColumns.get(
        "filename"
      )?.data_type ===
        "text" &&
      ledgerColumns.get(
        "filename"
      )?.is_nullable ===
        "NO" &&
      ledgerColumns.get(
        "checksum"
      )?.data_type ===
        "text" &&
      ledgerColumns.get(
        "checksum"
      )?.is_nullable ===
        "NO" &&
      ledgerColumns.get(
        "execution_target"
      )?.data_type ===
        "text" &&
      ledgerColumns.get(
        "execution_target"
      )?.is_nullable ===
        "NO" &&
      ledgerColumns.get(
        "applied_at"
      )?.data_type ===
        "timestamp without time zone" &&
      ledgerConstraints.some(
        (constraint) =>
          constraint.constraint_type ===
            "p" &&
          /\(id\)/i.test(
            constraint.constraint_definition ||
              ""
          )
      ) &&
      ledgerConstraints.some(
        (constraint) =>
          constraint.constraint_type ===
            "u" &&
          /\(filename\)/i.test(
            constraint.constraint_definition ||
              ""
          )
      )
    );

  return {
    users,
    posts,
    contractorProfiles,
    schemaMigrations,
    complete:
      users &&
      posts &&
      contractorProfiles &&
      schemaMigrations,
  };
}

function exactAppliedLedger(
  ledger
) {
  return (
    ledger.entries.length ===
      APPROVED_MIGRATIONS.length &&
    APPROVED_MIGRATIONS.every(
      (
        migration,
        index
      ) => {
        const entry =
          ledger.entries[index];
        return (
          entry?.filename ===
            migration.filename &&
          entry?.checksum ===
            migration.checksum &&
          entry?.executionTarget ===
            EXECUTION_TARGET &&
          entry?.applied === true
        );
      }
    )
  );
}

function decisionFor({
  databaseIdentityMatches,
  postgresCompatible,
  dependencies,
  ledger,
  schema,
}) {
  if (
    !databaseIdentityMatches ||
    !postgresCompatible
  ) {
    return {
      decision: "FAIL",
      code:
        "INSPECTION_TARGET_IDENTITY_MISMATCH",
    };
  }

  if (
    !dependencies.complete
  ) {
    return {
      decision:
        "BLOCKED_MISSING_REQUIRED_DEPENDENCIES",
      code:
        "PRODUCTION_PREREQUISITE_DEPENDENCIES_MISSING",
    };
  }

  if (
    ledger.checksumDrift
      .length > 0 ||
    ledger.duplicateFilenames
      .length > 0 ||
    ledger.unexpectedEntryCount >
      0
  ) {
    return {
      decision:
        "BLOCKED_PREREQUISITE_LEDGER_CONFLICT",
      code:
        "PRODUCTION_PREREQUISITE_LEDGER_CONFLICT",
    };
  }

  const fresh =
    ledger.entries.length ===
      0 &&
    !schema
      .requestRelationships
      .exists &&
    !schema.conversations.exists;
  if (fresh) {
    return {
      decision:
        "PASS_READY_FOR_PREREQUISITE_MIGRATION",
      code:
        "PRODUCTION_CONVERSATION_PREREQUISITES_MISSING",
    };
  }

  const complete =
    schema
      .requestRelationships
      .complete &&
    schema
      .conversations
      .complete &&
    exactAppliedLedger(
      ledger
    );
  if (complete) {
    return {
      decision:
        "ALREADY_APPLIED",
      code:
        "PRODUCTION_CONVERSATION_PREREQUISITES_READY",
    };
  }

  return {
    decision:
      "BLOCKED_PARTIAL_OR_UNRECORDED_PREREQUISITES",
    code:
      "PRODUCTION_CONVERSATION_PREREQUISITES_REQUIRE_REVIEW",
  };
}

async function readTableMetadata(
  client,
  tableName
) {
  if (
    !TABLES.includes(
      tableName
    )
  ) {
    fail(
      "INSPECTION_TABLE_UNAPPROVED"
    );
  }

  const existsResult =
    await client.query(
      INSPECTION_SQL
        .tableExists,
      [
        `public.${tableName}`,
      ]
    );
  const exists =
    existsResult.rows?.[0]
      ?.exists;
  if (
    typeof exists !==
    "boolean"
  ) {
    fail(
      "INSPECTION_SCHEMA_RESULT_INVALID"
    );
  }

  if (!exists) {
    return classifyTable({
      tableName,
      exists: false,
      columnRows: [],
      constraintRows: [],
      indexRows: [],
    });
  }

  const [
    columnResult,
    constraintResult,
    indexResult,
  ] =
    await Promise.all([
      client.query(
        INSPECTION_SQL
          .columns,
        [tableName]
      ),
      client.query(
        INSPECTION_SQL
          .constraints,
        [tableName]
      ),
      client.query(
        INSPECTION_SQL
          .indexes,
        [tableName]
      ),
    ]);

  return classifyTable({
    tableName,
    exists,
    columnRows:
      columnResult.rows,
    constraintRows:
      constraintResult.rows,
    indexRows:
      indexResult.rows,
  });
}

function reportForFailure({
  env,
  code,
}) {
  return {
    success: false,
    decision: "FAIL",
    code,
    target:
      authorizeExecution(
        env
      ).target,
    migrations:
      publicMigrations(),
    dependencies: {
      users: false,
      posts: false,
      contractorProfiles:
        false,
      schemaMigrations:
        false,
      complete: false,
    },
    ledger: {
      entries: [],
      missing:
        APPROVED_MIGRATIONS.map(
          ({ filename }) =>
            filename
        ),
      checksumDrift: [],
      duplicateFilenames:
        [],
      unexpectedEntryCount:
        0,
      allRecorded: false,
      allChecksumsMatch:
        false,
    },
    schema: {
      classification:
        "UNKNOWN",
      requestRelationships: {
        exists: false,
        complete: false,
      },
      conversations: {
        exists: false,
        complete: false,
      },
    },
    readOnly: true,
  };
}

function poolConfiguration(
  env
) {
  return {
    connectionString:
      env.DATABASE_URL,
    ssl:
      env.PGSSLMODE ===
      "disable"
        ? false
        : {
            rejectUnauthorized:
              false,
          },
  };
}

async function inspectProductionConversationPrerequisiteState(
  options = {}
) {
  const env =
    options.env ||
    process.env;
  const authorization =
    authorizeExecution(env);
  if (
    !authorization.authorized
  ) {
    return reportForFailure({
      env,
      code:
        authorization.code,
    });
  }

  let migrations;
  try {
    migrations =
      loadApprovedMigrations({
        migrationsDirectory:
          options.migrationsDirectory,
        fileSystem:
          options.fileSystem,
      });
  } catch (error) {
    return reportForFailure({
      env,
      code:
        error instanceof
        RunnerFailure
          ? error.code
          : "MIGRATION_SOURCE_VALIDATION_FAILED",
    });
  }

  const poolFactory =
    options.poolFactory ||
    ((configuration) =>
      new Pool(
        configuration
      ));
  let pool;
  let client;
  let transactionStarted =
    false;
  let report =
    reportForFailure({
      env,
      code:
        "INSPECTION_QUERY_FAILED",
    });

  try {
    pool =
      poolFactory(
        poolConfiguration(
          env
        )
      );
    client =
      await pool.connect();
    await client.query(
      "BEGIN TRANSACTION READ ONLY"
    );
    transactionStarted = true;

    const identityResult =
      await client.query(
        INSPECTION_SQL
          .databaseIdentity
      );
    const identityRow =
      identityResult.rows?.[0] ||
      {};
    const parsed =
      parseDatabaseUrl(
        env.DATABASE_URL
      );
    const expectedDatabase =
      parsed
        ? decodeURIComponent(
            parsed.pathname.replace(
              /^\/+/,
              ""
            )
          )
        : "";
    const databaseIdentityMatches =
      typeof identityRow.database_name ===
        "string" &&
      identityRow.database_name ===
        expectedDatabase;
    const postgresCompatible =
      Number.isInteger(
        Number(
          identityRow.server_version_num
        )
      ) &&
      Number(
        identityRow.server_version_num
      ) >=
        MINIMUM_POSTGRES_VERSION;

    const dependencyTables = [
      "users",
      "posts",
      "contractor_profiles",
      "schema_migrations",
    ];
    const [
      dependencyColumnResult,
      dependencyConstraintResult,
    ] =
      await Promise.all([
        client.query(
          INSPECTION_SQL
            .dependencyColumns,
          [dependencyTables]
        ),
        client.query(
          INSPECTION_SQL
            .dependencyConstraints,
          [dependencyTables]
        ),
      ]);
    const dependencies =
      classifyDependencies(
        dependencyColumnResult.rows,
        dependencyConstraintResult.rows
      );

    const ledger =
      dependencies
        .schemaMigrations
        ? analyzeLedger(
            (
              await client.query(
                INSPECTION_SQL
                  .ledger,
                [
                  APPROVED_MIGRATIONS.map(
                    ({
                      filename,
                    }) =>
                      filename
                  ),
                ]
              )
            ).rows
          )
        : analyzeLedger([]);

    const requestRelationships =
      await readTableMetadata(
        client,
        "request_relationships"
      );
    const conversations =
      await readTableMetadata(
        client,
        "conversations"
      );
    const schema = {
      classification:
        requestRelationships.complete &&
        conversations.complete
          ? "COMPLETE"
          : !requestRelationships.exists &&
              !conversations.exists
            ? "ABSENT"
            : "PARTIAL",
      requestRelationships,
      conversations,
    };
    const decision =
      decisionFor({
        databaseIdentityMatches,
        postgresCompatible,
        dependencies,
        ledger,
        schema,
      });

    report = {
      success:
        [
          "PASS_READY_FOR_PREREQUISITE_MIGRATION",
          "ALREADY_APPLIED",
        ].includes(
          decision.decision
        ),
      decision:
        decision.decision,
      code:
        decision.code,
      target:
        authorization.target,
      migrations:
        publicMigrations(
          migrations
        ),
      dependencies,
      ledger,
      schema,
      readOnly: true,
    };
  } catch (error) {
    report =
      reportForFailure({
        env,
        code:
          error instanceof
          RunnerFailure
            ? error.code
            : "INSPECTION_QUERY_FAILED",
      });
  } finally {
    if (
      transactionStarted &&
      client
    ) {
      try {
        await client.query(
          "ROLLBACK"
        );
      } catch {
        report =
          reportForFailure({
            env,
            code:
              "INSPECTION_ROLLBACK_FAILED",
          });
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
        report =
          reportForFailure({
            env,
            code:
              "INSPECTION_RESOURCE_RELEASE_FAILED",
          });
      }
    }

    if (
      pool &&
      typeof pool.end ===
        "function"
    ) {
      try {
        await pool.end();
      } catch {
        report =
          reportForFailure({
            env,
            code:
              "INSPECTION_RESOURCE_RELEASE_FAILED",
          });
      }
    }
  }

  return report;
}

function summarizeInspection(
  report
) {
  return {
    success:
      report?.success ===
      true,
    decision:
      typeof report?.decision ===
      "string"
        ? report.decision
        : "FAIL",
    code:
      typeof report?.code ===
      "string"
        ? report.code
        : "INSPECTION_INVALID",
    readOnly:
      report?.readOnly ===
      true,
    dependencies: {
      users:
        report?.dependencies
          ?.users === true,
      posts:
        report?.dependencies
          ?.posts === true,
      contractorProfiles:
        report?.dependencies
          ?.contractorProfiles ===
        true,
      schemaMigrations:
        report?.dependencies
          ?.schemaMigrations ===
        true,
      complete:
        report?.dependencies
          ?.complete === true,
    },
    ledger: {
      entries:
        Array.isArray(
          report?.ledger
            ?.entries
        )
          ? report.ledger.entries.map(
              (entry) => ({
                filename:
                  entry.filename,
                checksum:
                  entry.checksum,
                executionTarget:
                  entry.executionTarget,
                applied:
                  entry.applied ===
                  true,
              })
            )
          : [],
      missing:
        Array.isArray(
          report?.ledger
            ?.missing
        )
          ? [
              ...report.ledger
                .missing,
            ]
          : [],
      checksumDrift:
        Array.isArray(
          report?.ledger
            ?.checksumDrift
        )
          ? [
              ...report.ledger
                .checksumDrift,
            ]
          : [],
      duplicateFilenames:
        Array.isArray(
          report?.ledger
            ?.duplicateFilenames
        )
          ? [
              ...report.ledger
                .duplicateFilenames,
            ]
          : [],
      unexpectedEntryCount:
        Number.isSafeInteger(
          Number(
            report?.ledger
              ?.unexpectedEntryCount
          )
        )
          ? Number(
              report.ledger
                .unexpectedEntryCount
            )
          : -1,
      allRecorded:
        report?.ledger
          ?.allRecorded === true,
      allChecksumsMatch:
        report?.ledger
          ?.allChecksumsMatch ===
        true,
    },
    schema: {
      classification:
        report?.schema
          ?.classification ||
        null,
      requestRelationships: {
        exists:
          report?.schema
            ?.requestRelationships
            ?.exists === true,
        complete:
          report?.schema
            ?.requestRelationships
            ?.complete === true,
      },
      conversations: {
        exists:
          report?.schema
            ?.conversations
            ?.exists === true,
        complete:
          report?.schema
            ?.conversations
            ?.complete === true,
      },
    },
  };
}

function hasCompleteDependencies(
  summary
) {
  return (
    summary.dependencies
      .complete &&
    summary.dependencies.users &&
    summary.dependencies.posts &&
    summary.dependencies
      .contractorProfiles &&
    summary.dependencies
      .schemaMigrations
  );
}

function isReadyPreflight(
  summary
) {
  return (
    summary.success &&
    summary.decision ===
      "PASS_READY_FOR_PREREQUISITE_MIGRATION" &&
    summary.code ===
      "PRODUCTION_CONVERSATION_PREREQUISITES_MISSING" &&
    summary.readOnly &&
    hasCompleteDependencies(
      summary
    ) &&
    summary.schema
      .classification ===
      "ABSENT" &&
    !summary.schema
      .requestRelationships
      .exists &&
    !summary.schema
      .conversations.exists &&
    summary.ledger.entries
      .length === 0 &&
    summary.ledger.missing
      .length ===
      APPROVED_MIGRATIONS.length &&
    APPROVED_MIGRATIONS.every(
      ({ filename }) =>
        summary.ledger.missing.includes(
          filename
        )
    ) &&
    summary.ledger
      .checksumDrift.length ===
      0 &&
    summary.ledger
      .duplicateFilenames
      .length === 0 &&
    summary.ledger
      .unexpectedEntryCount ===
      0 &&
    !summary.ledger
      .allRecorded
  );
}

function isAlreadyApplied(
  summary
) {
  return (
    summary.success &&
    summary.decision ===
      "ALREADY_APPLIED" &&
    summary.code ===
      "PRODUCTION_CONVERSATION_PREREQUISITES_READY" &&
    summary.readOnly &&
    hasCompleteDependencies(
      summary
    ) &&
    summary.schema
      .classification ===
      "COMPLETE" &&
    summary.schema
      .requestRelationships
      .complete &&
    summary.schema
      .conversations
      .complete &&
    summary.ledger.missing
      .length === 0 &&
    summary.ledger
      .checksumDrift.length ===
      0 &&
    summary.ledger
      .duplicateFilenames
      .length === 0 &&
    summary.ledger
      .unexpectedEntryCount ===
      0 &&
    summary.ledger
      .allRecorded &&
    summary.ledger
      .allChecksumsMatch &&
    exactAppliedLedger(
      summary.ledger
    )
  );
}

function emptyExecution() {
  return {
    committed: [],
    failedMigration:
      null,
    notAttempted:
      APPROVED_MIGRATIONS.map(
        ({ filename }) =>
          filename
      ),
  };
}

function failureResult({
  code,
  target,
  mutationStarted =
    false,
  execution =
    emptyExecution(),
  preflight = null,
  postflight = null,
}) {
  return {
    success: false,
    decision: "FAIL",
    code,
    target,
    migrations:
      publicMigrations(),
    preflight,
    execution,
    postflight,
    mutationStarted,
  };
}

function migrationTableName(
  index
) {
  return index === 0
    ? "request_relationships"
    : "conversations";
}

async function verifyMigrationEffect(
  client,
  migrationIndex
) {
  const tableName =
    migrationTableName(
      migrationIndex
    );
  const metadata =
    await readTableMetadata(
      client,
      tableName
    );
  if (
    !metadata.complete
  ) {
    fail(
      "MIGRATION_EFFECT_VERIFICATION_FAILED"
    );
  }

  const rowCountResult =
    await client.query(
      EMPTY_ROW_SQL[
        tableName
      ]
    );
  const rowCount =
    Number(
      rowCountResult.rows?.[0]
        ?.row_count
    );
  if (
    !Number.isSafeInteger(
      rowCount
    ) ||
    rowCount !== 0
  ) {
    fail(
      "MIGRATION_EFFECT_VERIFICATION_FAILED"
    );
  }
}

async function runProductionConversationPrerequisites(
  options = {}
) {
  const env =
    options.env ||
    process.env;
  const authorization =
    authorizeExecution(env);
  const target =
    authorization.target;

  if (
    !authorization.authorized
  ) {
    return failureResult({
      code:
        authorization.code,
      target,
    });
  }

  let migrations;
  try {
    migrations =
      loadApprovedMigrations({
        migrationsDirectory:
          options.migrationsDirectory,
        fileSystem:
          options.fileSystem,
      });
  } catch (error) {
    return failureResult({
      code:
        error instanceof
        RunnerFailure
          ? error.code
          : "MIGRATION_SOURCE_VALIDATION_FAILED",
      target,
    });
  }

  const inspect =
    options.inspect ||
    inspectProductionConversationPrerequisiteState;
  let preflightReport;
  try {
    preflightReport =
      await inspect({
        env,
        ...(
          options
            .inspectionPoolFactory
            ? {
                poolFactory:
                  options
                    .inspectionPoolFactory,
              }
            : {}
        ),
      });
  } catch {
    return failureResult({
      code:
        "PREFLIGHT_INSPECTION_FAILED",
      target,
    });
  }

  const preflight =
    summarizeInspection(
      preflightReport
    );
  if (
    isAlreadyApplied(
      preflight
    )
  ) {
    return {
      success: true,
      decision:
        "ALREADY_APPLIED",
      code:
        "PRODUCTION_CONVERSATION_PREREQUISITES_ALREADY_APPLIED",
      target,
      migrations:
        publicMigrations(
          migrations
        ),
      preflight,
      execution:
        emptyExecution(),
      postflight:
        preflight,
      mutationStarted:
        false,
    };
  }

  if (
    !isReadyPreflight(
      preflight
    )
  ) {
    return failureResult({
      code:
        "PREFLIGHT_STATE_BLOCKED",
      target,
      preflight,
    });
  }

  const poolFactory =
    options.poolFactory ||
    ((configuration) =>
      new Pool(
        configuration
      ));
  let pool;
  let client;
  let transactionStarted =
    false;
  let mutationStarted =
    false;
  let executionFailure =
    null;
  const execution =
    emptyExecution();

  try {
    pool =
      poolFactory(
        poolConfiguration(
          env
        )
      );
    client =
      await pool.connect();
  } catch {
    if (
      pool &&
      typeof pool.end ===
        "function"
    ) {
      try {
        await pool.end();
      } catch {
        // The safe connection failure remains authoritative.
      }
    }
    return failureResult({
      code:
        "DATABASE_CONNECTION_FAILED",
      target,
      preflight,
    });
  }

  try {
    for (
      let index = 0;
      index <
      migrations.length;
      index += 1
    ) {
      const migration =
        migrations[index];
      execution.notAttempted =
        migrations
          .slice(index + 1)
          .map(
            ({ filename }) =>
              filename
          );

      try {
        await client.query(
          "BEGIN"
        );
        transactionStarted =
          true;
        await client.query(
          "SELECT pg_advisory_xact_lock($1)",
          [ADVISORY_LOCK_ID]
        );

        const existing =
          await client.query(
            LEDGER_SELECT_SQL,
            [
              migration.filename,
            ]
          );
        if (
          existing.rows.length !==
          0
        ) {
          fail(
            "MIGRATION_LEDGER_CONFLICT"
          );
        }

        const preexistingSchema =
          await readTableMetadata(
            client,
            migrationTableName(
              index
            )
          );
        if (
          preexistingSchema.exists
        ) {
          fail(
            "MIGRATION_SCHEMA_CONFLICT"
          );
        }

        mutationStarted =
          true;
        await client.query(
          migration.sql
        );
        await verifyMigrationEffect(
          client,
          index
        );
        await client.query(
          LEDGER_INSERT_SQL,
          [
            migration.filename,
            migration.checksum,
            EXECUTION_TARGET,
          ]
        );

        const recorded =
          await client.query(
            LEDGER_SELECT_SQL,
            [
              migration.filename,
            ]
          );
        const row =
          recorded.rows[0];
        if (
          recorded.rows.length !==
            1 ||
          row?.filename !==
            migration.filename ||
          row?.checksum !==
            migration.checksum ||
          row?.execution_target !==
            EXECUTION_TARGET ||
          !row?.applied_at
        ) {
          fail(
            "MIGRATION_LEDGER_VERIFICATION_FAILED"
          );
        }

        await client.query(
          "COMMIT"
        );
        transactionStarted =
          false;
        execution.committed.push(
          migration.filename
        );
      } catch (error) {
        if (
          transactionStarted
        ) {
          try {
            await client.query(
              "ROLLBACK"
            );
          } catch {
            // Preserve the first governed failure.
          }
          transactionStarted =
            false;
        }

        execution.failedMigration =
          migration.filename;
        executionFailure =
          error instanceof
          RunnerFailure
            ? error.code
            : "MIGRATION_EXECUTION_FAILED";
        break;
      }
    }
  } finally {
    if (
      client &&
      typeof client.release ===
        "function"
    ) {
      try {
        client.release();
      } catch {
        if (
          !executionFailure
        ) {
          executionFailure =
            "DATABASE_RESOURCE_RELEASE_FAILED";
        }
      }
    }
    if (
      pool &&
      typeof pool.end ===
        "function"
    ) {
      try {
        await pool.end();
      } catch {
        if (
          !executionFailure
        ) {
          executionFailure =
            "DATABASE_RESOURCE_RELEASE_FAILED";
        }
      }
    }
  }

  if (executionFailure) {
    return failureResult({
      code:
        executionFailure,
      target,
      mutationStarted,
      execution,
      preflight,
    });
  }

  let postflightReport;
  try {
    postflightReport =
      await inspect({
        env,
        ...(
          options
            .postInspectionPoolFactory
            ? {
                poolFactory:
                  options
                    .postInspectionPoolFactory,
              }
            : {}
        ),
      });
  } catch {
    return failureResult({
      code:
        "POSTFLIGHT_INSPECTION_FAILED",
      target,
      mutationStarted,
      execution,
      preflight,
    });
  }

  const postflight =
    summarizeInspection(
      postflightReport
    );
  if (
    !isAlreadyApplied(
      postflight
    )
  ) {
    return failureResult({
      code:
        "POSTFLIGHT_STATE_INVALID",
      target,
      mutationStarted,
      execution,
      preflight,
      postflight,
    });
  }

  return {
    success: true,
    decision:
      "APPLIED_AND_VERIFIED",
    code:
      "PRODUCTION_CONVERSATION_PREREQUISITES_APPLIED",
    target,
    migrations:
      publicMigrations(
        migrations
      ),
    preflight,
    execution,
    postflight,
    mutationStarted,
  };
}

function isValidCliResult(
  result
) {
  return (
    result &&
    typeof result ===
      "object" &&
    typeof result.success ===
      "boolean" &&
    [
      "APPLIED_AND_VERIFIED",
      "ALREADY_APPLIED",
      "FAIL",
    ].includes(
      result.decision
    ) &&
    typeof result.code ===
      "string" &&
    typeof result.mutationStarted ===
      "boolean"
  );
}

function exitCodeForResult(
  result
) {
  if (
    result.success &&
    result.decision ===
      "APPLIED_AND_VERIFIED"
  ) {
    return 0;
  }
  if (
    result.success &&
    result.decision ===
      "ALREADY_APPLIED"
  ) {
    return 2;
  }
  return 1;
}

async function runCli(
  options = {}
) {
  const env =
    options.env ||
    process.env;
  const run =
    options.run ||
    runProductionConversationPrerequisites;
  const write =
    options.write ||
    ((value) =>
      process.stdout.write(
        value
      ));
  let result;

  try {
    result =
      await run({
        ...options,
        env,
      });
    if (
      !isValidCliResult(
        result
      )
    ) {
      result =
        failureResult({
          code:
            "RUNNER_RESULT_INVALID",
          target:
            authorizeExecution(
              env
            ).target,
        });
    }
  } catch {
    result =
      failureResult({
        code:
          "RUNNER_UNEXPECTED_FAILURE",
        target:
          authorizeExecution(
            env
          ).target,
      });
  }

  write(
    `${JSON.stringify(
      result
    )}\n`
  );
  return exitCodeForResult(
    result
  );
}

if (
  require.main === module
) {
  runCli().then(
    (exitCode) => {
      process.exitCode =
        exitCode;
    }
  );
}

module.exports = Object.freeze({
  APPROVED_MIGRATIONS,
  REQUIRED_CONFIRMATIONS,
  authorizeExecution,
  inspectMigrationSqlScope,
  inspectProductionConversationPrerequisiteState,
  loadApprovedMigrations,
  runCli,
  runProductionConversationPrerequisites,
  validatePinnedManifest,
});
