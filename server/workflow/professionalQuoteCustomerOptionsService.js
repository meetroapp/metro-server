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

const QUOTE_CUSTOMER_OPTIONS_SQL = `
  /* professional_quote_customer_options:list */
  SELECT DISTINCT
    customers.id AS customer_user_id,
    customers.username AS customer_name,
    jobs.id AS job_id,
    jobs.job_request_id AS request_id,
    jobs.source_request_relationship_id AS relationship_id,
    posts.title,
    posts.service_city,
    posts.discovery_area_label,
    working.id AS existing_working_draft_id,
    canonical.id AS existing_canonical_quote_id,
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
  INNER JOIN users customers
    ON customers.id = relationships.homeowner_id
  INNER JOIN relationship_participants customer_participants
    ON customer_participants.job_id = jobs.id
    AND customer_participants.request_relationship_id = relationships.id
    AND customer_participants.user_id = customers.id
    AND customer_participants.identity_type = 'authenticated_user'
  INNER JOIN participant_role_assignments customer_roles
    ON customer_roles.participant_id = customer_participants.id
    AND customer_roles.job_id = jobs.id
    AND customer_roles.role = 'CUSTOMER_REPRESENTATIVE'
    AND customer_roles.valid_from <= CURRENT_TIMESTAMP
    AND (customer_roles.valid_until IS NULL OR customer_roles.valid_until > CURRENT_TIMESTAMP)
  LEFT JOIN participant_role_revocations customer_role_revocations
    ON customer_role_revocations.role_assignment_id = customer_roles.id
  INNER JOIN relationship_participants professional_participants
    ON professional_participants.job_id = jobs.id
    AND professional_participants.request_relationship_id = relationships.id
    AND professional_participants.user_id = $1
    AND professional_participants.identity_type = 'authenticated_user'
  INNER JOIN participant_role_assignments professional_roles
    ON professional_roles.participant_id = professional_participants.id
    AND professional_roles.job_id = jobs.id
    AND professional_roles.role = 'PRIMARY_PROFESSIONAL'
    AND professional_roles.valid_from <= CURRENT_TIMESTAMP
    AND (professional_roles.valid_until IS NULL OR professional_roles.valid_until > CURRENT_TIMESTAMP)
  LEFT JOIN participant_role_revocations professional_role_revocations
    ON professional_role_revocations.role_assignment_id = professional_roles.id
  LEFT JOIN LATERAL (
    SELECT drafts.id
    FROM business_document_working_drafts drafts
    WHERE drafts.job_id = jobs.id
      AND drafts.document_type = 'QUOTE'
      AND drafts.draft_status = 'WORKING_DRAFT'
    ORDER BY drafts.updated_at DESC, drafts.id ASC
    LIMIT 1
  ) working ON TRUE
  LEFT JOIN LATERAL (
    SELECT quotes.id
    FROM canonical_quotes quotes
    WHERE quotes.job_id = jobs.id
      AND quotes.parent_quote_id IS NULL
    ORDER BY quotes.created_at ASC, quotes.id ASC
    LIMIT 1
  ) canonical ON TRUE
  WHERE jobs.source_type = 'ordinary_request_selection'
    AND customer_role_revocations.id IS NULL
    AND professional_role_revocations.id IS NULL
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
        WHERE grants.grantee_participant_id = professional_participants.id
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
  ORDER BY customers.id ASC, jobs.created_at DESC, jobs.id ASC
  LIMIT 200
`;

function cleanText(value, maximum) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized ? normalized.slice(0, maximum) : null;
}

function uuid(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)
    ? normalized
    : null;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function jobProjection(row = {}) {
  const existingDraftId = uuid(row.existing_working_draft_id);
  const existingQuoteId = uuid(row.existing_canonical_quote_id);
  return Object.freeze({
    jobId: uuid(row.job_id),
    requestId: positiveInteger(row.request_id),
    relationshipId: positiveInteger(row.relationship_id),
    title: cleanText(row.title, 500) || "Untitled Job",
    city: cleanText(row.service_city, 120),
    serviceArea: cleanText(row.discovery_area_label, 260),
    customerName: cleanText(row.customer_name, 200) || "Customer",
    newQuoteEligible: !existingDraftId && !existingQuoteId,
    existingQuote: existingDraftId || existingQuoteId
      ? Object.freeze({
          workingDraftId: existingDraftId,
          canonicalQuoteId: existingQuoteId,
        })
      : null,
  });
}

function customerOptions(rows = []) {
  const grouped = new Map();
  for (const row of rows) {
    const customerId = positiveInteger(row.customer_user_id);
    const job = jobProjection(row);
    if (
      !customerId || !job.jobId || !job.requestId || !job.relationshipId
    ) {
      throw new Error("Quote customer option authority projection is invalid.");
    }
    if (!grouped.has(customerId)) {
      grouped.set(customerId, {
        customerId,
        displayName: job.customerName,
        jobs: [],
      });
    }
    grouped.get(customerId).jobs.push(job);
  }
  return Object.freeze([...grouped.values()].map((customer) => Object.freeze({
    customerId: customer.customerId,
    displayName: customer.displayName,
    jobs: Object.freeze(customer.jobs),
  })));
}

function validatedInput(input) {
  if (
    !isPlainObject(input) ||
    Object.keys(input).some((key) => !["pool", "authenticatedActor"].includes(key))
  ) {
    return { error: failure(400, "QUOTE_CUSTOMER_OPTIONS_FIELD_REJECTED", "The Quote customer options request is invalid.") };
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

async function listProfessionalQuoteCustomerOptions(input = {}) {
  const validated = validatedInput(input);
  if (validated.error) return validated.error;
  return runReadTransaction(input.pool, async (client) => {
    const result = await client.query(QUOTE_CUSTOMER_OPTIONS_SQL, [
      validated.actorId,
      [...REQUIRED_CAPABILITIES],
    ]);
    return {
      ok: true,
      status: 200,
      code: "PROFESSIONAL_QUOTE_CUSTOMER_OPTIONS_LOADED",
      contractVersion: 1,
      customers: customerOptions(result.rows),
    };
  });
}

module.exports = {
  listProfessionalQuoteCustomerOptions,
  professionalQuoteCustomerOptionsInternals: Object.freeze({
    QUOTE_CUSTOMER_OPTIONS_SQL,
    REQUIRED_CAPABILITIES,
    customerOptions,
    jobProjection,
    runReadTransaction,
    validatedInput,
  }),
};
