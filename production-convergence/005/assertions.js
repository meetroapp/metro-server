"use strict";

const fs = require("node:fs");
const path = require("node:path");

const baseAssertions = require("../004/assertions");

const {
  ARCHIVE_MIGRATION,
  BASELINE_FILENAME,
  CANONICAL_TEAM_FILENAME,
  CERTIFIED_PRE_MAINTENANCE_DEPLOYMENT_ID,
  CONVERGENCE_ID,
  CURRENT_PRODUCTION_LEDGER,
  EXECUTION_TARGET,
  EXPECTED_POST_CATALOG,
  EXPECTED_POST_CATALOG_FINGERPRINT,
  EXPECTED_POST_LEDGER_FINGERPRINT,
  EXPECTED_POST_LEDGER_ROWS,
  EXPECTED_PRE_LEDGER_ROWS,
  EXPECTED_PRODUCTION_TARGET,
  PRESTATE_CATALOG_FINGERPRINT,
  PRESTATE_FINGERPRINT,
  PRESTATE_LEDGER_FINGERPRINT,
  PRODUCTION_PRESTATE,
  TARGET_MIGRATIONS,
  VARIANT_FILENAME,
  ledgerIdentityFingerprint,
} = require("./manifest");

const {
  canonicalize,
  objectFingerprint,
  prestateFingerprint,
  sha256,
} = require("./fingerprints");

const REPOSITORY_ROOT =
  path.resolve(__dirname, "..", "..");

const MIGRATIONS_DIRECTORY =
  path.join(REPOSITORY_ROOT, "migrations");

const {
  FILENAME_PATTERN,
  SHA256_PATTERN,
  TRANSACTION_PROHIBITED,
  blocked,
  compareLedger,
  extractTargetMarkers,
} = baseAssertions;

const IMAGE_DIGEST_PATTERN =
  /^sha256:[0-9a-f]{64}$/;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const FIRST_TARGET =
  "202609020001_add_business_origin_commercial_job_foundation.sql";

const LAST_TARGET =
  "202609160015_generalize_invoice_job_origins.sql";

function exactObjectEqual(actual, expected) {
  return canonicalize(actual) ===
    canonicalize(expected);
}

