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

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const ACTIVE_STATES = new Set(["PROPOSED", "SCHEDULED"]);
const HISTORY_STATES = new Set(["CANCELLED", "COMPLETED"]);

function iso(value) {
  if (value == null) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function encodeCursor(offset) {
  return Buffer.from(JSON.stringify({ offset })).toString("base64url");
}

function decodeCursor(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || value.length > 1000) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      !isPlainObject(parsed) ||
      !Number.isInteger(parsed.offset) ||
      parsed.offset < 1 ||
      parsed.offset > 10000
    ) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function validatedInput(input) {
  const allowed = new Set([
    "pool",
    "authenticatedActor",
    "view",
    "limit",
    "cursor",
    "clock",
  ]);
  if (!isPlainObject(input) || Object.keys(input).some((key) => !allowed.has(key))) {
    return { error: failure(400, "SCHEDULE_FIELD_REJECTED", "The Schedule read is invalid.") };
  }
  const actor = validateAuthenticatedActor(input.authenticatedActor);
  if (actor.error) return { error: actor.error };
  if (!input.pool || typeof input.pool.query !== "function") {
    throw new TypeError("A database pool or client is required.");
  }
  const view = input.view == null || input.view === "active" ? "active" : input.view;
  if (!new Set(["active", "history"]).has(view)) {
    return { error: failure(400, "INVALID_SCHEDULE_VIEW", "The Schedule view is invalid.") };
  }
  const numericLimit = input.limit == null ? DEFAULT_LIMIT : Number(input.limit);
  if (!Number.isInteger(numericLimit) || numericLimit < 1 || numericLimit > MAX_LIMIT) {
    return { error: failure(400, "INVALID_SCHEDULE_LIMIT", "The Schedule limit is invalid.") };
  }
  const cursor = decodeCursor(input.cursor);
  if (cursor === undefined) {
    return { error: failure(400, "INVALID_SCHEDULE_CURSOR", "The Schedule cursor is invalid.") };
  }
  const nowValue = typeof input.clock === "function" ? input.clock() : new Date();
  const now = nowValue instanceof Date ? nowValue : new Date(nowValue);
  if (Number.isNaN(now.getTime())) throw new TypeError("The Schedule clock is invalid.");
  return { actorId: actor.id, view, limit: numericLimit, cursor, now };
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

const PROFESSIONAL_JOBS_CTE = `
  professional_jobs AS (
    SELECT DISTINCT
      jobs.id AS job_id,
      jobs.job_request_id,
      jobs.source_request_relationship_id AS relationship_id,
      relationships.homeowner_id,
      professional.id AS professional_participant_id,
      customer.id AS customer_participant_id,
      posts.title AS job_title,
      posts.category AS job_category,
      posts.location_intake_mode,
      posts.location_normalization_status,
      posts.service_address_line1,
      posts.service_city,
      posts.service_region,
      posts.service_postal_code,
      posts.service_country_code,
      posts.discovery_area_label,
      homeowners.username AS customer_name,
      jobs.created_at AS job_created_at
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
    INNER JOIN relationship_participants professional
      ON professional.job_id = jobs.id
      AND professional.request_relationship_id = relationships.id
      AND professional.user_id = relationships.professional_user_id
    INNER JOIN participant_role_assignments professional_roles
      ON professional_roles.participant_id = professional.id
      AND professional_roles.job_id = jobs.id
      AND professional_roles.role = 'PRIMARY_PROFESSIONAL'
      AND professional_roles.valid_from <= CURRENT_TIMESTAMP
      AND (professional_roles.valid_until IS NULL OR professional_roles.valid_until > CURRENT_TIMESTAMP)
    LEFT JOIN participant_role_revocations professional_role_revocations
      ON professional_role_revocations.role_assignment_id = professional_roles.id
    INNER JOIN relationship_participants customer
      ON customer.job_id = jobs.id
      AND customer.request_relationship_id = relationships.id
      AND customer.user_id = relationships.homeowner_id
    INNER JOIN participant_role_assignments customer_roles
      ON customer_roles.participant_id = customer.id
      AND customer_roles.job_id = jobs.id
      AND customer_roles.role = 'CUSTOMER_REPRESENTATIVE'
      AND customer_roles.valid_from <= CURRENT_TIMESTAMP
      AND (customer_roles.valid_until IS NULL OR customer_roles.valid_until > CURRENT_TIMESTAMP)
    LEFT JOIN participant_role_revocations customer_role_revocations
      ON customer_role_revocations.role_assignment_id = customer_roles.id
    INNER JOIN users homeowners ON homeowners.id = relationships.homeowner_id
    WHERE jobs.lifecycle_contract_version = 2
      AND professional_role_revocations.id IS NULL
      AND customer_role_revocations.id IS NULL
  )`;

const ACTIVE_GRANT = `
  grants.valid_from <= CURRENT_TIMESTAMP
  AND (grants.valid_until IS NULL OR grants.valid_until > CURRENT_TIMESTAMP)
  AND revocations.id IS NULL`;

async function loadOpportunities(client, actorId, limit) {
  const result = await client.query(
    `WITH ${PROFESSIONAL_JOBS_CTE},
    evaluation_opportunities AS (
      SELECT
        'EVALUATION'::text AS purpose,
        jobs.job_id,
        subjects.evaluation_id,
        NULL::uuid AS quote_id,
        NULL::uuid AS approved_quote_decision_id,
        CASE WHEN activations.id IS NULL THEN 'AVAILABLE' ELSE 'ACTIVE' END AS authority_state,
        activations.created_at AS authority_activated_at,
        jobs.*,
        evaluations.updated_at AS subject_updated_at
      FROM professional_jobs jobs
      INNER JOIN canonical_evaluation_job_subjects subjects ON subjects.job_id = jobs.job_id
      INNER JOIN canonical_evaluations evaluations
        ON evaluations.id = subjects.evaluation_id AND evaluations.status = 'draft'
      LEFT JOIN canonical_evaluation_visit_authority_activations activations
        ON activations.job_id = jobs.job_id AND activations.evaluation_id = subjects.evaluation_id
      WHERE EXISTS (
        SELECT 1 FROM lifecycle_authority_grants grants
        LEFT JOIN lifecycle_authority_grant_revocations revocations
          ON revocations.authority_grant_id = grants.id
        WHERE grants.grantee_participant_id = jobs.professional_participant_id
          AND grants.job_id = jobs.job_id
          AND grants.scope_type = 'job'
          AND grants.scope_job_id = jobs.job_id
          AND grants.scope_concern_id IS NULL
          AND grants.scope_evaluation_id IS NULL
          AND grants.scope_approved_quote_decision_id IS NULL
          AND grants.capability = 'evaluation.perform'
          AND ${ACTIVE_GRANT}
      )
      AND (
        activations.id IS NULL OR (
          (SELECT count(DISTINCT grants.capability) FROM lifecycle_authority_grants grants
           LEFT JOIN lifecycle_authority_grant_revocations revocations ON revocations.authority_grant_id = grants.id
           WHERE grants.grantee_participant_id = jobs.professional_participant_id
             AND grants.job_id = jobs.job_id AND grants.scope_type = 'evaluation'
             AND grants.scope_job_id = jobs.job_id AND grants.scope_concern_id IS NULL
             AND grants.scope_evaluation_id = subjects.evaluation_id
             AND grants.scope_approved_quote_decision_id IS NULL
             AND grants.capability = ANY(ARRAY['visit.read','visit.propose','visit.reschedule','visit.cancel','visit.complete'])
             AND ${ACTIVE_GRANT}) = 5
          AND
          (SELECT count(DISTINCT grants.capability) FROM lifecycle_authority_grants grants
           LEFT JOIN lifecycle_authority_grant_revocations revocations ON revocations.authority_grant_id = grants.id
           WHERE grants.grantee_participant_id = jobs.customer_participant_id
             AND grants.job_id = jobs.job_id AND grants.scope_type = 'evaluation'
             AND grants.scope_job_id = jobs.job_id AND grants.scope_concern_id IS NULL
             AND grants.scope_evaluation_id = subjects.evaluation_id
             AND grants.scope_approved_quote_decision_id IS NULL
             AND grants.capability = ANY(ARRAY['visit.read','visit.confirm','visit.change_request'])
             AND ${ACTIVE_GRANT}) = 3
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM canonical_visits visits
        INNER JOIN canonical_visit_evaluation_links links
          ON links.visit_id = visits.id AND links.job_id = visits.job_id
        INNER JOIN LATERAL (
          SELECT state FROM canonical_visit_versions
          WHERE visit_id = visits.id AND job_id = visits.job_id
          ORDER BY version DESC LIMIT 1
        ) current_visit ON TRUE
        WHERE visits.job_id = jobs.job_id AND visits.purpose = 'EVALUATION'
          AND links.evaluation_id = subjects.evaluation_id
          AND current_visit.state IN ('PROPOSED','SCHEDULED')
      )
    ),
    approved_work_opportunities AS (
      SELECT
        'APPROVED_WORK'::text AS purpose,
        jobs.job_id,
        NULL::uuid AS evaluation_id,
        quotes.id AS quote_id,
        decisions.id AS approved_quote_decision_id,
        CASE WHEN activations.id IS NULL THEN 'AVAILABLE' ELSE 'ACTIVE' END AS authority_state,
        activations.created_at AS authority_activated_at,
        jobs.*,
        decisions.decided_at AS subject_updated_at
      FROM professional_jobs jobs
      INNER JOIN canonical_quotes quotes
        ON quotes.job_id = jobs.job_id AND quotes.relationship_id = jobs.relationship_id
        AND quotes.status = 'ISSUED'
      INNER JOIN canonical_quote_customer_decisions decisions
        ON decisions.quote_id = quotes.id AND decisions.job_id = jobs.job_id
        AND decisions.decision = 'APPROVED'
      LEFT JOIN canonical_approved_work_visit_authority_activations activations
        ON activations.job_id = jobs.job_id AND activations.approved_quote_decision_id = decisions.id
      WHERE EXISTS (
        SELECT 1 FROM lifecycle_authority_grants grants
        LEFT JOIN lifecycle_authority_grant_revocations revocations ON revocations.authority_grant_id = grants.id
        WHERE grants.grantee_participant_id = jobs.professional_participant_id
          AND grants.job_id = jobs.job_id AND grants.scope_type = 'job'
          AND grants.scope_job_id = jobs.job_id AND grants.scope_concern_id IS NULL
          AND grants.scope_evaluation_id IS NULL
          AND grants.scope_approved_quote_decision_id IS NULL
          AND grants.capability = 'quote.read'
          AND ${ACTIVE_GRANT}
      )
      AND (
        activations.id IS NULL OR (
          (SELECT count(DISTINCT grants.capability) FROM lifecycle_authority_grants grants
           LEFT JOIN lifecycle_authority_grant_revocations revocations ON revocations.authority_grant_id = grants.id
           WHERE grants.grantee_participant_id = jobs.professional_participant_id
             AND grants.job_id = jobs.job_id AND grants.scope_type = 'approved_work'
             AND grants.scope_job_id = jobs.job_id AND grants.scope_concern_id IS NULL
             AND grants.scope_evaluation_id IS NULL
             AND grants.scope_approved_quote_decision_id = decisions.id
             AND grants.scope_approved_quote_decision = 'APPROVED'
             AND grants.capability = ANY(ARRAY['visit.read','visit.propose','visit.reschedule','visit.cancel','visit.complete'])
             AND ${ACTIVE_GRANT}) = 5
          AND
          (SELECT count(DISTINCT grants.capability) FROM lifecycle_authority_grants grants
           LEFT JOIN lifecycle_authority_grant_revocations revocations ON revocations.authority_grant_id = grants.id
           WHERE grants.grantee_participant_id = jobs.customer_participant_id
             AND grants.job_id = jobs.job_id AND grants.scope_type = 'approved_work'
             AND grants.scope_job_id = jobs.job_id AND grants.scope_concern_id IS NULL
             AND grants.scope_evaluation_id IS NULL
             AND grants.scope_approved_quote_decision_id = decisions.id
             AND grants.scope_approved_quote_decision = 'APPROVED'
             AND grants.capability = ANY(ARRAY['visit.read','visit.confirm','visit.change_request'])
             AND ${ACTIVE_GRANT}) = 3
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM canonical_visits visits
        INNER JOIN LATERAL (
          SELECT state FROM canonical_visit_versions
          WHERE visit_id = visits.id AND job_id = visits.job_id
          ORDER BY version DESC LIMIT 1
        ) current_visit ON TRUE
        WHERE visits.job_id = jobs.job_id AND visits.purpose = 'APPROVED_WORK'
          AND visits.approved_quote_decision_id = decisions.id
          AND current_visit.state IN ('PROPOSED','SCHEDULED')
      )
    )
    SELECT opportunities.*, count(*) OVER() AS opportunity_total FROM (
      SELECT * FROM evaluation_opportunities
      UNION ALL
      SELECT * FROM approved_work_opportunities
    ) opportunities
    ORDER BY subject_updated_at DESC, purpose ASC,
      COALESCE(evaluation_id, approved_quote_decision_id) DESC
    LIMIT $2`,
    [actorId, limit]
  );
  return result.rows;
}

async function loadVisits(client, actorId, view, limit) {
  const states = view === "active" ? ["PROPOSED", "SCHEDULED"] : ["CANCELLED", "COMPLETED"];
  const result = await client.query(
    `WITH ${PROFESSIONAL_JOBS_CTE}
    SELECT
      visits.id, visits.job_id, visits.purpose, visits.created_at,
      visits.approved_quote_decision_id, visits.approved_quote_decision,
      versions.version, versions.state, versions.scheduled_start_at,
      versions.scheduled_end_at, versions.time_zone, versions.location_mode,
      versions.cancellation_reason, versions.cancelled_at, versions.completed_at,
      versions.created_at AS version_created_at,
      evaluation_links.evaluation_id,
      jobs.job_title, jobs.job_category, jobs.customer_name,
      jobs.location_intake_mode, jobs.location_normalization_status,
      jobs.service_address_line1, jobs.service_city, jobs.service_region,
      jobs.service_postal_code, jobs.service_country_code, jobs.discovery_area_label,
      change_request.reason AS change_request_reason,
      change_request.visit_version AS change_request_version,
      change_request.created_at AS change_request_created_at,
      ARRAY(
        SELECT grants.capability FROM lifecycle_authority_grants grants
        LEFT JOIN lifecycle_authority_grant_revocations revocations
          ON revocations.authority_grant_id = grants.id
        WHERE grants.grantee_participant_id = jobs.professional_participant_id
          AND grants.job_id = visits.job_id
          AND grants.scope_job_id = visits.job_id
          AND grants.scope_concern_id IS NULL
          AND grants.capability = ANY(ARRAY['visit.read','visit.reschedule','visit.cancel','visit.complete'])
          AND (
            (visits.purpose = 'EVALUATION' AND (
              (grants.scope_type = 'job' AND grants.scope_job_id = visits.job_id
                AND grants.scope_evaluation_id IS NULL
                AND grants.scope_approved_quote_decision_id IS NULL)
              OR
              (grants.scope_type = 'evaluation'
                AND grants.scope_evaluation_id = evaluation_links.evaluation_id
                AND grants.scope_approved_quote_decision_id IS NULL)
            ))
            OR
            (visits.purpose = 'APPROVED_WORK' AND grants.scope_type = 'approved_work'
              AND grants.scope_evaluation_id IS NULL
              AND grants.scope_approved_quote_decision_id = visits.approved_quote_decision_id
              AND grants.scope_approved_quote_decision = 'APPROVED')
          )
          AND ${ACTIVE_GRANT}
        ORDER BY grants.capability
      ) AS active_capabilities,
      count(*) FILTER (WHERE versions.state = 'PROPOSED' AND change_request.created_at IS NULL) OVER()
        AS waiting_on_customer_total,
      count(*) FILTER (WHERE versions.state = 'PROPOSED' AND change_request.created_at IS NOT NULL) OVER()
        AS change_requested_total,
      count(*) FILTER (WHERE versions.state = 'SCHEDULED') OVER() AS upcoming_total
    FROM canonical_visits visits
    INNER JOIN professional_jobs jobs ON jobs.job_id = visits.job_id
    INNER JOIN LATERAL (
      SELECT version, state, scheduled_start_at, scheduled_end_at, time_zone,
        location_mode, cancellation_reason, cancelled_at, completed_at, created_at
      FROM canonical_visit_versions
      WHERE visit_id = visits.id AND job_id = visits.job_id
      ORDER BY version DESC LIMIT 1
    ) versions ON TRUE
    LEFT JOIN canonical_visit_evaluation_links evaluation_links
      ON evaluation_links.visit_id = visits.id AND evaluation_links.job_id = visits.job_id
    LEFT JOIN LATERAL (
      SELECT reason, visit_version, created_at
      FROM canonical_visit_events
      WHERE visit_id = visits.id AND job_id = visits.job_id
        AND event_type = 'VISIT_CHANGE_REQUESTED'
      ORDER BY created_at DESC, id DESC LIMIT 1
    ) change_request ON TRUE
    WHERE visits.purpose IN ('EVALUATION','APPROVED_WORK')
      AND versions.state = ANY($2::text[])
      AND EXISTS (
        SELECT 1 FROM lifecycle_authority_grants grants
        LEFT JOIN lifecycle_authority_grant_revocations revocations
          ON revocations.authority_grant_id = grants.id
        WHERE grants.grantee_participant_id = jobs.professional_participant_id
          AND grants.job_id = visits.job_id AND grants.capability = 'visit.read'
          AND grants.scope_job_id = visits.job_id
          AND grants.scope_concern_id IS NULL
          AND (
            (visits.purpose = 'EVALUATION' AND (
              (grants.scope_type = 'job' AND grants.scope_job_id = visits.job_id
                AND grants.scope_evaluation_id IS NULL
                AND grants.scope_approved_quote_decision_id IS NULL)
              OR
              (grants.scope_type = 'evaluation'
                AND grants.scope_evaluation_id = evaluation_links.evaluation_id
                AND grants.scope_approved_quote_decision_id IS NULL)
            ))
            OR
            (visits.purpose = 'APPROVED_WORK' AND grants.scope_type = 'approved_work'
              AND grants.scope_evaluation_id IS NULL
              AND grants.scope_approved_quote_decision_id = visits.approved_quote_decision_id
              AND grants.scope_approved_quote_decision = 'APPROVED')
          )
          AND ${ACTIVE_GRANT}
      )
    ORDER BY
      CASE WHEN $3 = 'active' THEN versions.scheduled_start_at END ASC,
      CASE WHEN $3 = 'history' THEN COALESCE(versions.completed_at, versions.cancelled_at, versions.created_at) END DESC,
      visits.id ASC
    LIMIT $4`,
    [actorId, states, view, limit]
  );
  return result.rows;
}

function locationProjection(row, locationMode) {
  if (locationMode === "REMOTE") {
    return { mode: "REMOTE", serviceArea: null, address: null };
  }
  const normalized = row.location_normalization_status === "normalized";
  const exact = normalized && row.location_intake_mode === "exact_on_file";
  return {
    mode: "JOB_SERVICE_LOCATION",
    serviceArea: normalized ? row.discovery_area_label || null : null,
    address: exact ? {
      line1: row.service_address_line1 || null,
      city: row.service_city || null,
      region: row.service_region || null,
      postalCode: row.service_postal_code || null,
      countryCode: row.service_country_code || null,
    } : null,
  };
}

function jobProjection(row) {
  return {
    id: row.job_id,
    title: row.job_title || "Job",
    category: row.job_category || null,
  };
}

function customerProjection(row) {
  return { displayName: row.customer_name || "Customer" };
}

function opportunityProjection(row) {
  const subjectId = row.evaluation_id || row.approved_quote_decision_id;
  const sortAt = iso(row.subject_updated_at || row.authority_activated_at || row.job_created_at);
  return {
    kind: "opportunity",
    identity: `${row.purpose}:${subjectId}`,
    sortAt,
    semanticState: "READY_TO_SCHEDULE",
    jobId: row.job_id,
    purpose: row.purpose,
    evaluationId: row.evaluation_id || null,
    quoteId: row.quote_id || null,
    approvedQuoteDecisionId: row.approved_quote_decision_id || null,
    authority: { state: row.authority_state },
    job: jobProjection(row),
    customer: customerProjection(row),
    location: locationProjection(row, "JOB_SERVICE_LOCATION"),
    actions: {
      canStartScheduling: true,
      canViewJob: true,
    },
  };
}

function visitSemanticState(row) {
  if (row.state === "PROPOSED") {
    return row.change_request_created_at ? "CHANGE_REQUESTED" : "WAITING_FOR_CUSTOMER";
  }
  return row.state;
}

function visitProjection(row, now) {
  const capabilities = new Set(row.active_capabilities || []);
  const semanticState = visitSemanticState(row);
  const sortAt = row.state === "CANCELLED"
    ? iso(row.cancelled_at || row.version_created_at)
    : row.state === "COMPLETED"
      ? iso(row.completed_at || row.version_created_at)
      : iso(row.scheduled_start_at);
  return {
    kind: "visit",
    identity: row.id,
    sortAt,
    semanticState,
    id: row.id,
    jobId: row.job_id,
    purpose: row.purpose,
    state: row.state,
    currentVersion: Number(row.version),
    scheduledStartAt: iso(row.scheduled_start_at),
    scheduledEndAt: iso(row.scheduled_end_at),
    timeZone: row.time_zone,
    locationMode: row.location_mode,
    location: locationProjection(row, row.location_mode),
    cancellationReason: row.cancellation_reason || null,
    cancelledAt: iso(row.cancelled_at),
    completedAt: iso(row.completed_at),
    evaluationId: row.evaluation_id || null,
    approvedQuoteDecisionEvidence: row.approved_quote_decision_id ? {
      decisionId: row.approved_quote_decision_id,
      decision: row.approved_quote_decision,
    } : null,
    latestCustomerChangeRequest: row.change_request_created_at ? {
      visitVersion: Number(row.change_request_version),
      reason: row.change_request_reason,
      createdAt: iso(row.change_request_created_at),
    } : null,
    job: jobProjection(row),
    customer: customerProjection(row),
    createdAt: iso(row.created_at),
    versionCreatedAt: iso(row.version_created_at),
    actions: {
      canReschedule: row.state === "SCHEDULED" && capabilities.has("visit.reschedule"),
      canCancel: ACTIVE_STATES.has(row.state) && capabilities.has("visit.cancel"),
      canComplete:
        row.state === "SCHEDULED" &&
        Date.parse(row.scheduled_start_at) <= now.getTime() &&
        capabilities.has("visit.complete"),
      canViewJob: true,
    },
  };
}

function compareItems(left, right, view) {
  const timeDifference = Date.parse(left.sortAt) - Date.parse(right.sortAt);
  if (timeDifference !== 0) return view === "active" ? timeDifference : -timeDifference;
  const kindDifference = left.kind.localeCompare(right.kind);
  if (kindDifference !== 0) return kindDifference;
  return left.identity.localeCompare(right.identity);
}

function summary(opportunityRows, visitRows, view) {
  if (view === "history") {
    return { readyToSchedule: 0, waitingOnCustomer: 0, changeRequested: 0, upcoming: 0 };
  }
  return {
    readyToSchedule: Number(opportunityRows[0]?.opportunity_total || 0),
    waitingOnCustomer: Number(visitRows[0]?.waiting_on_customer_total || 0),
    changeRequested: Number(visitRows[0]?.change_requested_total || 0),
    upcoming: Number(visitRows[0]?.upcoming_total || 0),
  };
}

async function getProfessionalSchedule(input = {}) {
  const validated = validatedInput(input);
  if (validated.error) return validated.error;
  const { actorId, view, limit, cursor, now } = validated;
  return runReadTransaction(input.pool, async (client) => {
    const offset = cursor?.offset || 0;
    const queryLimit = offset + limit + 1;
    const [opportunityRows, visitRows] = await Promise.all([
      view === "active" ? loadOpportunities(client, actorId, queryLimit) : [],
      loadVisits(client, actorId, view, queryLimit),
    ]);
    const canonicalItems = [
      ...opportunityRows.map(opportunityProjection),
      ...visitRows.map((row) => visitProjection(row, now)),
    ].sort((left, right) => compareItems(left, right, view));
    const page = canonicalItems.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    const hasMore = canonicalItems.length > offset + limit && nextOffset < 10000;
    return {
      ok: true,
      success: true,
      status: 200,
      code: "PROFESSIONAL_SCHEDULE_LOADED",
      schedule: {
        view,
        summary: summary(opportunityRows, visitRows, view),
        opportunities: page.filter((item) => item.kind === "opportunity")
          .map(({ kind, identity, sortAt, ...item }) => item),
        visits: page.filter((item) => item.kind === "visit")
          .map(({ kind, identity, sortAt, ...item }) => item),
        page: {
          limit,
          hasMore,
          nextCursor: hasMore ? encodeCursor(nextOffset) : null,
        },
      },
    };
  });
}

module.exports = {
  getProfessionalSchedule,
  professionalScheduleInternals: Object.freeze({
    decodeCursor,
    encodeCursor,
    locationProjection,
    opportunityProjection,
    summary,
    visitProjection,
    visitSemanticState,
  }),
};
