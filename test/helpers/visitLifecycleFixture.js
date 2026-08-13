"use strict";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");

const { createJobRequest } = require("../../server/requests/jobRequestCreateService");
const {
  submitProfessionalResponse,
} = require("../../server/relationships/professionalResponseService");
const {
  selectProfessionalResponse,
} = require("../../server/relationships/requestSelectionService");
const {
  createOrdinaryJobEvaluation,
} = require("../../server/authorization/evaluationService");
const {
  addDraftScopeItem,
  approveIssuedQuote,
  createDraftQuote,
  issueQuote,
} = require("../../server/authorization/quoteDraftService");
const {
  createWorkstream,
} = require("../../server/workflow/workstreamService");

const quiet = { info() {}, warn() {} };

function requestPayload(description) {
  return {
    title: `Visit service ${description}`,
    description,
    category: "home_repair",
    request_category: "home_repair",
    service_domain: "home_services",
    service_specialty: "handyman",
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

function evaluationContent(description) {
  return {
    serviceType: "handyman",
    evaluationContext: "ordinary_job",
    observations: description,
    measurements: [],
    findings: [],
    diagnosisSummary: "",
    limitations: "",
    scopeRecommendations: [],
    relevantConditions: [],
    supportingMediaReferences: [],
    internalNotes: "",
  };
}

async function createVisitTestIdentities(pool, suffix) {
  const homeowner = await pool.query(
    `INSERT INTO users (username, email, password_hash, role, account_type)
     VALUES ('Visit Homeowner', $1, 'test-only-hash', 'homeowner', 'homeowner')
     RETURNING id`,
    [`visit-service-homeowner-${suffix}@example.test`]
  );
  const professional = await pool.query(
    `INSERT INTO users (username, email, password_hash, role, account_type)
     VALUES ('Visit Professional', $1, 'test-only-hash', 'handyman', 'professional')
     RETURNING id`,
    [`visit-service-professional-${suffix}@example.test`]
  );
  const outsider = await pool.query(
    `INSERT INTO users (username, email, password_hash, role, account_type)
     VALUES ('Visit Outsider', $1, 'test-only-hash', 'homeowner', 'homeowner')
     RETURNING id`,
    [`visit-service-outsider-${suffix}@example.test`]
  );
  await pool.query(
    `INSERT INTO contractor_profiles
      (user_id, business_name, category, location, profile_details)
     VALUES ($1, 'Visit Test Service', 'handyman', 'Cape Coral', $2::jsonb)`,
    [
      professional.rows[0].id,
      JSON.stringify({
        service_area: "Cape Coral",
        service_specialties: ["handyman"],
      }),
    ]
  );
  return {
    homeownerId: Number(homeowner.rows[0].id),
    professionalId: Number(professional.rows[0].id),
    outsiderId: Number(outsider.rows[0].id),
  };
}

async function createVisitLifecycleFixture(pool, identities, suffix) {
  const created = await createJobRequest({
    pool,
    authenticatedActor: { id: identities.homeownerId },
    payload: requestPayload(`fixture ${suffix}`),
    idempotencyKey: randomUUID(),
    env: {
      JOB_LIFECYCLE_V2_ENABLED: "true",
      JOB_LIFECYCLE_V2_READINESS: "MC-JOB-LIFECYCLE-004B",
    },
  });
  assert.equal(created.ok, true, created.code);

  const response = await submitProfessionalResponse({
    pool,
    authenticatedActor: { id: identities.professionalId },
    postId: created.post.id,
    payload: { introduction_text: "Synthetic Visit service response." },
    idempotencyKey: `visit-service-response-${suffix}`,
    professionalCanSeeRequest: () => true,
  });
  assert.equal(response.ok, true, response.code);

  const selection = await selectProfessionalResponse({
    pool,
    authenticatedActor: { id: identities.homeownerId },
    postId: created.post.id,
    responseId: response.response.id,
    payload: {},
    idempotencyKey: randomUUID(),
  });
  assert.equal(selection.ok, true, selection.code);

  const result = await pool.query(
    `SELECT jobs.id AS job_id,
       professional.id AS professional_participant_id,
       homeowner.id AS homeowner_participant_id
     FROM jobs
     INNER JOIN relationship_participants professional
       ON professional.job_id = jobs.id AND professional.user_id = $2
     INNER JOIN relationship_participants homeowner
       ON homeowner.job_id = jobs.id AND homeowner.user_id = $3
     WHERE jobs.job_request_id = $1`,
    [created.post.id, identities.professionalId, identities.homeownerId]
  );
  return {
    requestId: Number(created.post.id),
    jobId: result.rows[0].job_id,
    professionalParticipantId: result.rows[0].professional_participant_id,
    homeownerParticipantId: result.rows[0].homeowner_participant_id,
  };
}

async function createVisitEvaluation(pool, identities, fixture, suffix) {
  const result = await createOrdinaryJobEvaluation({
    pool,
    authenticatedActor: { id: identities.professionalId },
    jobId: fixture.jobId,
    content: evaluationContent(`Visit service evaluation ${suffix}`),
    expectedVersion: 0,
    idempotencyKey: `visit-service-evaluation-${suffix}`,
    logger: quiet,
  });
  assert.equal(result.ok, true, result.code);
  return result.evaluation;
}

async function createVisitWorkstream(
  pool,
  identities,
  fixture,
  suffix,
  sequence
) {
  const result = await createWorkstream({
    pool,
    authenticatedActor: { id: identities.professionalId },
    jobId: fixture.jobId,
    title: `Visit service workstream ${suffix} ${sequence}`,
    sequence,
    idempotencyKey: `visit-service-workstream-${suffix}-${sequence}`,
    logger: quiet,
  });
  assert.equal(result.ok, true, result.code);
  return result.workstream;
}

function quoteCommand(service, pool, actorId, values, idempotencyKey) {
  return service({
    pool,
    authenticatedActor: { id: actorId },
    idempotencyKey,
    logger: quiet,
    ...values,
  });
}

async function createVisitApprovedDecision(pool, identities, fixture, suffix) {
  const created = await quoteCommand(
    createDraftQuote,
    pool,
    identities.professionalId,
    { jobId: fixture.jobId, currency: "USD" },
    `visit-service-quote-create-${suffix}`
  );
  assert.equal(created.ok, true, created.code);
  const scoped = await quoteCommand(
    addDraftScopeItem,
    pool,
    identities.professionalId,
    {
      quoteId: created.quote.id,
      expectedVersion: created.quote.currentVersion,
      item: {
        classification: "LABOR_SERVICE",
        scopeSemantic: "FUTURE_WORK",
        materialResponsibility: "NOT_APPLICABLE",
        description: "Governed synthetic approved work",
        quantity: 1,
        unitAmountMinor: 10000,
        source: { type: "MANUAL_PROFESSIONAL" },
      },
    },
    `visit-service-quote-scope-${suffix}`
  );
  assert.equal(scoped.ok, true, scoped.code);
  const issued = await quoteCommand(
    issueQuote,
    pool,
    identities.professionalId,
    {
      quoteId: scoped.quote.id,
      expectedVersion: scoped.quote.currentVersion,
    },
    `visit-service-quote-issue-${suffix}`
  );
  assert.equal(issued.ok, true, issued.code);
  const approved = await quoteCommand(
    approveIssuedQuote,
    pool,
    identities.homeownerId,
    {
      quoteId: issued.quote.id,
      expectedIssuedVersion: issued.quote.currentVersion,
    },
    `visit-service-quote-approve-${suffix}`
  );
  assert.equal(approved.ok, true, approved.code);
  const decision = await pool.query(
    `SELECT id, quote_id, job_id, decision
     FROM canonical_quote_customer_decisions
     WHERE quote_id = $1`,
    [issued.quote.id]
  );
  return decision.rows[0];
}

async function grantVisitCapabilities(pool, fixture, grants) {
  for (const [role, capabilities] of Object.entries(grants)) {
    const participantId = role === "customer"
      ? fixture.homeownerParticipantId
      : fixture.professionalParticipantId;
    for (const capability of capabilities) {
      await pool.query(
        `INSERT INTO lifecycle_authority_grants (
          id, grantee_participant_id, grantor_participant_id, job_id,
          capability, scope_type, scope_job_id,
          source_evidence_type, source_evidence_reference, idempotency_key
         ) VALUES ($1, $2, $3, $4, $5, 'job', $4,
           'local_visit_service_test', $6, $7)`,
        [
          randomUUID(),
          participantId,
          fixture.homeownerParticipantId,
          fixture.jobId,
          capability,
          `visit-service-test:${role}:${capability}`,
          randomUUID(),
        ]
      );
    }
  }
}

module.exports = {
  createVisitApprovedDecision,
  createVisitEvaluation,
  createVisitLifecycleFixture,
  createVisitTestIdentities,
  createVisitWorkstream,
  grantVisitCapabilities,
  quiet,
};