function validateManifest(
  targetMigrations = TARGET_MIGRATIONS
) {
  const reasons = [];

  if (CURRENT_PRODUCTION_LEDGER.length !==
      EXPECTED_PRE_LEDGER_ROWS) {
    reasons.push("PRE_LEDGER_COUNT_INVALID");
  }

  if (targetMigrations.length !== 24) {
    reasons.push("TARGET_COUNT_INVALID");
  }

  const names =
    targetMigrations.map(({ filename }) => filename);

  if (new Set(names).size !== names.length) {
    reasons.push("DUPLICATE_FULL_FILENAME");
  }

  if (names.includes(BASELINE_FILENAME)) {
    reasons.push("BASELINE_TARGET_PROHIBITED");
  }

  if (names.includes(ARCHIVE_MIGRATION.filename)) {
    reasons.push("ARCHIVE_TARGET_PROHIBITED");
  }

  if (names.includes(VARIANT_FILENAME)) {
    reasons.push("R1_VARIANT_REPLAY_PROHIBITED");
  }

  if (names.includes(CANONICAL_TEAM_FILENAME)) {
    reasons.push("CANONICAL_TEAM_TARGET_PROHIBITED");
  }

  if (
    names.some(
      (name) => !FILENAME_PATTERN.test(name)
    )
  ) {
    reasons.push("FILENAME_INVALID");
  }

  if (
    targetMigrations.some(
      ({ checksum }) =>
        !SHA256_PATTERN.test(checksum)
    )
  ) {
    reasons.push("CHECKSUM_INVALID");
  }

  if (
    targetMigrations.some(
      ({ order }, index) =>
        order !== index + 1
    )
  ) {
    reasons.push("ORDER_FIELD_INVALID");
  }

  if (names[0] !== FIRST_TARGET) {
    reasons.push("TARGET_START_INVALID");
  }

  if (names.at(-1) !== LAST_TARGET) {
    reasons.push("TARGET_END_INVALID");
  }

  const preNames =
    new Set(
      CURRENT_PRODUCTION_LEDGER.map(
        ({ filename }) => filename
      )
    );

  for (const name of names) {
    if (preNames.has(name)) {
      reasons.push(
        `TARGET_ALREADY_IN_PRESTATE:${name}`
      );
    }
  }

  if (
    !CURRENT_PRODUCTION_LEDGER.some(
      ({ filename, checksum }) =>
        filename === ARCHIVE_MIGRATION.filename &&
        checksum === ARCHIVE_MIGRATION.checksum
    )
  ) {
    reasons.push("ARCHIVE_PRESTATE_MISSING");
  }

  if (
    !CURRENT_PRODUCTION_LEDGER.some(
      ({ filename }) =>
        filename === VARIANT_FILENAME
    )
  ) {
    reasons.push("R1_VARIANT_PRESTATE_MISSING");
  }

  if (
    CURRENT_PRODUCTION_LEDGER.some(
      ({ filename }) =>
        filename === CANONICAL_TEAM_FILENAME
    )
  ) {
    reasons.push(
      "CANONICAL_TEAM_PRESTATE_PROHIBITED"
    );
  }

  if (
    CURRENT_PRODUCTION_LEDGER.some(
      ({ filename }) =>
        filename === BASELINE_FILENAME
    )
  ) {
    reasons.push("BASELINE_PRESTATE_PROHIBITED");
  }

  if (
    ledgerIdentityFingerprint(
      CURRENT_PRODUCTION_LEDGER
    ) !== PRESTATE_LEDGER_FINGERPRINT
  ) {
    reasons.push("PRE_LEDGER_FINGERPRINT_INVALID");
  }

  const post = expectedPostLedger(
    targetMigrations
  );

  if (post.length !== EXPECTED_POST_LEDGER_ROWS) {
    reasons.push("POST_LEDGER_COUNT_INVALID");
  }

  if (
    ledgerIdentityFingerprint(post) !==
      EXPECTED_POST_LEDGER_FINGERPRINT
  ) {
    reasons.push("POST_LEDGER_FINGERPRINT_INVALID");
  }

  if (reasons.length) {
    throw blocked(
      "MANIFEST_INVALID",
      [...new Set(reasons)]
    );
  }

  return true;
}

function loadTargetMigrations({
  migrationsDirectory = MIGRATIONS_DIRECTORY,
  targetMigrations = TARGET_MIGRATIONS,
} = {}) {
  validateManifest(targetMigrations);

  const canonicalRoot =
    fs.realpathSync(migrationsDirectory);

  return targetMigrations.map((entry) => {
    const filePath =
      path.join(
        migrationsDirectory,
        entry.filename
      );

    if (!fs.existsSync(filePath)) {
      throw blocked(
        "TARGET_MIGRATION_MISSING",
        [entry.filename]
      );
    }

    const stat =
      fs.lstatSync(filePath);

    if (
      !stat.isFile() ||
      stat.isSymbolicLink()
    ) {
      throw blocked(
        "TARGET_MIGRATION_FILE_INVALID",
        [entry.filename]
      );
    }

    if (
      path.dirname(
        fs.realpathSync(filePath)
      ) !== canonicalRoot
    ) {
      throw blocked(
        "TARGET_MIGRATION_PATH_INVALID",
        [entry.filename]
      );
    }

    const sql =
      fs.readFileSync(filePath, "utf8");

    if (sha256(sql) !== entry.checksum) {
      throw blocked(
        "TARGET_MIGRATION_CHECKSUM_DRIFT",
        [entry.filename]
      );
    }

    if (
      /^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/im
        .test(sql)
    ) {
      throw blocked(
        "MIGRATION_OWNS_TRANSACTION",
        [entry.filename]
      );
    }

    if (
      TRANSACTION_PROHIBITED.some(
        (pattern) => pattern.test(sql)
      )
    ) {
      throw blocked(
        "TRANSACTION_INCOMPATIBLE_MIGRATION",
        [entry.filename]
      );
    }

    return Object.freeze({
      ...entry,
      sql,
    });
  });
}

