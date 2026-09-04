"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const { getMigrationFiles } = require("../scripts/run-migrations");
const {
  ARCHIVE_MIGRATION,
  BASELINE_FILENAME,
  CURRENT_PRODUCTION_LEDGER,
  TARGET_MIGRATIONS,
} = require("../production-convergence/004/manifest");

const migrationsDirectory = join(__dirname, "..", "migrations");
const filenamePattern = /^\d{12}_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;
const repositoryPrefix = CURRENT_PRODUCTION_LEDGER
  .filter(({ filename }) => filename !== ARCHIVE_MIGRATION.filename)
  .map(({ filename, checksum }) => ({ filename, checksum }));
const externalLifecycleMigrations = require("./helpers/externalLifecycleMigrationInventory");
const expectedInventory = [
  {
    filename: BASELINE_FILENAME,
    checksum: "9deb147862d67b15b8779ab9ab69d8561a1f5dc87a0ad5599e0fc7c9de067236",
  },
  ...repositoryPrefix,
  ...TARGET_MIGRATIONS.map(({ filename, checksum }) => ({ filename, checksum })),
  ...externalLifecycleMigrations,
].sort((left, right) => left.filename.localeCompare(right.filename));

function checksum(filename) {
  return createHash("sha256")
    .update(readFileSync(join(migrationsDirectory, filename), "utf8"))
    .digest("hex");
}

test("the governed repository migration inventory is the exact certified 83-file generation", () => {
  const actual = getMigrationFiles().map(({ filename }) => filename);
  const expected = expectedInventory.map(({ filename }) => filename);

  assert.equal(expectedInventory.length, 83);
  assert.deepEqual(actual, expected);
  assert.equal(actual.at(-1), "202609040001_add_evaluation_revision_authority.sql");
  assert.equal(new Set(actual).size, actual.length);
  assert.ok(actual.every((filename) => filenamePattern.test(filename)));
});

test("every governed migration retains its exact certified checksum", () => {
  for (const expected of expectedInventory) {
    assert.equal(checksum(expected.filename), expected.checksum, expected.filename);
  }
});

test("duplicate timestamp prefixes remain distinct full-filename identities", () => {
  assert.equal(
    TARGET_MIGRATIONS[0].filename,
    "202608090001_create_job_lifecycle_concern_foundation.sql"
  );
  assert.equal(
    ARCHIVE_MIGRATION.filename,
    "202608090001_create_legacy_orphan_message_archive.sql"
  );
  assert.notEqual(TARGET_MIGRATIONS[0].checksum, ARCHIVE_MIGRATION.checksum);
});
