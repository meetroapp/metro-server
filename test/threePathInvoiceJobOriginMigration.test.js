"use strict";

const assert =
  require("node:assert/strict");

const {
  readFileSync,
} = require("node:fs");

const test =
  require("node:test");


const source =
  readFileSync(
    "migrations/202609160015_generalize_invoice_job_origins.sql",
    "utf8"
  );


test(
  "015 recognizes all four canonical Invoice Job origins",
  () => {
    for (
      const value of [
        "ordinary_request_selection",
        "existing_customer_request",
        "business_document",
        "business_customer",
      ]
    ) {
      assert.match(
        source,
        new RegExp(value)
      );
    }

    assert.match(
      source,
      /CREATE OR REPLACE FUNCTION\s+assert_canonical_invoice_job_origin/i
    );
  }
);


test(
  "015 keeps both Meetro Invoice origins Request Relationship backed",
  () => {
    assert.match(
      source,
      /job\.source_type IN[\s\S]*'ordinary_request_selection'[\s\S]*'existing_customer_request'/i
    );

    assert.match(
      source,
      /NEW\.job_request_id[\s\S]*job\.job_request_id/i
    );

    assert.match(
      source,
      /NEW\.relationship_id[\s\S]*job\.source_request_relationship_id/i
    );

    assert.match(
      source,
      /existing_customer_request[\s\S]*source_request_selection_id IS NOT NULL/i
    );
  }
);


test(
  "015 keeps both business-owned Invoice origins Request-neutral and externally issuable",
  () => {
    assert.match(
      source,
      /jobs\.source_type[\s\S]*'business_document'/i
    );

    assert.match(
      source,
      /jobs\.source_type[\s\S]*'business_customer'/i
    );

    assert.match(
      source,
      /jobs\.originating_business_document_id[\s\S]*IS NOT NULL/i
    );

    assert.match(
      source,
      /jobs\.source_business_customer_job_id[\s\S]*IS NOT NULL/i
    );

    assert.match(
      source,
      /CREATE OR REPLACE FUNCTION\s+assert_external_invoice_issuance_origin/i
    );
  }
);


test(
  "015 binds Invoice Quote lines to source-aware common approval",
  () => {
    assert.match(
      source,
      /CREATE OR REPLACE FUNCTION\s+assert_business_invoice_line_approval/i
    );

    assert.match(
      source,
      /'ordinary_request_selection'[\s\S]*'existing_customer_request'[\s\S]*'MEETRO_CUSTOMER'/i
    );

    assert.match(
      source,
      /'business_document'[\s\S]*'business_customer'[\s\S]*'EXTERNAL_EVIDENCE'/i
    );

    assert.match(
      source,
      /approvals\.id[\s\S]*NEW\.source_quote_approval_id/i
    );

    assert.match(
      source,
      /approvals\.decision[\s\S]*'APPROVED'/i
    );
  }
);


test(
  "015 creates no Invoice, payment, Quote, Job, or customer business row",
  () => {
    assert.doesNotMatch(
      source,
      /\bINSERT\s+INTO\s+(?:canonical_invoices|canonical_invoice_versions|canonical_invoice_payments|canonical_quotes|canonical_quote_approvals|jobs|business_contacts|business_customer_relationships|canonical_invoice_customer_parties)\b/i
    );

    assert.doesNotMatch(
      source,
      /\bUPDATE\s+(?:canonical_invoices|canonical_invoice_versions|canonical_invoice_payments|canonical_quotes|canonical_quote_approvals|jobs|business_contacts|business_customer_relationships)\b/i
    );

    assert.doesNotMatch(
      source,
      /\bDELETE\s+FROM\s+(?:canonical_invoices|canonical_invoice_versions|canonical_invoice_payments|canonical_quotes|canonical_quote_approvals|jobs|business_contacts|business_customer_relationships)\b/i
    );
  }
);
