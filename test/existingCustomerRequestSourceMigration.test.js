"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");

const sql = readFileSync(
  "migrations/202609160004_create_existing_customer_request_source_foundation.sql",
  "utf8"
);

test("existing-customer Job Requests have an additive governed origin", () => {
  assert.match(
    sql,
    /ADD COLUMN IF NOT EXISTS request_origin TEXT NOT NULL DEFAULT 'marketplace'/i
  );

  assert.match(
    sql,
    /request_origin IN \(\s*'marketplace',\s*'existing_customer_request'\s*\)/i
  );

  assert.match(
    sql,
    /ADD COLUMN IF NOT EXISTS target_contractor_profile_id INTEGER/i
  );

  assert.match(
    sql,
    /ADD COLUMN IF NOT EXISTS target_professional_user_id INTEGER/i
  );

  assert.match(
    sql,
    /ADD COLUMN IF NOT EXISTS source_meetro_relationship_id UUID/i
  );
});

test("marketplace and existing-customer source shapes cannot be blended", () => {
  assert.match(
    sql,
    /request_origin = 'marketplace'[\s\S]*target_contractor_profile_id IS NULL[\s\S]*target_professional_user_id IS NULL[\s\S]*source_meetro_relationship_id IS NULL/i
  );

  assert.match(
    sql,
    /request_origin = 'existing_customer_request'[\s\S]*target_contractor_profile_id IS NOT NULL[\s\S]*target_professional_user_id IS NOT NULL[\s\S]*source_meetro_relationship_id IS NOT NULL/i
  );
});

test("database proves the exact prior homeowner-professional relationship", () => {
  assert.match(
    sql,
    /meetro_customer_business_relationships_exact_identity_uidx[\s\S]*id,[\s\S]*homeowner_user_id,[\s\S]*contractor_profile_id,[\s\S]*professional_user_id/i
  );

  assert.match(
    sql,
    /posts_existing_customer_relationship_fkey[\s\S]*source_meetro_relationship_id,[\s\S]*user_id,[\s\S]*target_contractor_profile_id,[\s\S]*target_professional_user_id[\s\S]*REFERENCES meetro_customer_business_relationships[\s\S]*id,[\s\S]*homeowner_user_id,[\s\S]*contractor_profile_id,[\s\S]*professional_user_id/i
  );

  assert.match(
    sql,
    /posts_target_professional_owner_fkey[\s\S]*target_contractor_profile_id,[\s\S]*target_professional_user_id[\s\S]*REFERENCES contractor_profiles[\s\S]*id,[\s\S]*user_id/i
  );
});

test("Job Request target authority is immutable after creation", () => {
  assert.match(
    sql,
    /prevent_job_request_origin_authority_mutation/i
  );

  assert.match(
    sql,
    /BEFORE UPDATE OF[\s\S]*request_origin,[\s\S]*target_contractor_profile_id,[\s\S]*target_professional_user_id,[\s\S]*source_meetro_relationship_id/i
  );

  assert.match(
    sql,
    /Job Request origin authority is immutable/i
  );
});

test("existing-customer Request Relationships have provenance without a Professional Response", () => {
  assert.match(
    sql,
    /ordinary_authority_source IN \(\s*'professional_response',\s*'existing_customer_request'\s*\)/i
  );

  assert.match(
    sql,
    /professional_response_id IS NULL[\s\S]*ordinary_authority_source =\s*'existing_customer_request'[\s\S]*source_meetro_relationship_id IS NOT NULL[\s\S]*current_version >= 1[\s\S]*status IN \('active', 'closed'\)/i
  );

  assert.match(
    sql,
    /request_relationships_existing_customer_relationship_fkey[\s\S]*source_meetro_relationship_id,[\s\S]*homeowner_id,[\s\S]*contractor_id,[\s\S]*professional_user_id[\s\S]*REFERENCES meetro_customer_business_relationships/i
  );
});

test("relationship source must match the exact targeted Job Request", () => {
  assert.match(
    sql,
    /assert_existing_customer_request_relationship_source/i
  );

  assert.match(
    sql,
    /posts\.id = NEW\.post_id[\s\S]*posts\.user_id = NEW\.homeowner_id[\s\S]*posts\.request_origin =\s*'existing_customer_request'[\s\S]*posts\.target_contractor_profile_id =\s*NEW\.contractor_id[\s\S]*posts\.target_professional_user_id =\s*NEW\.professional_user_id[\s\S]*posts\.source_meetro_relationship_id =\s*NEW\.source_meetro_relationship_id/i
  );
});

test("Professional Response validation explicitly excludes the direct existing-customer source", () => {
  assert.match(
    sql,
    /NEW\.ordinary_authority_source =\s*'existing_customer_request'[\s\S]*NEW\.professional_response_id IS NULL[\s\S]*RETURN NEW/i
  );

  assert.match(
    sql,
    /relationship_record\.ordinary_authority_source <>\s*'professional_response'/i
  );
});

test("Saved Professional and business-private customer authority are not source proof", () => {
  assert.doesNotMatch(
    sql,
    /homeowner_saved_professionals/i
  );

  assert.doesNotMatch(
    sql,
    /business_contacts/i
  );

  assert.doesNotMatch(
    sql,
    /business_customer_relationships/i
  );
});
