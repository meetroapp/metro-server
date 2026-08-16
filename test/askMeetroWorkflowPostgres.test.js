"use strict";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const test = require("node:test");
const { Pool } = require("pg");

const { assertSafeTestDatabaseUrl } = require("./helpers/databaseTargetSafety");
const { getMigrationFiles, runMigrationCollection } = require("../scripts/run-migrations");
const { recordWorkflowReview } = require("../server/intelligence/workflowReviewService");

const databaseUrl = process.env.ASK_MEETRO_WORKFLOW_DATABASE_URL;

function targetMetadata(url) {
  return {
    target: "local-test",
    database: assertSafeTestDatabaseUrl(url, { nodeEnv: process.env.NODE_ENV }),
  };
}

test("disposable PostgreSQL certifies migration 44 review evidence and zero canonical mutation", { skip: !databaseUrl }, async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  const suffix = randomUUID();
  try {
    const migrations = getMigrationFiles();
    assert.equal(migrations.length, 44);
    const applied = await runMigrationCollection(pool, migrations, targetMetadata(databaseUrl));
    assert.equal(applied.success, true);
    assert.equal(applied.applied.length, 44);
    const replay = await runMigrationCollection(pool, migrations, targetMetadata(databaseUrl));
    assert.equal(replay.success, true);
    assert.equal(replay.skipped.length, 44);

    const user = await pool.query(
      `INSERT INTO users (username, email, password_hash, role, account_type)
       VALUES ('Ask Meetro professional', $1, 'test-only-hash', 'professional', 'professional') RETURNING id`,
      [`ask-meetro-${suffix}@example.test`]
    );
    const actorId = Number(user.rows[0].id);
    const proposalId = randomUUID();
    await pool.query(
      `INSERT INTO intelligence_operation_idempotency (
         id, actor_user_id, authority_scope, operation, idempotency_key,
         request_fingerprint, status, provider_execution_state,
         result_classification, result_payload, usage_state, usage_classification,
         correlation_id, started_at, completed_at
       ) VALUES (
         $1, $2, $3, 'invoice.assist', $4, $5,
         'completed', 'succeeded', 'proposal', $6::jsonb,
         'not_configured', 'stub', $7, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
       )`,
      [
        proposalId,
        actorId,
        `user:${actorId}`,
        randomUUID(),
        "a".repeat(64),
        JSON.stringify({
          schemaVersion: 1,
          proposalId,
          jobId: randomUUID(),
          invoiceId: null,
          customerNotes: { id: "customer_notes", text: "Thank you for your business." },
          humanToCanonicalBoundary: { directMutationAllowed: false },
          learningContext: { learnedPatternIsCanonicalRule: false },
        }),
        randomUUID(),
      ]
    );
    const key = randomUUID();
    const input = {
      pool,
      authenticatedActor: { id: actorId, role: "professional" },
      proposalId,
      elementId: "customer_notes",
      action: "ACCEPTED",
      idempotencyKey: key,
    };
    const accepted = await recordWorkflowReview(input);
    assert.equal(accepted.code, "INTELLIGENCE_REVIEW_RECORDED");
    assert.equal(accepted.canonicalMutationPerformed, false);
    assert.equal(accepted.review.learnedPatternIsCanonicalRule, false);
    assert.equal((await recordWorkflowReview(input)).code, "INTELLIGENCE_REVIEW_REPLAYED");
    const conflict = await recordWorkflowReview({ ...input, action: "REJECTED" });
    assert.equal(conflict.code, "INTELLIGENCE_REVIEW_CONFLICT");

    await assert.rejects(
      pool.query("UPDATE intelligence_workflow_review_events SET action = 'REJECTED' WHERE operation_id = $1", [proposalId]),
      (error) => error?.code === "55000"
    );
    await assert.rejects(
      pool.query("DELETE FROM intelligence_workflow_review_events WHERE operation_id = $1", [proposalId]),
      (error) => error?.code === "55000"
    );

    const preservation = await pool.query(
      `SELECT
        (SELECT count(*)::integer FROM schema_migrations) AS ledger,
        (SELECT count(*)::integer FROM intelligence_workflow_review_events) AS reviews,
        (SELECT count(*)::integer FROM canonical_quotes) AS quotes,
        (SELECT count(*)::integer FROM canonical_invoices) AS invoices,
        (SELECT count(*)::integer FROM canonical_invoice_payments) AS payments`
    );
    assert.deepEqual(preservation.rows[0], {
      ledger: 44,
      reviews: 1,
      quotes: 0,
      invoices: 0,
      payments: 0,
    });
  } finally {
    await pool.end();
  }
});