function expectedPostLedger(
  targetMigrations = TARGET_MIGRATIONS
) {
  return [
    ...CURRENT_PRODUCTION_LEDGER,

    ...targetMigrations.map(
      ({ filename, checksum }) => ({
        filename,
        checksum,
        executionTarget:
          EXECUTION_TARGET,
      })
    ),
  ].sort(
    (left, right) =>
      left.filename.localeCompare(
        right.filename
      )
  );
}

function ledgerHasExact(
  ledger,
  filename,
  checksum = null
) {
  return (ledger || []).some(
    (entry) =>
      entry.filename === filename &&
      (
        checksum === null ||
        entry.checksum === checksum
      )
  );
}

function assertHistoricalLedgerShape(
  snapshot,
  reasons
) {
  if (
    !ledgerHasExact(
      snapshot.ledger,
      ARCHIVE_MIGRATION.filename,
      ARCHIVE_MIGRATION.checksum
    )
  ) {
    reasons.push(
      "ARCHIVE_LEDGER_IDENTITY_MISMATCH"
    );
  }

  if (
    !ledgerHasExact(
      snapshot.ledger,
      VARIANT_FILENAME
    )
  ) {
    reasons.push(
      "R1_VARIANT_LEDGER_MISSING"
    );
  }

  if (
    ledgerHasExact(
      snapshot.ledger,
      CANONICAL_TEAM_FILENAME
    )
  ) {
    reasons.push(
      "CANONICAL_TEAM_LEDGER_PROHIBITED"
    );
  }

  if (
    ledgerHasExact(
      snapshot.ledger,
      BASELINE_FILENAME
    )
  ) {
    reasons.push(
      "BASELINE_LEDGER_PROHIBITED"
    );
  }
}

function classifySnapshot(snapshot) {
  const pre =
    compareLedger(
      snapshot.ledger,
      CURRENT_PRODUCTION_LEDGER
    ).exact &&
    snapshot.ledgerFingerprint ===
      PRESTATE_LEDGER_FINGERPRINT;

  const postLedger =
    expectedPostLedger();

  const post =
    compareLedger(
      snapshot.ledger,
      postLedger
    ).exact &&
    snapshot.ledgerFingerprint ===
      EXPECTED_POST_LEDGER_FINGERPRINT;

  const markers =
    snapshot.targetMarkers ||
    { present: 0, expected: 0 };

  if (
    pre &&
    markers.present === 0
  ) {
    return "READY";
  }

  if (
    post &&
    markers.expected > 0 &&
    markers.present === markers.expected
  ) {
    return "ALREADY_APPLIED";
  }

  return "BLOCKED";
}

