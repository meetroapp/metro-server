"use strict";

const { commercialAuthorityInternals } = require("./commercialAuthorityService");

const {
  databaseClient,
  failure,
  isPlainObject,
  normalizedUuid,
  rollback,
  validateAuthenticatedActor,
} = commercialAuthorityInternals;

function validateInput(input) {
  const allowed = new Set(["pool", "authenticatedActor", "jobId"]);
  if (!isPlainObject(input) || Object.keys(input).some((key) => !allowed.has(key))) {
    return { error: failure(400, "CUSTOMER_EFR_FIELD_REJECTED", "The customer project read is invalid.") };
  }
  const actor = validateAuthenticatedActor(input.authenticatedActor);
  if (actor.error) return { error: actor.error };
  const jobId = normalizedUuid(input.jobId);
  if (!jobId) {
    return { error: failure(400, "INVALID_CUSTOMER_EFR_JOB_ID", "A valid Job ID is required.") };
  }
  if (!input.pool || typeof input.pool.query !== "function") {
    throw new TypeError("A database pool or client is required.");
  }
  return { actorId: actor.id, jobId };
}

async function runRead(pool, action) {
  const client = await databaseClient(pool);
  let started = false;
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    started = true;
    const result = await action(client);
    await client.query("COMMIT");
    started = false;
    return result;
  } catch (error) {
    if (started) await rollback(client);
    throw error;
  } finally {
    if (client !== pool && typeof client.release === "function") client.release();
  }
}

async function loadCustomerContext(client, { actorId, jobId }) {
  const result = await client.query(
    `SELECT
      jobs.id AS job_id,
      jobs.job_request_id,
      jobs.source_request_relationship_id AS relationship_id,
      relationships.status AS relationship_status,
      participants.id AS actor_participant_id,
      EXISTS (
        SELECT 1
        FROM participant_role_assignments roles
        LEFT JOIN participant_role_revocations revocations
          ON revocations.role_assignment_id = roles.id
        WHERE roles.participant_id = participants.id
          AND roles.job_id = jobs.id
          AND roles.role = 'CUSTOMER_REPRESENTATIVE'
          AND roles.valid_from <= CURRENT_TIMESTAMP
          AND (roles.valid_until IS NULL OR roles.valid_until > CURRENT_TIMESTAMP)
          AND revocations.id IS NULL
      ) AS actor_is_customer_representative,
      EXISTS (
        SELECT 1
        FROM lifecycle_authority_grants grants
        LEFT JOIN lifecycle_authority_grant_revocations revocations
          ON revocations.authority_grant_id = grants.id
        WHERE grants.grantee_participant_id = participants.id
          AND grants.capability = 'participant.read'
          AND grants.job_id = jobs.id
          AND grants.scope_type = 'job'
          AND grants.scope_job_id = jobs.id
          AND grants.scope_concern_id IS NULL
          AND grants.valid_from <= CURRENT_TIMESTAMP
          AND (grants.valid_until IS NULL OR grants.valid_until > CURRENT_TIMESTAMP)
          AND revocations.id IS NULL
      ) AS can_read_job_participants
    FROM jobs
    INNER JOIN posts ON posts.id = jobs.job_request_id
      AND posts.lifecycle_contract_version = 2
      AND posts.user_id = $2
    INNER JOIN request_relationships relationships
      ON relationships.id = jobs.source_request_relationship_id
      AND relationships.post_id = jobs.job_request_id
      AND relationships.emergency_request_id IS NULL
      AND relationships.homeowner_id = $2
    LEFT JOIN relationship_participants participants
      ON participants.job_id = jobs.id
      AND participants.request_relationship_id = relationships.id
      AND participants.user_id = $2
    WHERE jobs.id = $1
    LIMIT 1`,
    [jobId, actorId]
  );
  return result.rows[0] || null;
}

function unavailable(context) {
  return Boolean(
    !context ||
    context.relationship_status !== "active" ||
    !context.actor_participant_id ||
    context.actor_is_customer_representative !== true ||
    context.can_read_job_participants !== true
  );
}

function findingState(value) {
  return value === "RESOLVED" ? "RESOLVED" : "NEEDS_ATTENTION";
}

