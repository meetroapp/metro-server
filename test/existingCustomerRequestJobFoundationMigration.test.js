"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");

const sql = readFileSync(
  "migrations/202609160006_create_existing_customer_request_job_foundation.sql",
  "utf8"
);

test("Jobs support the third existing_customer_request source", () => {
  assert.match(
    sql,
    /source_type IN \([\s\S]*'ordinary_request_selection'[\s\S]*'existing_customer_request'[\s\S]*'business_document'/i
  );
});

test("existing-customer Job has request and relationship but no selection or business-owned identity", () => {
  assert.match(
    sql,
    /source_type = 'existing_customer_request'[\s\S]*job_request_id IS NOT NULL[\s\S]*source_request_selection_id IS NULL[\s\S]*source_request_relationship_id IS NOT NULL[\s\S]*contractor_profile_id IS NULL[\s\S]*business_contact_id IS NULL[\s\S]*business_customer_relationship_id IS NULL[\s\S]*originating_business_document_id IS NULL/i
  );
});

test("database proves the fresh request relationship tuple", () => {
  assert.match(
    sql,
    /assert_existing_customer_request_job_source/i
  );

  assert.match(
    sql,
    /posts\.request_origin =\s*'existing_customer_request'[\s\S]*relationships\.homeowner_id =\s*posts\.user_id[\s\S]*relationships\.contractor_id =\s*posts\.target_contractor_profile_id[\s\S]*relationships\.professional_user_id =\s*posts\.target_professional_user_id/i
  );

  assert.match(
    sql,
    /relationships\.ordinary_authority_source =\s*'existing_customer_request'/i
  );

  assert.match(
    sql,
    /relationships\.source_meetro_relationship_id =\s*posts\.source_meetro_relationship_id/i
  );
});

test("participant evidence supports direct authenticated customer Jobs", () => {
  assert.match(
    sql,
    /source_evidence_type IN \([\s\S]*'request_selection'[\s\S]*'existing_customer_request'[\s\S]*'business_document'/i
  );

  assert.match(
    sql,
    /source_evidence_type =\s*'existing_customer_request'[\s\S]*request_relationship_id IS NOT NULL/i
  );
});

test("Job foundation does not generalize Quotes or downstream lifecycle yet", () => {
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
});
