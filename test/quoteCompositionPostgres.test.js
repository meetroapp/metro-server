"use strict";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const { Pool } = require("pg");

const { assertSafeTestDatabaseUrl } = require("./helpers/databaseTargetSafety");
const { getMigrationFiles, runMigrationCollection } = require("../scripts/run-migrations");
const { createJobRequest } = require("../server/requests/jobRequestCreateService");
const { submitProfessionalResponse } = require("../server/relationships/professionalResponseService");
const { selectProfessionalResponse } = require("../server/relationships/requestSelectionService");
const { executeIntelligenceGateway } = require("../server/intelligence/intelligenceGateway");
const { recordQuoteCompositionFeedback } = require("../server/intelligence/quoteCompositionReviewService");

const databaseUrl = process.env.QUOTE_COMPOSITION_DATABASE_URL;
const migrationSql = readFileSync(
  join(__dirname, "..", "migrations", "202608100004_create_quote_composition_feedback.sql"),
  "utf8"
);

function targetMetadata(url) {
  return {
    target: "local-test",
    database: assertSafeTestDatabaseUrl(url, { nodeEnv: process.env.NODE_ENV }),
  };
}

function requestPayload() {
  return {
    title: "Synthetic advisory Quote fixture",
    description: "Drywall opening requires governed scope review.",
    category: "home_repair",
    request_category: "home_repair",
    service_domain: "home_services",
    service_specialty: "drywall",
    location: "Cape Coral, FL 33904",
    location_intake_mode: "address_after_selection",
    service_address_line1: null,
    service_city: "Cape Coral",
    service_region: "FL",
    service_postal_code: "33904",
    service_country_code: "US",
    unit_number: "",
    access_notes: "",
    request_photos: [],
  };
}

function emptyProviderResult() {
  return {
    schemaVersion: 1,
    summary: "Professional scope confirmation remains required.",
    scopeSections: [],
    proposedScopeItems: [],
    materials: [],
    exclusions: [],
    assumptions: [],
    separateProposals: [],
    commercialMissingInformation: [],
    workflowConditions: [],
    warnings: [],
    confidence: { score: 0.5, rationale: "No confirmed scope items were supplied." },
  };
}