function assertPreflightSnapshot(
  snapshot,
  expected = PRODUCTION_PRESTATE
) {
  const reasons = [];

  if (
    !String(
      snapshot.postgresVersion || ""
    ).startsWith(expected.postgresVersion)
  ) {
    reasons.push(
      "POSTGRES_VERSION_MISMATCH"
    );
  }

  if (
    !compareLedger(
      snapshot.ledger,
      CURRENT_PRODUCTION_LEDGER
    ).exact
  ) {
    reasons.push(
      "LEDGER_PRESTATE_MISMATCH"
    );
  }

  if (
    snapshot.ledgerFingerprint !==
      PRESTATE_LEDGER_FINGERPRINT
  ) {
    reasons.push(
      "LEDGER_PRESTATE_FINGERPRINT_MISMATCH"
    );
  }

  if (
    (snapshot.targetMarkers?.present || 0) !== 0
  ) {
    reasons.push(
      "PARTIAL_TARGET_SCHEMA"
    );
  }

  if (
    !exactObjectEqual(
      snapshot.catalog,
      expected.catalog
    )
  ) {
    reasons.push(
      "CATALOG_PRESTATE_MISMATCH"
    );
  }

  if (
    snapshot.catalogFingerprint !==
      PRESTATE_CATALOG_FINGERPRINT
  ) {
    reasons.push(
      "CATALOG_FINGERPRINT_MISMATCH"
    );
  }

  if (
    objectFingerprint(snapshot.catalog) !==
      PRESTATE_CATALOG_FINGERPRINT
  ) {
    reasons.push(
      "CATALOG_FINGERPRINT_RECOMPUTE_MISMATCH"
    );
  }

  if (
    !exactObjectEqual(
      snapshot.preservation,
      expected.preservation
    )
  ) {
    reasons.push(
      "PRESERVATION_PRESTATE_MISMATCH"
    );
  }

  if (
    !exactObjectEqual(
      snapshot.ownerBackfillEligibility,
      expected.ownerBackfillEligibility
    )
  ) {
    reasons.push(
      "OWNER_ELIGIBILITY_PRESTATE_MISMATCH"
    );
  }

  if (
    !exactObjectEqual(
      snapshot.ownerMembership,
      expected.ownerMembership
    )
  ) {
    reasons.push(
      "OWNER_MEMBERSHIP_PRESTATE_MISMATCH"
    );
  }

  if (
    !exactObjectEqual(
      snapshot.operationalCounts,
      expected.operationalCounts
    )
  ) {
    reasons.push(
      "OPERATIONAL_PRESTATE_MISMATCH"
    );
  }

  const recomputedPrestate =
    prestateFingerprint(snapshot, {
      postgresVersionPrefix:
        expected.postgresVersion,
    });

  if (
    snapshot.prestateFingerprint !==
      PRESTATE_FINGERPRINT ||
    recomputedPrestate !==
      PRESTATE_FINGERPRINT
  ) {
    reasons.push(
      "PRESTATE_FINGERPRINT_MISMATCH"
    );
  }

  assertHistoricalLedgerShape(
    snapshot,
    reasons
  );

  if (reasons.length) {
    throw blocked(
      "PREFLIGHT_BLOCKED",
      [...new Set(reasons)]
    );
  }

  return "READY";
}

