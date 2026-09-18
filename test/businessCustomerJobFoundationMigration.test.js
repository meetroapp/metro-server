"use strict";

const assert =
  require("node:assert/strict");
const {
  readFileSync,
} = require("node:fs");
const test = require("node:test");

const sql = readFileSync(
  "migrations/202609160007_create_business_customer_job_source_foundation.sql",
  "utf8"
);

test(
  "business_customer Job source is independent of Request and Quote",
  () => {
    assert.match(
      sql,
      /CREATE TABLE IF NOT EXISTS business_customer_job_sources/i
    );

    assert.match(
      sql,
      /source_type = 'business_customer'[\s\S]*job_request_id IS NULL[\s\S]*source_request_selection_id IS NULL[\s\S]*source_request_relationship_id IS NULL[\s\S]*contractor_profile_id IS NOT NULL[\s\S]*business_contact_id IS NOT NULL[\s\S]*business_customer_relationship_id IS NOT NULL[\s\S]*originating_business_document_id IS NULL[\s\S]*source_business_customer_job_id IS NOT NULL/i
    );
  }
);

test(
  "business customer source owns project identity and separate service location",
  () => {
    assert.match(
      sql,
      /project_title TEXT NOT NULL/i
    );

    assert.match(
      sql,
      /project_description TEXT NOT NULL/i
    );

    assert.match(
      sql,
      /location_state TEXT NOT NULL/i
    );

    assert.match(
      sql,
      /service_location_text TEXT/i
    );

    assert.match(
      sql,
      /service_address_line1 TEXT/i
    );

    assert.match(
      sql,
      /service_city TEXT/i
    );

    assert.match(
      sql,
      /service_region TEXT/i
    );

    assert.match(
      sql,
      /service_postal_code TEXT/i
    );

    assert.match(
      sql,
      /service_country_code TEXT/i
    );
  }
);

test(
  "source requires exact durable Customer authority",
  () => {
    assert.match(
      sql,
      /business_customer_relationships/i
    );

    assert.match(
      sql,
      /contacts\.status = 'ACTIVE'/i
    );

    assert.match(
      sql,
      /roles\.role = 'CUSTOMER'/i
    );

    assert.match(
      sql,
      /roles\.ended_at IS NULL/i
    );
  }
);

test(
  "business customer participant evidence contains no Meetro customer participant",
  () => {
    assert.match(
      sql,
      /'business_customer'/i
    );

    assert.match(
      sql,
      /source_evidence_type =\s*'business_customer'[\s\S]*request_relationship_id IS NULL/i
    );

    assert.doesNotMatch(
      sql,
      /INSERT INTO request_selections/i
    );

    assert.doesNotMatch(
      sql,
      /INSERT INTO request_relationships/i
    );

    assert.doesNotMatch(
      sql,
      /INSERT INTO conversations/i
    );
  }
);

test(
  "foundation does not generalize Evaluation Quote or downstream lifecycle",
  () => {
    assert.doesNotMatch(
      sql,
      /ALTER TABLE canonical_evaluations/i
    );

    assert.doesNotMatch(
      sql,
      /ALTER TABLE canonical_quotes/i
    );

    assert.doesNotMatch(
      sql,
      /canonical_pre_work_deposit/i
    );

    assert.doesNotMatch(
      sql,
      /canonical_visits/i
    );

    assert.doesNotMatch(
      sql,
      /canonical_invoices/i
    );
  }
);
