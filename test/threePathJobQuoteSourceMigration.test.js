"use strict";

const assert =
  require("node:assert/strict");

const {
  readFileSync,
  readdirSync,
} = require("node:fs");

const test =
  require("node:test");


const file =
  "migrations/202609160010_generalize_canonical_job_quote_sources.sql";

const sql =
  readFileSync(
    file,
    "utf8"
  );


test(
  "migration 010 follows the frozen 009 external Evaluation Visit schema",
  () => {
    const files =
      readdirSync("migrations")
        .filter(
          (name) =>
            /^2026091600(0[1-9]|10)_/.test(
              name
            )
        )
        .sort();

    const nine =
      files.indexOf(
        "202609160009_create_business_customer_evaluation_visit_confirmation.sql"
      );

    const ten =
      files.indexOf(
        "202609160010_generalize_canonical_job_quote_sources.sql"
      );

    assert.equal(
      ten,
      nine + 1
    );
  }
);


test(
  "business customer Job Quote gets exact source identity",
  () => {
    assert.match(
      sql,
      /ALTER TABLE canonical_quotes[\s\S]*business_customer_job_source_id UUID/i
    );

    assert.match(
      sql,
      /source_context_type =[\s\S]*'business_customer'[\s\S]*job_source_type =[\s\S]*'business_customer'/i
    );

    assert.match(
      sql,
      /business_customer_job_source_id[\s\S]*IS NOT NULL/i
    );
  }
);


test(
  "repeat Meetro Job Quote remains ordinary Request backed",
  () => {
    assert.match(
      sql,
      /source_context_type =[\s\S]*'ordinary_request'[\s\S]*job_source_type IN[\s\S]*'ordinary_request_selection'[\s\S]*'existing_customer_request'/i
    );

    assert.match(
      sql,
      /job_request_id[\s\S]*IS NOT NULL[\s\S]*relationship_id[\s\S]*IS NOT NULL/i
    );
  }
);


test(
  "external Job Quote proves exact Job source",
  () => {
    assert.match(
      sql,
      /canonical_quote_business_customer_job_source_fkey/i
    );

    assert.match(
      sql,
      /FOREIGN KEY[\s\S]*job_id[\s\S]*job_source_type[\s\S]*business_customer_job_source_id[\s\S]*REFERENCES jobs[\s\S]*source_business_customer_job_id/i
    );
  }
);


test(
  "external Job Quote proves exact aggregate source",
  () => {
    assert.match(
      sql,
      /canonical_quote_business_customer_aggregate_source_fkey/i
    );

    assert.match(
      sql,
      /FOREIGN KEY[\s\S]*id[\s\S]*source_context_type[\s\S]*business_customer_job_source_id[\s\S]*REFERENCES commercial_authority_aggregates/i
    );
  }
);


test(
  "business customer Quote source identity is immutable",
  () => {
    assert.match(
      sql,
      /prevent_canonical_quote_business_customer_source_mutation/i
    );

    assert.match(
      sql,
      /NEW\.business_customer_job_source_id[\s\S]*IS DISTINCT FROM[\s\S]*OLD\.business_customer_job_source_id/i
    );
  }
);


test(
  "Quick Quote business_document source remains a separate compatibility path",
  () => {
    assert.match(
      sql,
      /source_context_type =[\s\S]*'business_document'[\s\S]*job_source_type =[\s\S]*'business_document'[\s\S]*job_request_id[\s\S]*IS NULL[\s\S]*relationship_id[\s\S]*IS NULL[\s\S]*business_customer_job_source_id[\s\S]*IS NULL/i
    );
  }
);


test(
  "migration does not change Quick Quote approval or document behavior",
  () => {
    assert.doesNotMatch(
      sql,
      /canonical_quote_external_approval_evidence/
    );

    assert.doesNotMatch(
      sql,
      /assert_external_quote_approval_business_origin/
    );

    assert.doesNotMatch(
      sql,
      /business_document_working_drafts/
    );

    assert.doesNotMatch(
      sql,
      /quote\.external\.approve/
    );
  }
);


test(
  "migration creates no lifecycle business rows",
  () => {
    assert.doesNotMatch(
      sql,
      /INSERT INTO\s+(?:canonical_quotes|canonical_evaluations|jobs|canonical_quote_approvals|canonical_quote_customer_decisions|canonical_quote_external_approval_evidence)\b/i
    );

    assert.doesNotMatch(
      sql,
      /\bUPDATE\s+(?:canonical_quotes|canonical_evaluations|jobs|canonical_quote_approvals|business_document_working_drafts)\b/i
    );

    assert.doesNotMatch(
      sql,
      /\bDELETE FROM\s+(?:canonical_quotes|canonical_evaluations|jobs)\b/i
    );
  }
);
