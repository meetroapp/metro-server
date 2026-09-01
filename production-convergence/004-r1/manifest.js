"use strict";

const base = require("../004/manifest");

const CONVERGENCE_ID = "MC-PRODUCTION-CONVERGENCE-004-R1";
const EXECUTION_TARGET = "production-convergence-004-legacy-owner-reconciliation";
const VARIANT_FILENAME =
  "202608300005_create_business_team_membership_authority_production_legacy_orphans.sql";
const VARIANT_CHECKSUM =
  "34e224b1e4a84ba89ef1c9ebced82a1c40af09e98275f185afcc7546ffca3ffd";
const CANONICAL_TEAM_FILENAME =
  "202608300005_create_business_team_membership_authority.sql";
const CANONICAL_TEAM_CHECKSUM =
  "a851a467a1b1aee0b92ac0cc2667383bcf22b296df0f51588e225d5f748d8e3e";

const OWNER_BACKFILL_ELIGIBILITY = Object.freeze({
  profileCount: 6,
  eligibleProfileCount: 4,
  ineligibleProfileCount: 2,
  eligibilityFingerprint:
    "279c3794a30a1fe2a4a7a118f8ed6f6e01c9582fc51e0daf4a1781be17311b5a",
});

const PRODUCTION_PRESTATE = Object.freeze({
  ...base.PRODUCTION_PRESTATE,
  ownerBackfillEligibility: OWNER_BACKFILL_ELIGIBILITY,
});

const TARGET_MIGRATIONS = Object.freeze(base.TARGET_MIGRATIONS.map((entry) =>
  entry.order === 43
    ? Object.freeze({
        ...entry,
        filename: VARIANT_FILENAME,
        checksum: VARIANT_CHECKSUM,
        purpose: "create business team membership authority while preserving legacy orphan profiles",
      })
    : entry
));

const EXPECTED_POST_OWNER_MEMBERSHIP = Object.freeze({
  businesses: 6,
  eligibleBusinesses: 4,
  ineligibleBusinesses: 2,
  owners: 4,
  businessesWithoutMembership: 2,
  duplicateOwners: 0,
  nonOwners: 0,
  unrelatedOwners: 0,
});

module.exports = Object.freeze({
  ADVISORY_LOCK_ID: base.ADVISORY_LOCK_ID,
  ARCHIVE_MIGRATION: base.ARCHIVE_MIGRATION,
  BASELINE_FILENAME: base.BASELINE_FILENAME,
  CANONICAL_TEAM_CHECKSUM,
  CANONICAL_TEAM_FILENAME,
  CONVERGENCE_ID,
  CURRENT_PRODUCTION_LEDGER: base.CURRENT_PRODUCTION_LEDGER,
  EXECUTION_TARGET,
  EXPECTED_POST_OWNER_MEMBERSHIP,
  EXPECTED_PRODUCTION_TARGET: base.EXPECTED_PRODUCTION_TARGET,
  OWNER_BACKFILL_ELIGIBILITY,
  PRODUCTION_PRESTATE,
  TARGET_MIGRATIONS,
  VARIANT_CHECKSUM,
  VARIANT_FILENAME,
});
