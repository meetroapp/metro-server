"use strict";

const assert = require("node:assert/strict");
const {
  readFileSync,
} = require("node:fs");
const test = require("node:test");

const source = readFileSync(
  "migrations/202609160014_generalize_external_visit_confirmation_sources.sql",
  "utf8"
);

test(
  "014 makes Approved Work external Visit customer identity source-aware",
  () => {
    assert.match(
      source,
      /ALTER TABLE canonical_visit_external_confirmation_evidence[\s\S]*ALTER COLUMN customer_snapshot_hash[\s\S]*DROP NOT NULL/i
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
      /canonical_visit_external_confirmation_customer_identity_shape_check/i
    );

    assert.match(
      source,
      /customer_snapshot_hash IS NOT NULL[\s\S]*business_contact_id IS NULL[\s\S]*business_customer_relationship_id IS NULL/i
    );

    assert.match(
      source,
      /customer_snapshot_hash IS NULL[\s\S]*business_contact_id IS NOT NULL[\s\S]*business_customer_relationship_id IS NOT NULL/i
    );
  }
);

test(
  "014 binds business_customer Visit evidence to exact immutable Quote customer party",
  () => {
    assert.match(
      source,
      /canonical_visit_external_confirmation_customer_party_fk/i
    );

    assert.match(
      source,
      /FOREIGN KEY[\s\S]*quote_id[\s\S]*job_id[\s\S]*contractor_profile_id[\s\S]*business_contact_id[\s\S]*business_customer_relationship_id[\s\S]*REFERENCES canonical_quote_customer_parties/i
    );
  }
);

test(
  "014 preserves Quick Quote snapshots and adds full business_customer identity",
  () => {
    assert.match(
      source,
      /assert_external_visit_confirmation_identity/i
    );

    assert.match(
      source,
      /jobs\.source_type[\s\S]*'business_document'/i
    );

    assert.match(
      source,
      /canonical_quote_customer_snapshots/i
    );

    assert.match(
      source,
      /jobs\.source_type[\s\S]*'business_customer'/i
    );

    assert.match(
      source,
      /canonical_quote_customer_parties/i
    );

    assert.match(
      source,
      /business_customer_job_sources/i
    );

    assert.match(
      source,
      /canonical_quote_external_approval_evidence/i
    );
  }
);

test(
  "014 preserves exact Visit schedule and professional authority proof",
  () => {
    for (const value of [
      "PROPOSED",
      "SCHEDULED",
      "PRIMARY_PROFESSIONAL",
      "APPROVED_WORK",
      "EXTERNAL_EVIDENCE",
    ]) {
      assert.match(
        source,
        new RegExp(value)
      );
    }

    assert.match(
      source,
      /scheduled\.command_idempotency_id[\s\S]*NEW\.command_idempotency_id/i
    );

    assert.match(
      source,
      /proposed\.scheduled_start_at[\s\S]*NEW\.scheduled_start_at/i
    );

    assert.match(
      source,
      /quote_evidence\.customer_snapshot_hash[\s\S]*IS NOT DISTINCT FROM[\s\S]*NEW\.customer_snapshot_hash/i
    );

    assert.match(
      source,
      /quote_evidence\.business_contact_id[\s\S]*IS NOT DISTINCT FROM[\s\S]*NEW\.business_contact_id/i
    );
  }
);

test(
  "014 does not fabricate business rows or alter Quick Quote snapshot provenance",
  () => {
    assert.doesNotMatch(
      source,
      /\bINSERT\s+INTO\s+(?:canonical_visit_external_confirmation_evidence|canonical_quote_customer_snapshots|canonical_quote_customer_parties|canonical_quotes|canonical_quote_approvals|jobs|business_contacts|business_customer_relationships)\b/i
    );

    assert.doesNotMatch(
      source,
      /\bUPDATE\s+(?:canonical_visit_external_confirmation_evidence|canonical_quote_customer_snapshots|canonical_quote_customer_parties|canonical_quotes|canonical_quote_approvals|jobs|business_contacts|business_customer_relationships)\b/i
    );

    assert.doesNotMatch(
      source,
      /\bDELETE\s+FROM\s+(?:canonical_visit_external_confirmation_evidence|canonical_quote_customer_snapshots|canonical_quote_customer_parties|canonical_quotes|canonical_quote_approvals|jobs|business_contacts|business_customer_relationships)\b/i
    );

    assert.doesNotMatch(
      source,
      /ALTER TABLE canonical_quote_customer_snapshots/i
    );

    assert.doesNotMatch(
      source,
      /CREATE OR REPLACE FUNCTION\s+require_external_visit_schedule_evidence/i
    );
  }
);
