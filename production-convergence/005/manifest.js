"use strict";

const crypto = require("node:crypto");
const r1 = require("../004-r1/manifest");

const CONVERGENCE_ID =
  "MC-PRODUCTION-CONVERGENCE-005";

const EXECUTION_TARGET =
  "production-convergence-005-four-origin-lifecycle";

const CERTIFIED_SOURCE_SHA =
  "46758a7ef0da5237a713560722358b6bf09c9b02";

const CERTIFIED_IMAGE_DIGEST =
  "sha256:6a0ff6e1f537d568588706d69e640050b6bc6be6f572683c69d91180ba65cf3f";

const CERTIFIED_PRE_MAINTENANCE_DEPLOYMENT_ID =
  "ed758eca-0226-4405-940c-e453ad49ed43";

const EXPECTED_PRE_LEDGER_ROWS = 75;
const EXPECTED_POST_LEDGER_ROWS = 99;

const PRESTATE_LEDGER_FINGERPRINT =
  "7ee78065b5ca5a6f40c14342e289b8f2135995f8f4ff16a39656ae4b2dcf3e0b";

const PRESTATE_CATALOG_FINGERPRINT =
  "d2fe5986d11b798fcd57a678add8b2eae8a29ebb3e19d9ae0709729763cb334c";

const PRESTATE_FINGERPRINT =
  "151d8a31ad8fb305cfdf8dd1965a51397791bb70f5e51de31c32a22779819575";

const EXPECTED_POST_LEDGER_FINGERPRINT =
  "327cab9fbaa6af56a084b75b04938228653ebe28deea795bf6d1c39e0ee15434";

const EXPECTED_POST_CATALOG_FINGERPRINT =
  "b66e88091661ce0804581fbdd908c64f958e4869c3e35c1b6f926521714f0d6f";

const CURRENT_PRODUCTION_LEDGER = Object.freeze(
  [
    ...r1.CURRENT_PRODUCTION_LEDGER.map((entry) =>
      Object.freeze({ ...entry })
    ),

    ...r1.TARGET_MIGRATIONS.map((entry) =>
      Object.freeze({
        filename: entry.filename,
        checksum: entry.checksum,
        executionTarget: r1.EXECUTION_TARGET,
      })
    ),
  ]
    .sort((left, right) =>
      left.filename.localeCompare(right.filename)
    )
);