test("disposable PostgreSQL certifies migration 33, proposal audit, feedback, and zero canonical mutation", { skip: !databaseUrl }, async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 6 });
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

    const rollbackClient = await pool.connect();
    try {
      await rollbackClient.query("BEGIN");
      await rollbackClient.query("CREATE SCHEMA quote_composition_rollback_probe");
      await rollbackClient.query("SET LOCAL search_path TO quote_composition_rollback_probe, public");
      await rollbackClient.query(migrationSql);
      await assert.rejects(
        rollbackClient.query("SELECT 1 / 0"),
        (error) => error?.code === "22012"
      );
      await rollbackClient.query("ROLLBACK");
    } finally {
      rollbackClient.release();
    }
    const rollbackProof = await pool.query(
      `SELECT
        to_regnamespace('quote_composition_rollback_probe') IS NULL AS schema_absent,
        to_regclass('quote_composition_rollback_probe.intelligence_quote_composition_feedback') IS NULL AS table_absent`
    );
    assert.deepEqual(rollbackProof.rows[0], { schema_absent: true, table_absent: true });

    const homeowner = await pool.query(
      `INSERT INTO users (username, email, password_hash, role, account_type)
       VALUES ('AI homeowner', $1, 'test-only-hash', 'homeowner', 'homeowner') RETURNING id`,
      [`ai-homeowner-${suffix}@example.test`]
    );
    const professional = await pool.query(
      `INSERT INTO users (username, email, password_hash, role, account_type)
       VALUES ('AI professional', $1, 'test-only-hash', 'drywall', 'professional') RETURNING id`,
      [`ai-professional-${suffix}@example.test`]
    );
    const homeownerId = Number(homeowner.rows[0].id);
    const professionalId = Number(professional.rows[0].id);
    await pool.query(
      `INSERT INTO contractor_profiles (user_id, business_name, category, location, profile_details)
       VALUES ($1, 'Synthetic Drywall', 'drywall', 'Cape Coral', $2::jsonb)`,
      [professionalId, JSON.stringify({ service_area: "Cape Coral", service_specialties: ["drywall"] })]
    );
    const created = await createJobRequest({
      pool,
      authenticatedActor: { id: homeownerId },
      payload: requestPayload(),
      idempotencyKey: randomUUID(),
      env: { JOB_LIFECYCLE_V2_ENABLED: "true", JOB_LIFECYCLE_V2_READINESS: "MC-JOB-LIFECYCLE-004B" },
    });
    assert.equal(created.ok, true, created.code);
    const professionalResponse = await submitProfessionalResponse({
      pool,
      authenticatedActor: { id: professionalId },
      postId: created.post.id,
      payload: { introduction_text: "Synthetic advisory response." },
      idempotencyKey: `ai-response-${suffix}`,
      professionalCanSeeRequest: () => true,
    });
    assert.equal(professionalResponse.ok, true, professionalResponse.code);
    const selection = await selectProfessionalResponse({
      pool,
      authenticatedActor: { id: homeownerId },
      postId: created.post.id,
      responseId: professionalResponse.response.id,
      payload: {},
      idempotencyKey: `ai-selection-${suffix}`,
    });
    assert.equal(selection.ok, true, selection.code);
    const job = await pool.query("SELECT id FROM jobs WHERE job_request_id = $1", [created.post.id]);

    const composed = await executeIntelligenceGateway({
      pool,
      authenticatedActor: { id: professionalId, role: "professional" },
      idempotencyKey: randomUUID(),
      body: {
        operation: "quote.compose",
        capability: "quote.compose",
        locale: "en-US",
        context: {},
        input: {
          jobId: job.rows[0].id,
          mode: "ADVISORY",
          professionalInstructions: "Prepare advisory scope only.",
          pricingInputs: [],
          materialInputs: [],
          terms: {},
        },
      },
      providers: { quote_composition: { async complete() { return emptyProviderResult(); } } },
    });
    assert.equal(composed.ok, true, composed.code);
    assert.equal(composed.result.authorityClassification, "ADVISORY_NON_CANONICAL");
    assert.equal(composed.result.commercialMissingInformation[0].id, "server_scope_confirmation_required");

    const feedbackKey = randomUUID();
    const feedbackInput = {
      pool,
      authenticatedActor: { id: professionalId, role: "professional" },
      proposalId: composed.result.proposalId,
      elementId: "server_scope_confirmation_required",
      action: "REJECTED",
      reasonCategory: "INSUFFICIENT_SCOPE",
      idempotencyKey: feedbackKey,
    };
    const reviewed = await recordQuoteCompositionFeedback(feedbackInput);
    assert.equal(reviewed.ok, true, reviewed.code);
    assert.equal(reviewed.canonicalMutationPerformed, false);
    const feedbackReplay = await recordQuoteCompositionFeedback(feedbackInput);
    assert.equal(feedbackReplay.code, "QUOTE_COMPOSITION_FEEDBACK_REPLAYED");

    await assert.rejects(
      pool.query(
        "UPDATE intelligence_quote_composition_feedback SET action = 'ACCEPTED' WHERE proposal_id = $1",
        [composed.result.proposalId]
      ),
      (error) => error?.code === "55000"
    );

    const preservation = await pool.query(
      `SELECT
        (SELECT count(*)::integer FROM schema_migrations) AS ledger,
        (SELECT count(*)::integer FROM intelligence_quote_composition_feedback) AS feedback,
        (SELECT count(*)::integer FROM canonical_quotes) AS quotes,
        (SELECT count(*)::integer FROM canonical_quote_issuances) AS issuances,
        (SELECT count(*)::integer FROM canonical_quote_customer_decisions) AS decisions`
    );
    assert.deepEqual(preservation.rows[0], {
      ledger: 44,
      feedback: 1,
      quotes: 0,
      issuances: 0,
      decisions: 0,
    });
  } finally {
    await pool.end();
  }
});
