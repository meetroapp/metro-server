"use strict";

const {
  commercialAuthorityInternals,
} = require("../authorization/commercialAuthorityService");

const {
  databaseClient,
  failure,
  isPlainObject,
  rollback,
  validateAuthenticatedActor,
} = commercialAuthorityInternals;

const REQUIRED_CAPABILITIES = Object.freeze([
  "participant.read",
  "quote.create",
  "quote.read",
  "quote.scope.manage",
]);

const AUTHORIZED_JOBS_SQL = `
  /* professional_job_picker:list */
  SELECT DISTINCT
    jobs.id AS job_id,
    posts.title,
    posts.service_domain,
    posts.service_specialty,
    posts.service_city,
    posts.discovery_area_label,
    customers.username AS customer_name,
    jobs.source_type,
    jobs.created_at
  FROM jobs
  INNER JOIN posts
    ON posts.id = jobs.job_request_id
    AND posts.lifecycle_contract_version = 2
    AND posts.cancelled_at IS NULL
  INNER JOIN request_relationships relationships
    ON relationships.id = jobs.source_request_relationship_id
    AND relationships.post_id = jobs.job_request_id
    AND relationships.emergency_request_id IS NULL
    AND relationships.status = 'active'
    AND relationships.professional_user_id = $1
  INNER JOIN request_selections selections
    ON selections.id = jobs.source_request_selection_id
    AND selections.request_relationship_id = relationships.id
    AND selections.post_id = jobs.job_request_id
    AND selections.professional_user_id = $1
    AND selections.ended_at IS NULL
  INNER JOIN relationship_participants participants
    ON participants.job_id = jobs.id
    AND participants.request_relationship_id = relationships.id
    AND participants.user_id = $1
  INNER JOIN participant_role_assignments roles
    ON roles.participant_id = participants.id
    AND roles.job_id = jobs.id
    AND roles.role = 'PRIMARY_PROFESSIONAL'
    AND roles.valid_from <= CURRENT_TIMESTAMP
    AND (roles.valid_until IS NULL OR roles.valid_until > CURRENT_TIMESTAMP)
  LEFT JOIN participant_role_revocations role_revocations
    ON role_revocations.role_assignment_id = roles.id
  INNER JOIN users customers
    ON customers.id = relationships.homeowner_id
  WHERE role_revocations.id IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM canonical_job_completion_records completions
      WHERE completions.job_id = jobs.id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM unnest($2::text[]) AS required(capability)
      WHERE NOT EXISTS (
        SELECT 1
        FROM lifecycle_authority_grants grants
        LEFT JOIN lifecycle_authority_grant_revocations grant_revocations
          ON grant_revocations.authority_grant_id = grants.id
        WHERE grants.grantee_participant_id = participants.id
          AND grants.job_id = jobs.id
          AND grants.scope_type = 'job'
          AND grants.scope_job_id = jobs.id
          AND grants.scope_concern_id IS NULL
          AND grants.capability = required.capability
          AND grants.valid_from <= CURRENT_TIMESTAMP
          AND (grants.valid_until IS NULL OR grants.valid_until > CURRENT_TIMESTAMP)
          AND grant_revocations.id IS NULL
      )
    )
  ORDER BY jobs.created_at DESC, jobs.id ASC
  LIMIT 100
`;

function cleanText(value, maximum) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized ? normalized.slice(0, maximum) : null;
}

function jobProjection(row = {}) {
  return Object.freeze({
    jobId: String(row.job_id || "").trim().toLowerCase(),
    title: cleanText(row.title, 500) || "Untitled Job",
    serviceDomain: cleanText(row.service_domain, 200),
    serviceSpecialty: cleanText(row.service_specialty, 200),
    lifecycleStatus: "ACTIVE",
    customerLabel: cleanText(row.customer_name, 200) || "Customer",
    city: cleanText(row.service_city, 120),
    serviceArea: cleanText(row.discovery_area_label, 260),
    sourceLabel:
      row.source_type === "ordinary_request_selection"
        ? "Job Request"
        : "Job",
  });
}

function validatedInput(input) {
  const allowed = new Set(["pool", "authenticatedActor"]);
  if (
    !isPlainObject(input) ||
    Object.keys(input).some((key) => !allowed.has(key))
  ) {
    return {
      error: failure(
        400,
        "PROFESSIONAL_JOBS_FIELD_REJECTED",
        "The professional Job read is invalid."
      ),
    };
  }
  const actor = validateAuthenticatedActor(input.authenticatedActor);
  if (actor.error) return { error: actor.error };
  if (!input.pool || typeof input.pool.query !== "function") {
    throw new TypeError("A database pool or client is required.");
  }
  return { actorId: actor.id };
}

async function runReadTransaction(pool, action) {
  const client = await databaseClient(pool);
  let started = false;
  try {
    await client.query(
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"
    );
    started = true;
    const result = await action(client);
    await client.query("COMMIT");
    started = false;
    return result;
  } catch (error) {
    if (started) await rollback(client);
    throw error;
  } finally {
    if (client !== pool && typeof client.release === "function") {
      client.release();
    }
  }
}

async function listAuthorizedProfessionalJobs(input = {}) {
  const validated = validatedInput(input);
  if (validated.error) return validated.error;

  return runReadTransaction(input.pool, async (client) => {
    const result = await client.query(AUTHORIZED_JOBS_SQL, [
      validated.actorId,
      [...REQUIRED_CAPABILITIES],
    ]);
    return {
      ok: true,
      success: true,
      status: 200,
      code: "PROFESSIONAL_JOBS_LOADED",
      jobs: result.rows.map(jobProjection),
    };
  });
}

module.exports = {
  listAuthorizedProfessionalJobs,
  professionalJobPickerInternals: {
    AUTHORIZED_JOBS_SQL,
    REQUIRED_CAPABILITIES,
    jobProjection,
    runReadTransaction,
    validatedInput,
  },
};
