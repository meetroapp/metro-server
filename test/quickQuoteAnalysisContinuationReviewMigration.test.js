"use strict";

const assert =
  require("node:assert/strict");

const fs =
  require("node:fs");

const path =
  require("node:path");

const test =
  require("node:test");

const {
  getMigrationFiles,
} = require(
  "../scripts/run-migrations"
);

const {
  recordWorkflowReview,
} = require(
  "../server/intelligence/workflowReviewService"
);

const migrationName =
  "202608190002_expand_ask_meetro_analysis_continuation_review.sql";

const migrationPath =
  path.join(
    __dirname,
    "..",
    "migrations",
    migrationName
  );

const sql =
  fs.readFileSync(
    migrationPath,
    "utf8"
  );

const readme =
  fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "migrations",
      "README.md"
    ),
    "utf8"
  );

const reviewServiceSource =
  fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "server",
      "intelligence",
      "workflowReviewService.js"
    ),
    "utf8"
  );

const PROPOSAL_ID =
  "11111111-1111-4111-8111-111111111111";

const REVIEW_ID =
  "22222222-2222-4222-8222-222222222222";

const IDEMPOTENCY_KEY =
  "33333333-3333-4333-8333-333333333333";

test(
  "migration 47 extends only the advisory workflow-review operation allowlist",
  () => {
    const migrations =
      getMigrationFiles();

    assert.equal(
      migrations.length,
      68
    );
    assert.equal(
      migrations.at(-1)?.filename,
      "202608300004_create_meetro_business_trial_authority.sql"
    );

    assert.equal(
      migrations.at(-22)?.filename,
      migrationName
    );

    assert.equal(
      migrations.at(-21)?.filename,
      "202608210001_create_business_document_working_drafts.sql"
    );

    assert.equal(
      migrations.at(-23)?.filename,
      "202608190001_create_quick_quote_analysis_session_foundation.sql"
    );

    assert.equal(
      migrations.at(-20)?.filename,
      "202608210002_create_business_document_delivery_foundation.sql"
    );

    assert.equal(
      migrations.at(-19)?.filename,
      "202608230001_add_business_document_numbers.sql"
    );

    assert.equal(
      migrations.at(-18)?.filename,
      "202608230002_add_canonical_quote_customer_terms_snapshot.sql"
    );

    assert.equal(
      migrations.at(-17)?.filename,
      "202608230003_create_canonical_quote_business_document_sources.sql"
    );

    assert.match(
      readme,
      /47\. `202608190002_expand_ask_meetro_analysis_continuation_review\.sql`/
    );

    assert.match(
      sql,
      /ALTER TABLE intelligence_workflow_review_events/i
    );

    assert.match(
      sql,
      /quick_quote\.analysis\.continue/i
    );

    assert.match(
      sql,
      /ACCEPTED\s*\/\s*EDITED\s*\/\s*REJECTED/i
    );

    assert.doesNotMatch(
      sql,
      /(?:^|\n)\s*(?:DROP TABLE|TRUNCATE|DELETE FROM|UPDATE)\b/im
    );

    assert.doesNotMatch(
      sql,
      /^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/im
    );
  }
);

test(
  "migration 47 and runtime review service preserve non-canonical authority",
  () => {
    assert.match(
      reviewServiceSource,
      /"quick_quote\.analysis\.continue"/
    );

    assert.doesNotMatch(
      sql,
      /INSERT INTO lifecycle_(?:capabilities|authority_grants)/i
    );

    assert.doesNotMatch(
      sql,
      /canonical_quotes|canonical_invoice_payments|portfolio_/i
    );

    assert.doesNotMatch(
      sql,
      /INSERT INTO (?:jobs|posts|canonical_quotes)/i
    );

    assert.match(
      sql,
      /creates no Quote, Job/i
    );
  }
);

test(
  "workflow review service records explicit professional review of continuation proposal items without canonical mutation",
  async () => {
    const operationRow = {
      id:
        PROPOSAL_ID,

      actor_user_id:
        41,

      operation:
        "quick_quote.analysis.continue",

      result_payload: {
        schemaVersion:
          1,

        proposalId:
          PROPOSAL_ID,

        analysisSessionId:
          "44444444-4444-4444-8444-444444444444",

        evidenceVersion:
          3,

        authorityClassification:
          "ADVISORY_NON_CANONICAL",

        repairSuggestions: [
          {
            id:
              "repair_verified",

            text:
              "Proceed only after concealed conditions are verified.",

            classification:
              "AI_SUGGESTED",

            sourceReferences:
              [],
          },
        ],

        learningContext: {
          context:
            "quick_quote_analysis_continuation",

          learnedPatternIsCanonicalRule:
            false,
        },

        canonicalMutationPerformed:
          false,
      },
    };

    const insertedRow = {
      id:
        REVIEW_ID,

      operation_id:
        PROPOSAL_ID,

      operation_type:
        "quick_quote.analysis.continue",

      actor_user_id:
        41,

      proposal_element_id:
        "repair_verified",

      action:
        "ACCEPTED",

      edited_value:
        null,

      reason_category:
        null,

      created_at:
        new Date(
          "2026-08-19T18:30:00.000Z"
        ),
    };

    const queries = [];

    const client = {
      async query(
        statement,
        params = []
      ) {
        const normalized =
          String(statement);

        queries.push(
          normalized
        );

        if (
          normalized ===
          "BEGIN" ||
          normalized ===
          "COMMIT" ||
          normalized ===
          "ROLLBACK"
        ) {
          return {
            rows: [],
          };
        }

        if (
          normalized.includes(
            "intelligence_workflow_review:proposal"
          )
        ) {
          assert.deepEqual(
            params,
            [
              PROPOSAL_ID,
              41,
            ]
          );

          return {
            rows: [
              operationRow,
            ],
          };
        }

        if (
          normalized.includes(
            "intelligence_workflow_review:insert"
          )
        ) {
          assert.equal(
            params[1],
            PROPOSAL_ID
          );

          assert.equal(
            params[2],
            "quick_quote.analysis.continue"
          );

          assert.equal(
            params[3],
            41
          );

          assert.equal(
            params[4],
            "repair_verified"
          );

          assert.equal(
            params[5],
            "ACCEPTED"
          );

          return {
            rows: [
              insertedRow,
            ],
          };
        }

        throw new Error(
          `Unexpected query: ${normalized}`
        );
      },

      release() {},
    };

    const pool = {
      async connect() {
        return client;
      },
    };

    const result =
      await recordWorkflowReview({
        pool,

        authenticatedActor: {
          id:
            41,
          role:
            "professional",
        },

        proposalId:
          PROPOSAL_ID,

        elementId:
          "repair_verified",

        action:
          "ACCEPTED",

        idempotencyKey:
          IDEMPOTENCY_KEY,
      });

    assert.equal(
      result.ok,
      true
    );

    assert.equal(
      result.status,
      201
    );

    assert.equal(
      result.review.operation,
      "quick_quote.analysis.continue"
    );

    assert.equal(
      result.review.proposalId,
      PROPOSAL_ID
    );

    assert.equal(
      result.review.elementId,
      "repair_verified"
    );

    assert.equal(
      result.review.action,
      "ACCEPTED"
    );

    assert.equal(
      result.review.learnedPatternIsCanonicalRule,
      false
    );

    assert.equal(
      result.canonicalMutationPerformed,
      false
    );

    assert.ok(
      queries.some(
        (query) =>
          query.includes(
            "intelligence_workflow_review:insert"
          )
      )
    );
  }
);