const TARGET_MIGRATIONS = Object.freeze([
  Object.freeze({
    order: 1,
    filename:
      "202609020001_add_business_origin_commercial_job_foundation.sql",
    checksum:
      "332eb2ef7f08340931e1d583b3056ae727a724ed15851bba76076258444ed41d",
  }),
  Object.freeze({
    order: 2,
    filename:
      "202609020002_create_quote_external_approval_authority.sql",
    checksum:
      "dc371b7540461320eff30a686c86ec889e7de07fcfd62528b6182ba2d7abb776",
  }),
  Object.freeze({
    order: 3,
    filename:
      "202609020003_generalize_pre_work_deposit_approval_authority.sql",
    checksum:
      "8c7a089876eaad046c2db00fd50d64eb13393e474f4a1b29737228426e9bda93",
  }),
  Object.freeze({
    order: 4,
    filename:
      "202609020004_generalize_approved_work_visit_approval_authority.sql",
    checksum:
      "448481c6a55de4fbc750201db6b54e3a42812e399209dfbdbcd1cc9598ee5fde",
  }),
  Object.freeze({
    order: 5,
    filename:
      "202609020005_create_external_visit_schedule_confirmation.sql",
    checksum:
      "7cb1b75536b425dbb9cdfa0aef96b5a1aaa11950b67d0cacc625185e4c8e0d0a",
  }),
  Object.freeze({
    order: 6,
    filename:
      "202609020006_generalize_work_preparation_execution_approval.sql",
    checksum:
      "4dda2aac1af54904293128be0dd95b5957304f30a31b9d5678776787cccfa853",
  }),
  Object.freeze({
    order: 7,
    filename:
      "202609020007_create_payment_reminder_evidence.sql",
    checksum:
      "c381e497a79f058bcf7356068d8563b5b7ba8cc1d05b05318055c00b69e624a2",
  }),
  Object.freeze({
    order: 8,
    filename:
      "202609040001_add_evaluation_revision_authority.sql",
    checksum:
      "f091be088798dfdc916ef8a4b7aca0ec8f084b1f2c782231cc9ca43dbd54830b",
  }),
  Object.freeze({
    order: 9,
    filename:
      "202609070001_archive_numbered_business_document_drafts.sql",
    checksum:
      "6cafac5527170caeaaeb8fa0c896702fb171ac12e3c5818c68b1c8b97bef9129",
  }),
  Object.freeze({
    order: 10,
    filename:
      "202609120001_generalize_business_job_invoice_completion.sql",
    checksum:
      "33289c8c1e0b88a4767d6dd10d1198f0d2b3d3e0b8199283ac71356b937f4cff",
  }),
  Object.freeze({
    order: 11,
    filename:
      "202609160001_create_meetro_customer_business_relationship_foundation.sql",
    checksum:
      "3ea8e836c5a6d8b884fac268774dc2f374f3d9ac2d770990d4fbd4b751748b94",
  }),
  Object.freeze({
    order: 12,
    filename:
      "202609160002_create_homeowner_saved_professionals.sql",
    checksum:
      "5ba6afea883b7985a982184f61bc1c722e5f8a0b80b4d4a8e18dcd0b42ca9bb1",
  }),
  Object.freeze({
    order: 13,
    filename:
      "202609160004_create_existing_customer_request_source_foundation.sql",
    checksum:
      "80b7644a7a653b4380fbb4551011373b29a4a09a88473c742893749111100d59",
  }),
  Object.freeze({
    order: 14,
    filename:
      "202609160005_create_existing_customer_request_conversation_authority.sql",
    checksum:
      "00a20647e10ffa7d4cdba0b0dab9d0db2ecc11a4a0ed449bc833ead0d659e1f6",
  }),
  Object.freeze({
    order: 15,
    filename:
      "202609160006_create_existing_customer_request_job_foundation.sql",
    checksum:
      "2a7cbb6b6d4df0065d901d8953f4dd3d46e6f5f71939c55f48fc122090880f39",
  }),
  Object.freeze({
    order: 16,
    filename:
      "202609160007_create_business_customer_job_source_foundation.sql",
    checksum:
      "afdf67cfd81f2edef0fd74a27d43934ef0f3e440ae5daf0498e24418321d6020",
  }),
  Object.freeze({
    order: 17,
    filename:
      "202609160008_generalize_canonical_evaluation_job_sources.sql",
    checksum:
      "a7c4c12941bcf56f157aae4b61c9c7085c1c7c3d3d25f28e22a925c184f87f60",
  }),
  Object.freeze({
    order: 18,
    filename:
      "202609160009_create_business_customer_evaluation_visit_confirmation.sql",
    checksum:
      "7c6aeeedfb4bb1cf51583903c988fc4ab4bb1894c6086bd96b83ffea567b9201",
  }),
  Object.freeze({
    order: 19,
    filename:
      "202609160010_generalize_canonical_job_quote_sources.sql",
    checksum:
      "274a0d61169d5affdeb1506b1293614fae7b1a6e266eaa2cd6545512692e5227",
  }),
  Object.freeze({
    order: 20,
    filename:
      "202609160011_generalize_external_quote_approval_sources.sql",
    checksum:
      "eb22fa582973a55499c8a48cb826a02d992a466226e448d1be3458ba0c22641d",
  }),
  Object.freeze({
    order: 21,
    filename:
      "202609160012_generalize_pre_work_deposit_job_origins.sql",
    checksum:
      "92d750fa0be823d71955ad2bdbb00f49d9df7b01976af1bcc87593850958f606",
  }),
  Object.freeze({
    order: 22,
    filename:
      "202609160013_generalize_approved_work_root_job_origins.sql",
    checksum:
      "9062981305df8706793023f13b6d2520bb0101f74d0553a382706345f8bdcd0a",
  }),
  Object.freeze({
    order: 23,
    filename:
      "202609160014_generalize_external_visit_confirmation_sources.sql",
    checksum:
      "a439856b88be927f188ca27f73ac51dd3bbe6312c8abce19863fadf1f6cb5196",
  }),
  Object.freeze({
    order: 24,
    filename:
      "202609160015_generalize_invoice_job_origins.sql",
    checksum:
      "f140bf3f70c2d44c1676aa11d9bca33e6e3976df9f24f07c47c317b0ac13078e",
  }),
]);

