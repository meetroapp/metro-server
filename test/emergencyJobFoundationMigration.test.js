"use strict";

const assert =
  require("node:assert/strict");

const fs =
  require("node:fs");

const path =
  require("node:path");

const test =
  require("node:test");

const migration = fs.readFileSync(
  path.join(
    __dirname,
    "..",
    "migrations",
    "202609190001_create_emergency_job_foundation.sql"
  ),
  "utf8"
);

test(
  "Emergency Job migration adds a fifth exact Job source without creating historical rows",
  () => {
    assert.match(
      migration,
      /source_emergency_request_id INTEGER/
    );

    assert.match(
      migration,
      /'emergency_request'/
    );

    assert.match(
      migration,
      /jobs_emergency_request_source_fkey/
    );

    assert.match(
      migration,
      /jobs_emergency_request_source_uidx/
    );

    assert.match(
      migration,
      /assert_emergency_request_job_source/
    );

    assert.match(
      migration,
      /relationship\.status = 'active'/
    );

    assert.match(
      migration,
      /emergency\.homeowner_id =\s+NEW\.created_by_user_id/
    );

    assert.match(
      migration,
      /'emergency_selection'/
    );

    assert.doesNotMatch(
      migration,
      /INSERT\s+INTO\s+jobs/i
    );

    assert.doesNotMatch(
      migration,
      /INSERT\s+INTO\s+emergency_requests/i
    );
  }
);

test(
  "Emergency Job source cannot fabricate ordinary or business-customer provenance",
  () => {
    const emergencyShape =
      migration.slice(
        migration.indexOf(
          "source_type =\n        'emergency_request'"
        ),
        migration.indexOf(
          "CREATE OR REPLACE FUNCTION\nassert_emergency_request_job_source"
        )
      );

    assert.match(
      emergencyShape,
      /job_request_id IS NULL/
    );

    assert.match(
      emergencyShape,
      /source_request_selection_id IS NULL/
    );

    assert.match(
      emergencyShape,
      /source_request_relationship_id IS NOT NULL/
    );

    assert.match(
      emergencyShape,
      /source_emergency_request_id IS NOT NULL/
    );

    assert.match(
      emergencyShape,
      /business_contact_id IS NULL/
    );

    assert.match(
      emergencyShape,
      /source_business_customer_job_id IS NULL/
    );
  }
);