function recommendationState(value) {
  if (value === "DEFERRED") return "DEFERRED";
  if (["WITHDRAWN", "SUPERSEDED", "DECLINED"].includes(value)) {
    return "NOT_PROCEEDING";
  }
  return "RECOMMENDED";
}

async function loadProjection(client, context) {
  const evaluationResult = await client.query(
    `SELECT evaluations.id, evaluations.status, evaluations.completed_at,
      evaluations.created_at, evaluations.updated_at
    FROM canonical_evaluation_job_subjects subjects
    INNER JOIN canonical_evaluations evaluations
      ON evaluations.id = subjects.evaluation_id
    WHERE subjects.job_id = $1
      AND subjects.job_request_id = $2
      AND subjects.relationship_id = $3
    ORDER BY evaluations.updated_at DESC, evaluations.id ASC
    LIMIT 1`,
    [context.job_id, Number(context.job_request_id), Number(context.relationship_id)]
  );
  const evaluation = evaluationResult.rows[0] || null;
  if (!evaluation) {
    return {
      jobId: context.job_id,
      requestId: Number(context.job_request_id),
      relationshipId: Number(context.relationship_id),
      evaluation: null,
      findings: [],
      recommendations: [],
    };
  }

  const findingsResult = await client.query(
    `SELECT findings.id, current.statement, current.resolution_state,
      findings.created_at, current.created_at AS updated_at
    FROM canonical_evaluation_findings findings
    INNER JOIN LATERAL (
      SELECT statement, confirmation_state, resolution_state,
        customer_visible, created_at
      FROM canonical_evaluation_finding_versions versions
      WHERE versions.finding_id = findings.id
        AND versions.job_id = findings.job_id
      ORDER BY versions.version DESC
      LIMIT 1
    ) current ON TRUE
    WHERE findings.evaluation_id = $1
      AND findings.job_id = $2
      AND current.confirmation_state = 'CONFIRMED'
      AND current.customer_visible = TRUE
    ORDER BY findings.created_at ASC, findings.id ASC`,
    [evaluation.id, context.job_id]
  );
  const findingIds = findingsResult.rows.map((row) => row.id);
  const recommendationsResult = findingIds.length === 0
    ? { rows: [] }
    : await client.query(
      `SELECT recommendations.id, recommendations.finding_id,
        current.statement, current.status, recommendations.created_at,
        current.created_at AS updated_at
      FROM canonical_recommendations recommendations
      INNER JOIN LATERAL (
        SELECT statement, status, customer_visible, created_at
        FROM canonical_recommendation_versions versions
        WHERE versions.recommendation_id = recommendations.id
        ORDER BY versions.version DESC
        LIMIT 1
      ) current ON TRUE
      WHERE recommendations.job_id = $1
        AND recommendations.finding_id = ANY($2::uuid[])
        AND current.customer_visible = TRUE
      ORDER BY recommendations.created_at ASC, recommendations.id ASC`,
      [context.job_id, findingIds]
    );

  return {
    jobId: context.job_id,
    requestId: Number(context.job_request_id),
    relationshipId: Number(context.relationship_id),
    evaluation: {
      status: evaluation.status === "completed" ? "COMPLETE" : "IN_PROGRESS",
      completedAt: evaluation.completed_at,
      startedAt: evaluation.created_at,
      updatedAt: evaluation.updated_at,
    },
    findings: findingsResult.rows.map((row) => ({
      id: row.id,
      statement: row.statement,
      state: findingState(row.resolution_state),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
    recommendations: recommendationsResult.rows.map((row) => ({
      id: row.id,
      findingId: row.finding_id,
      statement: row.statement,
      state: recommendationState(row.status),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
  };
}

async function getCustomerEfr(input = {}) {
  const validated = validateInput(input);
  if (validated.error) return validated.error;
  return runRead(input.pool, async (client) => {
    const context = await loadCustomerContext(client, validated);
    if (unavailable(context)) {
      return failure(404, "CUSTOMER_EFR_UNAVAILABLE", "Project assessment details are unavailable.");
    }
    return {
      ok: true,
      success: true,
      status: 200,
      code: "CUSTOMER_EFR_FOUND",
      projectAssessment: await loadProjection(client, context),
    };
  });
}

module.exports = { getCustomerEfr };
