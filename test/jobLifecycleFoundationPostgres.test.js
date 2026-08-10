"use strict";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const test = require("node:test");
const { Pool } = require("pg");

const {
  assertSafeTestDatabaseUrl,
} = require("./helpers/databaseTargetSafety");
const {
  createJobRequest,
} = require("../server/requests/jobRequestCreateService");
const {
  professionalCanSeeRequest,
} = require("../server/requests/requestLifecycle");
const {
  submitProfessionalResponse,
} = require("../server/relationships/professionalResponseService");
const {
  selectProfessionalResponse,
} = require("../server/relationships/requestSelectionService");
const {
  appendConcernClarification,
  listRequestLifecycle,
} = require("../server/requests/reportedConcernService");

const databaseUrl = process.env.JOB_LIFECYCLE_DATABASE_URL;

function payload() {
  return {
    title: "Dishwasher service",
    description: "dishwasher issue",
    category: "appliance_repair",
    request_category: "appliance_repair",
    service_domain: "home_services",
    service_specialty: "appliance_repair",
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

test(
  "disposable PostgreSQL certifies Slice 001 end to end",
  { skip: !databaseUrl },
  async () => {
    assertSafeTestDatabaseUrl(databaseUrl, { nodeEnv: process.env.NODE_ENV });
    const pool = new Pool({ connectionString: databaseUrl, max: 4 });
    const suffix = randomUUID();
    const logger = { info() {}, warn() {} };

    try {
      const homeownerResult = await pool.query(
        `
        INSERT INTO users (username, email, password_hash, role, account_type)
        VALUES ($1, $2, 'test-only-hash', 'homeowner', 'homeowner')
        RETURNING id
        `,
        ["Lifecycle Homeowner", `lifecycle-homeowner-${suffix}@example.test`]
      );
      const professionalResult = await pool.query(
        `
        INSERT INTO users (username, email, password_hash, role, account_type)
        VALUES ($1, $2, 'test-only-hash', 'appliance_repair', 'professional')
        RETURNING id
        `,
        ["Lifecycle Professional", `lifecycle-professional-${suffix}@example.test`]
      );
      const homeownerId = homeownerResult.rows[0].id;
      const professionalId = professionalResult.rows[0].id;

      await pool.query(
        `
        INSERT INTO contractor_profiles
        (user_id, business_name, category, location, profile_details)
        VALUES ($1, 'Lifecycle Appliance Service', 'appliance_repair',
          'Cape Coral', $2::jsonb)
        `,
        [
          professionalId,
          JSON.stringify({
            service_area: "Cape Coral",
            service_specialties: ["appliance_repair"],
          }),
        ]
      );

      const legacy = await pool.query(
        `
        INSERT INTO posts (user_id, title, description, category, location)
        VALUES ($1, 'Legacy request', 'Legacy detail', 'handyman', 'Legacy area')
        RETURNING id, lifecycle_contract_version
        `,
        [homeownerId]
      );
      assert.equal(Number(legacy.rows[0].lifecycle_contract_version), 1);

      const createKey = randomUUID();
      const created = await createJobRequest({
        pool,
        authenticatedActor: { id: homeownerId },
        payload: payload(),
        idempotencyKey: createKey,
        env: {
          JOB_LIFECYCLE_V2_ENABLED: "true",
          JOB_LIFECYCLE_V2_READINESS: "MC-JOB-LIFECYCLE-004B",
        },
      });
      assert.equal(created.ok, true);
      assert.equal(created.post.lifecycle_contract_version, 2);
      assert.equal(created.reportedConcern.originalText, "dishwasher issue");

      const replay = await createJobRequest({
        pool,
        authenticatedActor: { id: homeownerId },
        payload: payload(),
        idempotencyKey: createKey,
        env: {
          JOB_LIFECYCLE_V2_ENABLED: "true",
          JOB_LIFECYCLE_V2_READINESS: "MC-JOB-LIFECYCLE-004B",
        },
      });
      assert.equal(replay.code, "JOB_REQUEST_REPLAYED");

      const response = await submitProfessionalResponse({
        pool,
        authenticatedActor: { id: professionalId },
        postId: created.post.id,
        payload: { introduction_text: "I can inspect this appliance issue." },
        idempotencyKey: `professional-response:${suffix}`,
        professionalCanSeeRequest: () => true,
      });
      assert.equal(response.ok, true);

      const selection = await selectProfessionalResponse({
        pool,
        authenticatedActor: { id: homeownerId },
        postId: created.post.id,
        responseId: response.response.id,
        payload: {},
        idempotencyKey: `request-selection:${suffix}`,
        lifecycleJobBootstrap: async (input) => {
          const { bootstrapLifecycleJob } = require("../server/workflow/jobFoundationService");
          return bootstrapLifecycleJob({ ...input, logger });
        },
      });
      assert.equal(selection.ok, true);
      assert.ok(selection.lifecycleJob?.id);

      const ownerLifecycle = await listRequestLifecycle({
        pool,
        authenticatedActor: { id: homeownerId },
        postId: created.post.id,
      });
      const professionalLifecycle = await listRequestLifecycle({
        pool,
        authenticatedActor: { id: professionalId },
        postId: created.post.id,
      });
      assert.equal(ownerLifecycle.lifecycle.reportedConcerns[0].originalText, "dishwasher issue");
      assert.equal(ownerLifecycle.lifecycle.participants.length, 2);
      assert.equal(professionalLifecycle.ok, true);

      await pool.query(
        "UPDATE posts SET description = $1 WHERE id = $2",
        ["Current understanding: disposal and drainage fault", created.post.id]
      );
      const originalAfterEdit = await pool.query(
        "SELECT original_text FROM reported_concerns WHERE id = $1",
        [created.reportedConcern.id]
      );
      assert.equal(originalAfterEdit.rows[0].original_text, "dishwasher issue");

      const clarificationKey = `concern-clarification:${suffix}`;
      const clarification = await appendConcernClarification({
        pool,
        authenticatedActor: { id: homeownerId },
        postId: created.post.id,
        concernId: created.reportedConcern.id,
        payload: {
          semantics: "CORRECTS_INTERPRETATION",
          text: "Current understanding: disposal and drainage fault.",
        },
        idempotencyKey: clarificationKey,
        logger,
      });
      const clarificationReplay = await appendConcernClarification({
        pool,
        authenticatedActor: { id: homeownerId },
        postId: created.post.id,
        concernId: created.reportedConcern.id,
        payload: {
          semantics: "CORRECTS_INTERPRETATION",
          text: "Current understanding: disposal and drainage fault.",
        },
        idempotencyKey: clarificationKey,
        logger,
      });
      assert.equal(clarification.status, 201);
      assert.equal(clarificationReplay.code, "CONCERN_CLARIFICATION_REPLAYED");

      await assert.rejects(
        pool.query(
          "UPDATE reported_concerns SET original_text = 'rewritten' WHERE id = $1",
          [created.reportedConcern.id]
        ),
        (error) => error.code === "55000"
      );
      await assert.rejects(
        pool.query(
          "DELETE FROM reported_concerns WHERE id = $1",
          [created.reportedConcern.id]
        ),
        (error) => error.code === "55000"
      );

      const counts = await pool.query(
        `
        SELECT
          (SELECT count(*) FROM jobs WHERE job_request_id = $1)::integer AS jobs,
          (SELECT count(*) FROM reported_concerns WHERE job_request_id = $1)::integer AS concerns,
          (SELECT count(*) FROM relationship_participants WHERE job_id = $2)::integer AS participants,
          (SELECT count(*) FROM participant_role_assignments WHERE job_id = $2)::integer AS roles,
          (SELECT count(*) FROM lifecycle_authority_grants WHERE job_id = $2)::integer AS grants,
          (SELECT count(*) FROM lifecycle_authority_grants
            WHERE job_id = $2 AND capability LIKE 'quote.%')::integer AS quote_grants
        `,
        [created.post.id, selection.lifecycleJob.id]
      );
      assert.deepEqual(counts.rows[0], {
        jobs: 1,
        concerns: 1,
        participants: 2,
        roles: 2,
        grants: 9,
        quote_grants: 0,
      });
    } finally {
      await pool.end();
    }
  }
);
