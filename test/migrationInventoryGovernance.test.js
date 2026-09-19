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
  { filename: "202609070001_archive_numbered_business_document_drafts.sql", checksum: "6cafac5527170caeaaeb8fa0c896702fb171ac12e3c5818c68b1c8b97bef9129" },
  { filename: "202609120001_generalize_business_job_invoice_completion.sql", checksum: "33289c8c1e0b88a4767d6dd10d1198f0d2b3d3e0b8199283ac71356b937f4cff" },

  { filename: "202609160001_create_meetro_customer_business_relationship_foundation.sql", checksum: "3ea8e836c5a6d8b884fac268774dc2f374f3d9ac2d770990d4fbd4b751748b94" },
  { filename: "202609160002_create_homeowner_saved_professionals.sql", checksum: "5ba6afea883b7985a982184f61bc1c722e5f8a0b80b4d4a8e18dcd0b42ca9bb1" },
  { filename: "202609160004_create_existing_customer_request_source_foundation.sql", checksum: "80b7644a7a653b4380fbb4551011373b29a4a09a88473c742893749111100d59" },
  { filename: "202609160005_create_existing_customer_request_conversation_authority.sql", checksum: "00a20647e10ffa7d4cdba0b0dab9d0db2ecc11a4a0ed449bc833ead0d659e1f6" },
  { filename: "202609160006_create_existing_customer_request_job_foundation.sql", checksum: "2a7cbb6b6d4df0065d901d8953f4dd3d46e6f5f71939c55f48fc122090880f39" },
  { filename: "202609160007_create_business_customer_job_source_foundation.sql", checksum: "afdf67cfd81f2edef0fd74a27d43934ef0f3e440ae5daf0498e24418321d6020" },
  { filename: "202609160008_generalize_canonical_evaluation_job_sources.sql", checksum: "a7c4c12941bcf56f157aae4b61c9c7085c1c7c3d3d25f28e22a925c184f87f60" },
  { filename: "202609160009_create_business_customer_evaluation_visit_confirmation.sql", checksum: "7c6aeeedfb4bb1cf51583903c988fc4ab4bb1894c6086bd96b83ffea567b9201" },
  { filename: "202609160010_generalize_canonical_job_quote_sources.sql", checksum: "274a0d61169d5affdeb1506b1293614fae7b1a6e266eaa2cd6545512692e5227" },
  { filename: "202609160011_generalize_external_quote_approval_sources.sql", checksum: "eb22fa582973a55499c8a48cb826a02d992a466226e448d1be3458ba0c22641d" },
  { filename: "202609160012_generalize_pre_work_deposit_job_origins.sql", checksum: "92d750fa0be823d71955ad2bdbb00f49d9df7b01976af1bcc87593850958f606" },
  { filename: "202609160013_generalize_approved_work_root_job_origins.sql", checksum: "9062981305df8706793023f13b6d2520bb0101f74d0553a382706345f8bdcd0a" },
  { filename: "202609160014_generalize_external_visit_confirmation_sources.sql", checksum: "a439856b88be927f188ca27f73ac51dd3bbe6312c8abce19863fadf1f6cb5196" },
  { filename: "202609160015_generalize_invoice_job_origins.sql", checksum: "f140bf3f70c2d44c1676aa11d9bca33e6e3976df9f24f07c47c317b0ac13078e" },
  { filename: "202609180001_create_business_complimentary_access_authority.sql", checksum: "95eb5dc794b10e224e1a6b19c6f398860c84f100dffbdebb975aa4d59da0b4fb" },
].sort((left, right) => left.filename.localeCompare(right.filename));

function checksum(filename) {
  return createHash("sha256")
    .update(readFileSync(join(migrationsDirectory, filename), "utf8"))
    .digest("hex");
}

test("the governed repository migration inventory is the exact 100-file generation with four-origin customer and work authority", () => {
  const actual = getMigrationFiles().map(({ filename }) => filename);
  const expected = expectedInventory.map(({ filename }) => filename);

  assert.equal(expectedInventory.length, 100);
  assert.deepEqual(actual, expected);
  assert.equal(actual.at(-1), "202609180001_create_business_complimentary_access_authority.sql");
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