const PRESTATE_CATALOG = Object.freeze({
  tables: Object.freeze({
    count: 145,
    sha256:
      "4465c17b9ac4856a606d03ff5eded1eb3dd27651eaa869f09fdb85b627df9387",
  }),
  columns: Object.freeze({
    count: 1830,
    sha256:
      "e5f4782d2768f63d76e3058da09912d12fa64d0beb0f967bf4fd77c71fc6ea1b",
  }),
  constraints: Object.freeze({
    count: 3097,
    sha256:
      "a492d2cc5e57f7408ad0d3d54431823dcce3ad0a518d21982ce9a0d270837b5b",
  }),
  indexes: Object.freeze({
    count: 633,
    sha256:
      "d6f01f982c1a67143ddc44cd790e13b06b29f7123ea1db36291b4f1275e2557d",
  }),
  functions: Object.freeze({
    count: 54,
    sha256:
      "cd2e54dca726d8f6eb6edb587442a6d2353c6d17762db41714143aeec6751071",
  }),
  triggers: Object.freeze({
    count: 135,
    sha256:
      "baf5c1ca787a71b7065de16b92385a8d01c97e24d9c4d0c52bfc9de9ff434b48",
  }),
});

const EXPECTED_POST_CATALOG = Object.freeze({
  tables: Object.freeze({
    count: 158,
    sha256:
      "a51b8421a0e574389d464883ce494190e3dcaf1fb147074e28e1247e6162fd34",
  }),
  columns: Object.freeze({
    count: 2094,
    sha256:
      "8dc2b5de43ef94c348b49b7fd90f53fec53dd06005f6bbbf47399613c6870726",
  }),
  constraints: Object.freeze({
    count: 3538,
    sha256:
      "a7d490e129ce43a8f2fa041e12c904d173975142b52198af5b95ad388ea3da01",
  }),
  indexes: Object.freeze({
    count: 752,
    sha256:
      "74edfeaae0db1f12b772a6c0895d0fa95999b39abe32d5b8a81d1d80a0946e88",
  }),
  functions: Object.freeze({
    count: 83,
    sha256:
      "6ee40f134d084c45604172fbccce9f11d1f6c8ebe4e7f21219143787466e0728",
  }),
  triggers: Object.freeze({
    count: 184,
    sha256:
      "4d86a966d216ca97d41e6474bf3de72b6d1572954297d0ff4b301c5e745b7b4a",
  }),
});

const PRESTATE_OPERATIONAL_COUNTS = Object.freeze({
  jobs: 0,
  reported_concerns: 0,
  relationship_participants: 0,
  canonical_evaluations: 0,
  canonical_evaluation_findings: 0,
  canonical_workstreams: 0,
  canonical_recommendations: 0,
  canonical_quotes: 0,
  canonical_invoices: 0,
  canonical_invoice_payments: 0,
  canonical_pre_work_deposit_obligations: 0,
  canonical_material_purchase_records: 0,
  canonical_approved_work_executions: 0,
  business_job_assignments: 0,
  business_time_sessions: 0,
  intelligence_quote_composition_feedback: 0,
});

