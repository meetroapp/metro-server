"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const migrationPath = join(
  __dirname,
  "..",
  "migrations",
  "202609160011_generalize_external_quote_approval_sources.sql"
);

const source =
  readFileSync(migrationPath, "utf8");

test("011 makes external approval customer identity source-aware without replacing common approval", () => {
  assert.match(
    source,
    /ALTER TABLE canonical_quote_external_approval_evidence[\s\S]*ALTER COLUMN customer_snapshot_hash[\s\S]*DROP NOT NULL/i
  );

  assert.match(
    source,
    /ADD COLUMN IF NOT EXISTS[\s\S]*business_contact_id UUID/i
  );

  assert.match(
    source,
    /ADD COLUMN IF NOT EXISTS[\s\S]*business_customer_relationship_id UUID/i
  );

  assert.match(
    source,
    /canonical_quote_external_approval_customer_identity_shape_check/i
  );

  assert.match(
    source,
    /customer_snapshot_hash IS NOT NULL[\s\S]*business_contact_id IS NULL[\s\S]*business_customer_relationship_id IS NULL/i
  );

  assert.match(
    source,
    /customer_snapshot_hash IS NULL[\s\S]*business_contact_id IS NOT NULL[\s\S]*business_customer_relationship_id IS NOT NULL/i
  );
});

test("011 binds business_customer approval evidence to the exact immutable Quote customer party", () => {
  assert.match(
    source,
    /canonical_quote_customer_parties_external_approval_source_uidx/i
  );

  assert.match(
    source,
    /ON canonical_quote_customer_parties[\s\S]*quote_id[\s\S]*job_id[\s\S]*contractor_profile_id[\s\S]*business_contact_id[\s\S]*business_customer_relationship_id/i
  );

  assert.match(
    source,
    /canonical_quote_external_approval_customer_party_fk/i
  );

  assert.match(
    source,
    /FOREIGN KEY[\s\S]*quote_id[\s\S]*job_id[\s\S]*contractor_profile_id[\s\S]*business_contact_id[\s\S]*business_customer_relationship_id[\s\S]*REFERENCES canonical_quote_customer_parties/i
  );
});

test("011 preserves Quick Quote snapshot provenance while adding business_customer origin", () => {
  assert.match(
    source,
    /assert_external_quote_approval_business_origin/i
  );

  assert.match(
    source,
    /canonical_quote_customer_snapshots/i
  );

  assert.match(
    source,
    /quotes\.source_context_type[\s\S]*'business_document'/i
  );

  assert.match(
    source,
    /quotes\.job_source_type[\s\S]*'business_document'/i
  );

  assert.match(
    source,
    /canonical_quote_customer_parties/i
  );

  assert.match(
    source,
    /quotes\.source_context_type[\s\S]*'business_customer'/i
  );

  assert.match(
    source,
    /quotes\.job_source_type[\s\S]*'business_customer'/i
  );

  assert.match(
    source,
    /quotes\.business_customer_job_source_id[\s\S]*IS NOT NULL/i
  );
});

test("011 does not generalize the Quick Quote customer snapshot table itself", () => {
  assert.doesNotMatch(
    source,
    /CREATE OR REPLACE FUNCTION\s+assert_quote_customer_snapshot_business_origin/i
  );

  assert.doesNotMatch(
    source,
    /DROP TRIGGER IF EXISTS\s+canonical_quote_customer_snapshots_origin_guard/i
  );

  assert.doesNotMatch(
    source,
    /ALTER TABLE canonical_quote_customer_snapshots/i
  );
});

test("011 leaves authenticated Meetro customer approval and common approval authority untouched", () => {
  assert.doesNotMatch(
    source,
    /ALTER TABLE canonical_quote_customer_decisions/i
  );

  assert.doesNotMatch(
    source,
    /ALTER TABLE canonical_quote_approvals/i
  );

  assert.doesNotMatch(
    source,
    /CREATE TABLE IF NOT EXISTS canonical_quote_approvals/i
  );

  assert.match(
    source,
    /approval_source = MEETRO_CUSTOMER/i
  );

  assert.match(
    source,
    /approval_source = EXTERNAL_EVIDENCE/i
  );
});

test("011 is schema-only and creates no Quote, approval, payment, Visit, Job, or customer business row", () => {
  assert.doesNotMatch(
    source,
    /\bINSERT\s+INTO\s+(?:canonical_quotes|canonical_quote_approvals|canonical_quote_external_approval_evidence|canonical_quote_customer_decisions|canonical_quote_customer_parties|jobs|canonical_visits|canonical_pre_work_payment_receipts|business_contacts|business_customer_relationships)\b/i
  );

  assert.doesNotMatch(
    source,
    /\bUPDATE\s+(?:canonical_quotes|canonical_quote_approvals|canonical_quote_external_approval_evidence|canonical_quote_customer_decisions|canonical_quote_customer_parties|jobs|canonical_visits|canonical_pre_work_payment_receipts|business_contacts|business_customer_relationships)\b/i
  );

  assert.doesNotMatch(
    source,
    /\bDELETE\s+FROM\s+(?:canonical_quotes|canonical_quote_approvals|canonical_quote_external_approval_evidence|canonical_quote_customer_decisions|canonical_quote_customer_parties|jobs|canonical_visits|canonical_pre_work_payment_receipts|business_contacts|business_customer_relationships)\b/i
  );
});