function assertPostflightSnapshot(
  snapshot,
  expected = PRODUCTION_PRESTATE
) {
  const reasons = [];
  const expectedLedger =
    expectedPostLedger();

  if (
    !compareLedger(
      snapshot.ledger,
      expectedLedger
    ).exact
  ) {
    reasons.push(
      "LEDGER_POSTSTATE_MISMATCH"
    );
  }

  if (
    snapshot.ledgerFingerprint !==
      EXPECTED_POST_LEDGER_FINGERPRINT
  ) {
    reasons.push(
      "LEDGER_POSTSTATE_FINGERPRINT_MISMATCH"
    );
  }

  if (
    !snapshot.targetMarkers ||
    snapshot.targetMarkers.expected === 0 ||
    snapshot.targetMarkers.present !==
      snapshot.targetMarkers.expected
  ) {
    reasons.push(
      "TARGET_SCHEMA_INCOMPLETE"
    );
  }

  if (
    !exactObjectEqual(
      snapshot.catalog,
      EXPECTED_POST_CATALOG
    )
  ) {
    reasons.push(
      "CATALOG_POSTSTATE_MISMATCH"
    );
  }

  if (
    snapshot.catalogFingerprint !==
      EXPECTED_POST_CATALOG_FINGERPRINT
  ) {
    reasons.push(
      "CATALOG_POSTSTATE_FINGERPRINT_MISMATCH"
    );
  }

  if (
    objectFingerprint(snapshot.catalog) !==
      EXPECTED_POST_CATALOG_FINGERPRINT
  ) {
    reasons.push(
      "CATALOG_POSTSTATE_FINGERPRINT_RECOMPUTE_MISMATCH"
    );
  }

  if (
    !exactObjectEqual(
      snapshot.preservation,
      expected.preservation
    )
  ) {
    reasons.push(
      "PRESERVATION_POSTSTATE_MISMATCH"
    );
  }

  if (
    !exactObjectEqual(
      snapshot.ownerBackfillEligibility,
      expected.ownerBackfillEligibility
    )
  ) {
    reasons.push(
      "OWNER_ELIGIBILITY_POSTSTATE_MISMATCH"
    );
  }

  if (
    !exactObjectEqual(
      snapshot.ownerMembership,
      expected.ownerMembership
    )
  ) {
    reasons.push(
      "OWNER_MEMBERSHIP_POSTSTATE_MISMATCH"
    );
  }

  if (
    !exactObjectEqual(
      snapshot.operationalCounts,
      expected.operationalCounts
    )
  ) {
    reasons.push(
      "UNINTENDED_OPERATIONAL_ROWS"
    );
  }

  assertHistoricalLedgerShape(
    snapshot,
    reasons
  );

  if (reasons.length) {
    throw blocked(
      "POSTFLIGHT_BLOCKED",
      [...new Set(reasons)]
    );
  }

  return "ALREADY_APPLIED";
}