const PRODUCTION_PRESTATE = Object.freeze({
  serverSha: CERTIFIED_SOURCE_SHA,
  deploymentId: CERTIFIED_PRE_MAINTENANCE_DEPLOYMENT_ID,
  imageDigest: CERTIFIED_IMAGE_DIGEST,

  postgresVersion: "18.6",

  ledgerRows: EXPECTED_PRE_LEDGER_ROWS,
  ledgerFingerprint: PRESTATE_LEDGER_FINGERPRINT,

  catalog: PRESTATE_CATALOG,
  catalogFingerprint: PRESTATE_CATALOG_FINGERPRINT,

  preservation: r1.PRODUCTION_PRESTATE.preservation,

  ownerBackfillEligibility:
    r1.OWNER_BACKFILL_ELIGIBILITY,

  ownerMembership:
    r1.EXPECTED_POST_OWNER_MEMBERSHIP,

  operationalCounts:
    PRESTATE_OPERATIONAL_COUNTS,

  prestateFingerprint:
    PRESTATE_FINGERPRINT,
});

function ledgerIdentityFingerprint(entries) {
  const material = entries
    .map(({ filename, checksum }) => ({
      filename,
      checksum,
    }))
    .sort((left, right) =>
      left.filename.localeCompare(right.filename)
    )
    .map(
      ({ filename, checksum }) =>
        `${filename}\0${checksum}`
    )
    .join("\n");

  return crypto
    .createHash("sha256")
    .update(material)
    .digest("hex");
}

module.exports = Object.freeze({
  ADVISORY_LOCK_ID: r1.ADVISORY_LOCK_ID,

  ARCHIVE_MIGRATION: r1.ARCHIVE_MIGRATION,

  BASELINE_FILENAME: r1.BASELINE_FILENAME,

  CANONICAL_TEAM_CHECKSUM:
    r1.CANONICAL_TEAM_CHECKSUM,

  CANONICAL_TEAM_FILENAME:
    r1.CANONICAL_TEAM_FILENAME,

  CERTIFIED_IMAGE_DIGEST,
  CERTIFIED_PRE_MAINTENANCE_DEPLOYMENT_ID,
  CERTIFIED_SOURCE_SHA,

  CONVERGENCE_ID,

  CURRENT_PRODUCTION_LEDGER,

  EXECUTION_TARGET,

  EXPECTED_POST_CATALOG,
  EXPECTED_POST_CATALOG_FINGERPRINT,

  EXPECTED_POST_LEDGER_FINGERPRINT,
  EXPECTED_POST_LEDGER_ROWS,

  EXPECTED_PRE_LEDGER_ROWS,

  EXPECTED_PRODUCTION_RUNTIME:
    r1.EXPECTED_PRODUCTION_RUNTIME,

  EXPECTED_PRODUCTION_TARGET:
    r1.EXPECTED_PRODUCTION_TARGET,

  OWNER_BACKFILL_ELIGIBILITY:
    r1.OWNER_BACKFILL_ELIGIBILITY,

  PRESTATE_CATALOG,
  PRESTATE_CATALOG_FINGERPRINT,
  PRESTATE_FINGERPRINT,
  PRESTATE_LEDGER_FINGERPRINT,
  PRESTATE_OPERATIONAL_COUNTS,

  PRODUCTION_PRESTATE,

  TARGET_MIGRATIONS,

  VARIANT_CHECKSUM:
    r1.VARIANT_CHECKSUM,

  VARIANT_FILENAME:
    r1.VARIANT_FILENAME,

  EXPECTED_POST_OWNER_MEMBERSHIP:
    r1.EXPECTED_POST_OWNER_MEMBERSHIP,

  ledgerIdentityFingerprint,
});
