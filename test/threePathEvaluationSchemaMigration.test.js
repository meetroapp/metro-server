"use strict";

const assert =
  require("node:assert/strict");
const {
  readFileSync,
} = require("node:fs");
const test =
  require("node:test");

const sql = readFileSync(
  "migrations/202609160008_generalize_canonical_evaluation_job_sources.sql",
  "utf8"
);

test(
  "008 adds business_customer without removing existing aggregate origins",
  () => {
    for (const source of [
      "ordinary_request",
      "emergency_request",
      "business_document",
      "business_customer",
    ]) {
      assert.match(
        sql,
        new RegExp(`'${source}'`)
      );
    }

    assert.match(
      sql,
      /ADD COLUMN IF NOT EXISTS\s+business_customer_job_source_id UUID/i
    );

    assert.match(
      sql,
      /source_context_type = 'business_customer'[\s\S]*ordinary_request_id IS NULL[\s\S]*emergency_request_id IS NULL[\s\S]*relationship_id IS NULL[\s\S]*business_document_id IS NULL[\s\S]*contractor_profile_id IS NOT NULL[\s\S]*business_customer_job_source_id IS NOT NULL/i
    );
  }
);

test(
  "canonical Evaluation relationship becomes nullable only because authority is source-specific",
  () => {
    assert.match(
      sql,
      /ALTER TABLE canonical_evaluations[\s\S]*ALTER COLUMN relationship_id DROP NOT NULL/i
    );

    assert.match(
      sql,
      /canonical_evaluations_relationship_professional_nonnull_uidx/i
    );
  }
);

test(
  "Evaluation Job subject records exact Job source",
  () => {
    assert.match(
      sql,
      /job_source_type TEXT NOT NULL/i
    );

    assert.match(
      sql,
      /'ordinary_request_selection'[\s\S]*'existing_customer_request'[\s\S]*'business_customer'/i
    );

    assert.doesNotMatch(
      sql,
      /job_source_type IN \([\s\S]*'business_document'/i
    );
  }
);

test(
  "request-backed and business-customer subject shapes remain distinct",
  () => {
    assert.match(
      sql,
      /source_context_type = 'ordinary_request'[\s\S]*job_source_type IN \([\s\S]*'ordinary_request_selection'[\s\S]*'existing_customer_request'[\s\S]*job_request_id IS NOT NULL[\s\S]*relationship_id IS NOT NULL[\s\S]*business_customer_job_source_id IS NULL/i
    );

    assert.match(
      sql,
      /source_context_type = 'business_customer'[\s\S]*job_source_type = 'business_customer'[\s\S]*job_request_id IS NULL[\s\S]*relationship_id IS NULL[\s\S]*business_customer_job_source_id IS NOT NULL/i
    );
  }
);

test(
  "subject has generic and source-specific database proofs",
  () => {
    assert.match(
      sql,
      /canonical_evaluation_job_subject_evaluation_identity_fk/i
    );

    assert.match(
      sql,
      /canonical_evaluation_job_subject_aggregate_context_fk/i
    );

    assert.match(
      sql,
      /canonical_evaluation_job_subject_job_source_fk/i
    );

    assert.match(
      sql,
      /canonical_evaluation_job_subject_request_job_fk/i
    );

    assert.match(
      sql,
      /canonical_evaluation_job_subject_business_customer_job_fk/i
    );

    assert.match(
      sql,
      /assert_canonical_evaluation_job_subject_source/i
    );
  }
);

test(
  "business customer source is tied to business owner",
  () => {
    assert.match(
      sql,
      /FOREIGN KEY \([\s\S]*business_customer_job_source_id,[\s\S]*contractor_profile_id,[\s\S]*source_owner_user_id[\s\S]*REFERENCES business_customer_job_sources\([\s\S]*id,[\s\S]*contractor_profile_id,[\s\S]*created_by_user_id/i
    );
  }
);

test(
  "remote provenance becomes Job-source aware",
  () => {
    assert.match(
      sql,
      /source_context_type IN \([\s\S]*'ordinary_request'[\s\S]*'business_customer'/i
    );

    assert.match(
      sql,
      /subjects\.job_source_type =\s*'ordinary_request_selection'[\s\S]*participants\.source_evidence_type =\s*'request_selection'/i
    );

    assert.match(
      sql,
      /subjects\.job_source_type =\s*'existing_customer_request'[\s\S]*participants\.source_evidence_type =\s*'existing_customer_request'/i
    );

    assert.match(
      sql,
      /subjects\.job_source_type =\s*'business_customer'[\s\S]*participants\.request_relationship_id[\s\S]*IS NULL[\s\S]*participants\.source_evidence_type =\s*'business_customer'/i
    );
  }
);

test(
  "008 does not generalize physical external Visit authority or Quote",
  () => {
    assert.doesNotMatch(
      sql,
      /ALTER TABLE canonical_visits/i
    );

    assert.doesNotMatch(
      sql,
      /canonical_visit_external_confirmation_evidence/i
    );

    assert.doesNotMatch(
      sql,
      /ALTER TABLE canonical_quotes/i
    );

    assert.doesNotMatch(
      sql,
      /canonical_quote_customer_decisions/i
    );
  }
);

test(
  "008 creates no lifecycle business rows",
  () => {
    assert.doesNotMatch(
      sql,
      /INSERT\s+INTO\s+(?:canonical_evaluations|canonical_evaluation_job_subjects|canonical_evaluation_findings|canonical_visits|canonical_quotes|jobs|posts|request_relationships|request_selections)\b/i
    );
  }
);