function inspectAuthorization(
  env,
  { execute = false } = {}
) {
  const reasons = [];

  const required = {
    NODE_ENV:
      "production",

    RAILWAY_PROJECT_ID:
      EXPECTED_PRODUCTION_TARGET.projectId,

    RAILWAY_PROJECT_NAME:
      EXPECTED_PRODUCTION_TARGET.projectName,

    RAILWAY_ENVIRONMENT_ID:
      EXPECTED_PRODUCTION_TARGET.environmentId,

    RAILWAY_ENVIRONMENT_NAME:
      EXPECTED_PRODUCTION_TARGET.environmentName,

    RAILWAY_SERVICE_ID:
      EXPECTED_PRODUCTION_TARGET.databaseServiceId,

    RAILWAY_SERVICE_NAME:
      EXPECTED_PRODUCTION_TARGET.databaseServiceName,

    EXPECTED_PRESTATE_SERVER_SHA:
      PRODUCTION_PRESTATE.serverSha,

    EXPECTED_PRESTATE_IMAGE_DIGEST:
      PRODUCTION_PRESTATE.imageDigest,

    EXPECTED_PRESTATE_DEPLOYMENT_ID:
      CERTIFIED_PRE_MAINTENANCE_DEPLOYMENT_ID,

    ACTUAL_PRE_MAINTENANCE_DEPLOYMENT_ID:
      CERTIFIED_PRE_MAINTENANCE_DEPLOYMENT_ID,

    EXPECTED_PRESTATE_FINGERPRINT:
      PRESTATE_FINGERPRINT,

    EXPECTED_PRESTATE_LEDGER_FINGERPRINT:
      PRESTATE_LEDGER_FINGERPRINT,

    EXPECTED_POST_LEDGER_FINGERPRINT:
      EXPECTED_POST_LEDGER_FINGERPRINT,

    CONFIRM_PRODUCTION_TARGET:
      `${EXPECTED_PRODUCTION_TARGET.projectName}/production/Postgres/railway`,

    PRODUCTION_CONVERGENCE_ID:
      CONVERGENCE_ID,
  };

  for (
    const [key, value]
    of Object.entries(required)
  ) {
    if (env[key] !== value) {
      reasons.push(
        `${key}_MISMATCH`
      );
    }
  }

  if (
    !UUID_PATTERN.test(
      env.ACTUAL_PRE_MAINTENANCE_DEPLOYMENT_ID ||
        ""
    )
  ) {
    reasons.push(
      "ACTUAL_PRE_MAINTENANCE_DEPLOYMENT_ID_INVALID"
    );
  }

  if (execute) {
    if (!env.CERTIFIED_BACKUP_REFERENCE) {
      reasons.push(
        "BACKUP_REFERENCE_MISSING"
      );
    }

    if (
      !SHA256_PATTERN.test(
        env.CERTIFIED_BACKUP_SHA256 || ""
      )
    ) {
      reasons.push(
        "BACKUP_CHECKSUM_INVALID"
      );
    }

    if (!env.RESTORE_CERTIFICATION_REFERENCE) {
      reasons.push(
        "RESTORE_PROOF_MISSING"
      );
    }

    if (!env.MAINTENANCE_BRIDGE_PROOF_PATH) {
      reasons.push(
        "MAINTENANCE_PROOF_PATH_MISSING"
      );
    }

    if (
      !SHA256_PATTERN.test(
        env.MAINTENANCE_BRIDGE_PROOF_SHA256 ||
          ""
      )
    ) {
      reasons.push(
        "MAINTENANCE_PROOF_CHECKSUM_INVALID"
      );
    }

    if (
      !IMAGE_DIGEST_PATTERN.test(
        env.EXPECTED_MAINTENANCE_BRIDGE_IMAGE_DIGEST ||
          ""
      )
    ) {
      reasons.push(
        "EXPECTED_MAINTENANCE_BRIDGE_IMAGE_INVALID"
      );
    }

    if (
      !UUID_PATTERN.test(
        env.CURRENT_MAINTENANCE_BRIDGE_DEPLOYMENT_ID ||
          ""
      )
    ) {
      reasons.push(
        "CURRENT_MAINTENANCE_BRIDGE_DEPLOYMENT_INVALID"
      );
    }

    if (
      !IMAGE_DIGEST_PATTERN.test(
        env.CURRENT_MAINTENANCE_BRIDGE_IMAGE_DIGEST ||
          ""
      )
    ) {
      reasons.push(
        "CURRENT_MAINTENANCE_BRIDGE_IMAGE_INVALID"
      );
    }

    if (
      env.CURRENT_MAINTENANCE_BRIDGE_IMAGE_DIGEST !==
      env.EXPECTED_MAINTENANCE_BRIDGE_IMAGE_DIGEST
    ) {
      reasons.push(
        "CURRENT_MAINTENANCE_BRIDGE_IMAGE_MISMATCH"
      );
    }

    if (
      env.CURRENT_MAINTENANCE_BRIDGE_CURRENT !==
      "true"
    ) {
      reasons.push(
        "CURRENT_MAINTENANCE_BRIDGE_NOT_CURRENT"
      );
    }

    if (
      env.CONFIRM_PRODUCTION_CONVERGENCE !==
      "EXECUTE_MC_PRODUCTION_CONVERGENCE_005"
    ) {
      reasons.push(
        "EXECUTION_ACKNOWLEDGEMENT_MISMATCH"
      );
    }
  }

  return Object.freeze({
    authorized: reasons.length === 0,
    reasons: [...new Set(reasons)],
  });
}

module.exports = Object.freeze({
  FILENAME_PATTERN,
  IMAGE_DIGEST_PATTERN,
  MIGRATIONS_DIRECTORY,
  SHA256_PATTERN,
  TRANSACTION_PROHIBITED,
  UUID_PATTERN,

  assertPostflightSnapshot,
  assertPreflightSnapshot,
  blocked,
  classifySnapshot,
  compareLedger,
  exactObjectEqual,
  expectedPostLedger,
  extractTargetMarkers,
  inspectAuthorization,
  loadTargetMigrations,
  validateManifest,
});
