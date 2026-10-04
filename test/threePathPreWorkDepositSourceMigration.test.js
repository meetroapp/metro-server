"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const source = readFileSync(
  join(
    __dirname,
    "..",
    "migrations",
    "202609160012_generalize_pre_work_deposit_job_origins.sql"
  ),
  "utf8"
);

test("012 recognizes all four canonical Job sources", () => {
  for (const value of [
    "ordinary_request_selection",
    "existing_customer_request",
    "business_document",
    "business_customer",
  ]) {
    assert.match(
      source,
      new RegExp(value)
    );
  }
});

test("012 keeps both Meetro Job sources relationship-backed with MEETRO_CUSTOMER approval", () => {
  assert.match(
    source,
    /v_source_type IN[\s\S]*'ordinary_request_selection'[\s\S]*'existing_customer_request'/i
  );

  assert.match(
    source,
    /NEW\.approval_source[\s\S]*'MEETRO_CUSTOMER'/i
  );

  assert.match(
    source,
    /NEW\.job_request_id[\s\S]*v_job_request_id/i
  );

  assert.match(
    source,
    /NEW\.relationship_id[\s\S]*v_relationship_id/i
  );
});

test("012 keeps business_document relationship-neutral with external approval", () => {
  assert.match(
    source,
    /v_source_type = 'business_document'[\s\S]*NEW\.approval_source[\s\S]*'EXTERNAL_EVIDENCE'/i
  );

  assert.match(
    source,
    /v_source_type = 'business_document'[\s\S]*NEW\.job_request_id IS NOT NULL/i
  );

  assert.match(
    source,
    /v_source_type = 'business_document'[\s\S]*NEW\.relationship_id IS NOT NULL/i
  );

  assert.match(
    source,
    /v_originating_business_document_id IS NULL/i
  );
});

test("012 keeps business_customer relationship-neutral and requires exact external Job provenance", () => {
  assert.match(
    source,
    /v_source_type = 'business_customer'[\s\S]*NEW\.approval_source[\s\S]*'EXTERNAL_EVIDENCE'/i
  );

  assert.match(
    source,
    /v_source_type = 'business_customer'[\s\S]*NEW\.job_request_id IS NOT NULL/i
  );

  assert.match(
    source,
    /v_source_type = 'business_customer'[\s\S]*NEW\.relationship_id IS NOT NULL/i
  );

  assert.match(
    source,
    /v_business_contact_id IS NULL/i
  );

  assert.match(
    source,
    /v_business_customer_relationship_id IS NULL/i
  );

  assert.match(
    source,
    /v_business_customer_job_source_id IS NULL/i
  );
});

test("012 generalizes both deposit-obligation and payment-ledger origin guards", () => {
  assert.match(
    source,
    /CREATE OR REPLACE FUNCTION[\s\S]*assert_pre_work_deposit_obligation_job_origin/i
  );

  assert.match(
    source,
    /CREATE OR REPLACE FUNCTION[\s\S]*assert_pre_work_payment_relationship_job_origin/i
  );
});

test("012 preserves relationship-null ledger truth for both business-owned sources", () => {
  assert.match(
    source,
    /jobs\.source_type IN[\s\S]*'business_document'[\s\S]*'business_customer'[\s\S]*records\.relationship_id IS NOT NULL/i
  );
});

test("012 validates historical obligations, versions, receipts, allocations, and reversals", () => {
  for (const table of [
    "canonical_pre_work_deposit_obligations",
    "canonical_pre_work_deposit_versions",
    "canonical_pre_work_payment_receipts",
    "canonical_pre_work_payment_allocations",
    "canonical_pre_work_payment_allocation_reversals",
  ]) {
    assert.match(
      source,
      new RegExp(table)
    );
  }
});

test("012 does not alter Quote approval authority, payment arithmetic, or scheduling truth", () => {
  assert.doesNotMatch(
    source,
    /ALTER TABLE canonical_quote_approvals/i
  );

  assert.doesNotMatch(
    source,
    /ALTER TABLE canonical_quote_customer_decisions/i
  );

  assert.doesNotMatch(
    source,
    /\bINSERT INTO canonical_pre_work_deposit_obligations\b/i
  );

  assert.doesNotMatch(
    source,
    /\bINSERT INTO canonical_pre_work_payment_receipts\b/i
  );

  assert.doesNotMatch(
    source,
    /\bUPDATE canonical_pre_work_deposit_versions\b/i
  );

  assert.doesNotMatch(
    source,
    /\bcanonical_visits\b/i
  );
});
