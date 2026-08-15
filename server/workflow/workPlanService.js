"use strict";

const { commercialAuthorityInternals } = require("../authorization/commercialAuthorityService");

const {
  databaseClient,
  failure,
  isPlainObject,
  normalizedUuid,
  rollback,
  validateAuthenticatedActor,
} = commercialAuthorityInternals;

const PROFESSIONAL_CAPABILITIES = Object.freeze([
  "workstream.read",
  "work_activity.create",
  "work_activity.progress",
  "work_activity.read",
  "work_obligation.read",
  "workstream.complete",
]);
const ACTIVE_WORKSTREAM_STATES = new Set(["OPEN", "ACTIVE", "BLOCKED"]);

function iso(value) {
  if (value == null) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function validateInput(input, { jobRequired }) {
  const allowed = new Set(["pool", "authenticatedActor", ...(jobRequired ? ["jobId"] : [])]);
  if (!isPlainObject(input) || Object.keys(input).some((key) => !allowed.has(key))) {
    return { error: failure(400, "WORK_PLAN_FIELD_REJECTED", "The Work Plan read is invalid.") };
  }
  const actor = validateAuthenticatedActor(input.authenticatedActor);
  if (actor.error) return { error: actor.error };
  const jobId = jobRequired ? normalizedUuid(input.jobId) : null;
  if (jobRequired && !jobId) {
    return { error: failure(400, "INVALID_WORK_PLAN_JOB_ID", "A valid Job ID is required.") };
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

async function loadProfessionalContext(client, actorId, jobId) {
  const result = await client.query(
    `SELECT jobs.id AS job_id, jobs.job_request_id,
      jobs.source_request_relationship_id AS relationship_id,
      relationships.status AS relationship_status,
      relationships.professional_user_id,
      users.account_type,
      participants.id AS professional_participant_id,
      EXISTS (
        SELECT 1 FROM participant_role_assignments roles
        LEFT JOIN participant_role_revocations revocations
          ON revocations.role_assignment_id = roles.id
        WHERE roles.participant_id = participants.id
          AND roles.job_id = jobs.id
          AND roles.role = 'PRIMARY_PROFESSIONAL'
          AND roles.valid_from <= CURRENT_TIMESTAMP
          AND (roles.valid_until IS NULL OR roles.valid_until > CURRENT_TIMESTAMP)
          AND revocations.id IS NULL
      ) AS is_primary_professional,
      ARRAY(
        SELECT grants.capability
        FROM lifecycle_authority_grants grants
        LEFT JOIN lifecycle_authority_grant_revocations revocations
          ON revocations.authority_grant_id = grants.id
        WHERE grants.grantee_participant_id = participants.id
          AND grants.job_id = jobs.id
          AND grants.scope_type = 'job'
          AND grants.scope_job_id = jobs.id
          AND grants.scope_concern_id IS NULL
          AND grants.capability = ANY($3::text[])
          AND grants.valid_from <= CURRENT_TIMESTAMP
          AND (grants.valid_until IS NULL OR grants.valid_until > CURRENT_TIMESTAMP)
          AND revocations.id IS NULL
        ORDER BY grants.capability
      ) AS active_capabilities
    FROM jobs
    INNER JOIN posts ON posts.id = jobs.job_request_id
      AND posts.lifecycle_contract_version = 2
      AND posts.cancelled_at IS NULL
    INNER JOIN request_relationships relationships
      ON relationships.id = jobs.source_request_relationship_id
      AND relationships.post_id = jobs.job_request_id
      AND relationships.emergency_request_id IS NULL
    INNER JOIN relationship_participants participants
      ON participants.job_id = jobs.id
      AND participants.request_relationship_id = relationships.id
      AND participants.user_id = $2
    INNER JOIN users ON users.id = $2
    WHERE jobs.id = $1 AND jobs.lifecycle_contract_version = 2
    LIMIT 1`,
    [jobId, actorId, [...PROFESSIONAL_CAPABILITIES]]
  );
  return result.rows[0] || null;
}

function professionalContextUnavailable(context, actorId) {
  return Boolean(
    !context ||
    context.relationship_status !== "active" ||
    context.account_type !== "professional" ||
    Number(context.professional_user_id) !== Number(actorId) ||
    context.is_primary_professional !== true ||
    !Array.isArray(context.active_capabilities) ||
    !context.active_capabilities.includes("workstream.read")
  );
}

async function loadCustomerContext(client, actorId, jobId) {
  const result = await client.query(
    `SELECT jobs.id AS job_id, jobs.job_request_id,
      jobs.source_request_relationship_id AS relationship_id,
      relationships.status AS relationship_status,
      participants.id AS customer_participant_id,
      EXISTS (
        SELECT 1 FROM participant_role_assignments roles
        LEFT JOIN participant_role_revocations revocations
          ON revocations.role_assignment_id = roles.id
        WHERE roles.participant_id = participants.id
          AND roles.job_id = jobs.id
          AND roles.role = 'CUSTOMER_REPRESENTATIVE'
          AND roles.valid_from <= CURRENT_TIMESTAMP
          AND (roles.valid_until IS NULL OR roles.valid_until > CURRENT_TIMESTAMP)
          AND revocations.id IS NULL
      ) AS is_customer_representative,
      EXISTS (
        SELECT 1 FROM lifecycle_authority_grants grants
        LEFT JOIN lifecycle_authority_grant_revocations revocations
          ON revocations.authority_grant_id = grants.id
        WHERE grants.grantee_participant_id = participants.id
          AND grants.job_id = jobs.id
          AND grants.scope_type = 'job'
          AND grants.scope_job_id = jobs.id
          AND grants.scope_concern_id IS NULL
          AND grants.capability = 'participant.read'
          AND grants.valid_from <= CURRENT_TIMESTAMP
          AND (grants.valid_until IS NULL OR grants.valid_until > CURRENT_TIMESTAMP)
          AND revocations.id IS NULL
      ) AS can_read_job
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

function customerContextUnavailable(context) {
  return Boolean(
    !context ||
    context.relationship_status !== "active" ||
    !context.customer_participant_id ||
    context.is_customer_representative !== true ||
    context.can_read_job !== true
  );
}

async function loadApprovedWork(client, jobId) {
  const quotes = await client.query(
    `SELECT quotes.id, quotes.lineage_type, decisions.issued_quote_version
    FROM canonical_quotes quotes
    INNER JOIN canonical_quote_customer_decisions decisions
      ON decisions.quote_id = quotes.id
      AND decisions.job_id = quotes.job_id
      AND decisions.decision = 'APPROVED'
    WHERE quotes.job_id = $1 AND quotes.status = 'ISSUED'
    ORDER BY quotes.created_at ASC, quotes.id ASC`,
    [jobId]
  );
  if (quotes.rows.length === 0) return { quotes: [], workstreamLinks: [] };
  const links = await client.query(
    `SELECT DISTINCT snapshots.source_workstream_id AS workstream_id,
      snapshots.quote_id
    FROM canonical_quote_scope_item_snapshots snapshots
    INNER JOIN canonical_quote_customer_decisions decisions
      ON decisions.quote_id = snapshots.quote_id
      AND decisions.job_id = snapshots.job_id
      AND decisions.issued_quote_version = snapshots.quote_version
      AND decisions.decision = 'APPROVED'
    INNER JOIN canonical_quotes quotes
      ON quotes.id = snapshots.quote_id
      AND quotes.job_id = snapshots.job_id
      AND quotes.status = 'ISSUED'
    WHERE snapshots.job_id = $1
      AND snapshots.source_workstream_id IS NOT NULL
      AND snapshots.included_in_total = TRUE
    ORDER BY snapshots.source_workstream_id, snapshots.quote_id`,
    [jobId]
  );
  return { quotes: quotes.rows, workstreamLinks: links.rows };
}

async function loadWorkRows(client, jobId, workstreamIds) {
  if (workstreamIds.length === 0) {
    return { workstreams: [], activities: [], obligations: [], findingStates: [], updates: [] };
  }
  const workstreams = await client.query(
      `SELECT workstreams.id, workstreams.sequence, current.version,
        current.title, current.state, current.created_at AS updated_at
      FROM canonical_workstreams workstreams
      INNER JOIN LATERAL (
        SELECT version, title, state, created_at
        FROM canonical_workstream_versions versions
        WHERE versions.workstream_id = workstreams.id
          AND versions.job_id = workstreams.job_id
        ORDER BY versions.version DESC LIMIT 1
      ) current ON TRUE
      WHERE workstreams.job_id = $1 AND workstreams.id = ANY($2::uuid[])
      ORDER BY workstreams.sequence, workstreams.id`,
      [jobId, workstreamIds]
    );
  const activities = await client.query(
      `SELECT activities.id, activities.workstream_id, current.version,
        current.activity_type, current.statement, current.status,
        current.customer_visible, current.performed_at,
        activities.created_at, current.created_at AS updated_at
      FROM canonical_work_activities activities
      INNER JOIN LATERAL (
        SELECT version, activity_type, statement, status, customer_visible,
          performed_at, created_at
        FROM canonical_work_activity_versions versions
        WHERE versions.activity_id = activities.id
          AND versions.workstream_id = activities.workstream_id
          AND versions.job_id = activities.job_id
        ORDER BY versions.version DESC LIMIT 1
      ) current ON TRUE
      WHERE activities.job_id = $1
        AND activities.workstream_id = ANY($2::uuid[])
      ORDER BY activities.created_at, activities.id`,
      [jobId, workstreamIds]
    );
  const obligations = await client.query(
      `SELECT obligations.id, obligations.workstream_id, obligations.sequence,
        current.version, current.statement, current.status,
        current.created_at AS updated_at
      FROM canonical_workstream_obligations obligations
      INNER JOIN LATERAL (
        SELECT version, statement, status, created_at
        FROM canonical_workstream_obligation_versions versions
        WHERE versions.obligation_id = obligations.id
          AND versions.workstream_id = obligations.workstream_id
          AND versions.job_id = obligations.job_id
        ORDER BY versions.version DESC LIMIT 1
      ) current ON TRUE
      WHERE obligations.job_id = $1
        AND obligations.workstream_id = ANY($2::uuid[])
      ORDER BY obligations.workstream_id, obligations.sequence, obligations.id`,
      [jobId, workstreamIds]
    );
  const findingStates = await client.query(
      `SELECT assignments.workstream_id, current.resolution_state
      FROM canonical_finding_workstream_assignments assignments
      INNER JOIN LATERAL (
        SELECT confirmation_state, resolution_state
        FROM canonical_evaluation_finding_versions versions
        WHERE versions.finding_id = assignments.finding_id
          AND versions.job_id = assignments.job_id
        ORDER BY versions.version DESC LIMIT 1
      ) current ON TRUE
      WHERE assignments.job_id = $1
        AND assignments.workstream_id = ANY($2::uuid[])
        AND current.confirmation_state = 'CONFIRMED'`,
      [jobId, workstreamIds]
    );
  const updates = await client.query(
      `WITH versions AS (
        SELECT activity_id, version, workstream_id, statement, status,
          customer_visible, created_at,
          lag(statement) OVER (PARTITION BY activity_id ORDER BY version) AS previous_statement
        FROM canonical_work_activity_versions
        WHERE job_id = $1 AND workstream_id = ANY($2::uuid[])
      )
      SELECT activity_id, version, workstream_id, statement, status,
        customer_visible, created_at
      FROM versions
      WHERE version > 1 AND statement IS DISTINCT FROM previous_statement
      ORDER BY created_at, activity_id, version`,
      [jobId, workstreamIds]
    );
  return {
    workstreams: workstreams.rows,
    activities: activities.rows,
    obligations: obligations.rows,
    findingStates: findingStates.rows,
    updates: updates.rows,
  };
}

function businessWorkstreamState(workstream, activities, obligations, findingStates) {
  if (
    workstream.state === "BLOCKED" ||
    obligations.some((item) => item.status === "OPEN") ||
    findingStates.some((item) => ["OPEN", "PARTIALLY_RESOLVED"].includes(item.resolution_state))
  ) return "NEEDS_ATTENTION";
  if (workstream.state === "COMPLETED") return "COMPLETED";
  if (
    workstream.state === "ACTIVE" ||
    activities.some((item) => ["IN_PROGRESS", "DONE"].includes(item.status))
  ) return "IN_PROGRESS";
  return "READY_TO_START";
}

function completionEligibility(workstream, activities, obligations, findingStates) {
  return Boolean(
    ACTIVE_WORKSTREAM_STATES.has(workstream.state) &&
    !activities.some((item) => ["PLANNED", "IN_PROGRESS"].includes(item.status)) &&
    !obligations.some((item) => item.status === "OPEN") &&
    !findingStates.some((item) => ["OPEN", "PARTIALLY_RESOLVED"].includes(item.resolution_state))
  );
}

function customerWorkstreamState(workstream, activities) {
  if (workstream.state === "COMPLETED") return "COMPLETED";
  if (
    ["ACTIVE", "BLOCKED"].includes(workstream.state) ||
    activities.some((item) => ["IN_PROGRESS", "DONE"].includes(item.status))
  ) return "IN_PROGRESS";
  return "READY_TO_START";
}

function activityProjection(row, capabilities, updates) {
  const open = ["PLANNED", "IN_PROGRESS"].includes(row.status);
  return {
    id: row.id,
    workstreamId: row.workstream_id,
    activityType: row.activity_type,
    statement: row.statement,
    status: row.status,
    customerVisible: row.customer_visible === true,
    performedAt: iso(row.performed_at),
    currentVersion: Number(row.version),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    canStart: row.status === "PLANNED" && capabilities.has("work_activity.progress"),
    canUpdate: open && capabilities.has("work_activity.progress"),
    canComplete: row.status === "IN_PROGRESS" && capabilities.has("work_activity.progress"),
    updates: updates.map((update) => ({
      version: Number(update.version),
      statement: update.statement,
      status: update.status,
      customerVisible: update.customer_visible === true,
      recordedAt: iso(update.created_at),
    })),
  };
}

function buildProfessionalProjection({ context, approvedWork, rows }) {
  const capabilities = new Set(context.active_capabilities || []);
  const linksByWorkstream = new Map();
  for (const link of approvedWork.workstreamLinks) {
    const quoteIds = linksByWorkstream.get(link.workstream_id) || [];
    quoteIds.push(link.quote_id);
    linksByWorkstream.set(link.workstream_id, quoteIds);
  }
  const workstreams = rows.workstreams.map((workstream) => {
    const activities = rows.activities.filter((item) => item.workstream_id === workstream.id);
    const obligations = rows.obligations.filter((item) => item.workstream_id === workstream.id);
    const findingStates = rows.findingStates.filter((item) => item.workstream_id === workstream.id);
    const eligible = completionEligibility(workstream, activities, obligations, findingStates);
    return {
      id: workstream.id,
      sequence: Number(workstream.sequence),
      title: workstream.title,
      state: workstream.state,
      status: businessWorkstreamState(workstream, activities, obligations, findingStates),
      currentVersion: Number(workstream.version),
      approvedQuoteIds: [...new Set(linksByWorkstream.get(workstream.id) || [])],
      updatedAt: iso(workstream.updated_at),
      canAddWorkItem: ACTIVE_WORKSTREAM_STATES.has(workstream.state) && capabilities.has("work_activity.create"),
      canMarkComplete: eligible && capabilities.has("workstream.complete"),
      activities: activities.map((activity) => activityProjection(
        activity,
        capabilities,
        rows.updates.filter((update) => update.activity_id === activity.id)
      )),
      blockers: obligations.filter((item) => item.status === "OPEN").map((item) => ({
        id: item.id,
        statement: item.statement,
        status: "NEEDS_ATTENTION",
      })),
    };
  });
  const activities = workstreams.flatMap((item) => item.activities)
    .filter((item) => item.status !== "CANCELLED");
  const readyForCompletionReview = workstreams.length > 0 &&
    workstreams.every((item) => item.state === "COMPLETED");
  return {
    contractVersion: 1,
    jobId: context.job_id,
    requestId: Number(context.job_request_id),
    relationshipId: Number(context.relationship_id),
    approvedQuotes: approvedWork.quotes.map((quote) => ({
      id: quote.id,
      lineageType: quote.lineage_type || "ORIGINAL_QUOTE",
    })),
    summary: {
      workItemCount: activities.length,
      completedCount: activities.filter((item) => item.status === "DONE").length,
      remainingCount: activities.filter((item) => ["PLANNED", "IN_PROGRESS"].includes(item.status)).length,
      needsAttentionCount: workstreams.filter((item) => item.status === "NEEDS_ATTENTION").length,
      readyForCompletionReview,
    },
    workstreams,
  };
}

function buildCustomerProjection({ context, rows }) {
  const workstreams = rows.workstreams.map((workstream) => {
    const allActivities = rows.activities.filter((item) => item.workstream_id === workstream.id);
    const customerActivities = allActivities.filter(
      (item) => item.customer_visible === true
    );
    return {
      id: workstream.id,
      title: workstream.title,
      status: customerWorkstreamState(workstream, customerActivities),
      activities: customerActivities.map((activity) => ({
        id: activity.id,
        statement: activity.statement,
        status: activity.status,
        performedAt: iso(activity.performed_at),
        updatedAt: iso(activity.updated_at),
      })),
      updates: rows.updates
        .filter((update) => update.workstream_id === workstream.id && update.customer_visible === true)
        .map((update) => ({
          activityId: update.activity_id,
          statement: update.statement,
          status: update.status,
          recordedAt: iso(update.created_at),
        })),
    };
  });
  return {
    contractVersion: 1,
    jobId: context.job_id,
    requestId: Number(context.job_request_id),
    relationshipId: Number(context.relationship_id),
    summary: {
      workAreaCount: workstreams.length,
      completedCount: workstreams.filter((item) => item.status === "COMPLETED").length,
      remainingCount: workstreams.filter((item) => item.status !== "COMPLETED").length,
      readyForCompletionReview: workstreams.length > 0 &&
        workstreams.every((item) => item.status === "COMPLETED"),
    },
    workstreams,
  };
}

async function getProfessionalJobWorkPlan(input = {}) {
  const validated = validateInput(input, { jobRequired: true });
  if (validated.error) return validated.error;
  return runRead(input.pool, async (client) => {
    const context = await loadProfessionalContext(client, validated.actorId, validated.jobId);
    if (professionalContextUnavailable(context, validated.actorId)) {
      return failure(404, "PROFESSIONAL_WORK_PLAN_UNAVAILABLE", "The Work Plan is unavailable.");
    }
    const approvedWork = await loadApprovedWork(client, validated.jobId);
    const workstreamIds = [...new Set(approvedWork.workstreamLinks.map((row) => row.workstream_id))];
    const rows = await loadWorkRows(client, validated.jobId, workstreamIds);
    return {
      ok: true,
      success: true,
      status: 200,
      code: "PROFESSIONAL_WORK_PLAN_FOUND",
      workPlan: buildProfessionalProjection({ context, approvedWork, rows }),
    };
  });
}

async function getCustomerJobWorkPlan(input = {}) {
  const validated = validateInput(input, { jobRequired: true });
  if (validated.error) return validated.error;
  return runRead(input.pool, async (client) => {
    const context = await loadCustomerContext(client, validated.actorId, validated.jobId);
    if (customerContextUnavailable(context)) {
      return failure(404, "CUSTOMER_WORK_PLAN_UNAVAILABLE", "Work progress is unavailable.");
    }
    const approvedWork = await loadApprovedWork(client, validated.jobId);
    const workstreamIds = [...new Set(approvedWork.workstreamLinks.map((row) => row.workstream_id))];
    const rows = await loadWorkRows(client, validated.jobId, workstreamIds);
    return {
      ok: true,
      success: true,
      status: 200,
      code: "CUSTOMER_WORK_PLAN_FOUND",
      workPlan: buildCustomerProjection({ context, rows }),
    };
  });
}

async function getProfessionalWorkPlanSummary(input = {}) {
  const validated = validateInput(input, { jobRequired: false });
  if (validated.error) return validated.error;
  return runRead(input.pool, async (client) => {
    const result = await client.query(
      `WITH professional_jobs AS (
        SELECT DISTINCT jobs.id AS job_id, jobs.job_request_id,
          jobs.source_request_relationship_id AS relationship_id,
          posts.title, homeowners.username AS customer_name
        FROM jobs
        INNER JOIN posts ON posts.id = jobs.job_request_id
          AND posts.lifecycle_contract_version = 2
          AND posts.cancelled_at IS NULL
        INNER JOIN request_relationships relationships
          ON relationships.id = jobs.source_request_relationship_id
          AND relationships.status = 'active'
          AND relationships.emergency_request_id IS NULL
          AND relationships.professional_user_id = $1
        INNER JOIN users homeowners ON homeowners.id = relationships.homeowner_id
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
        WHERE role_revocations.id IS NULL
          AND EXISTS (
            SELECT 1 FROM lifecycle_authority_grants grants
            LEFT JOIN lifecycle_authority_grant_revocations revocations
              ON revocations.authority_grant_id = grants.id
            WHERE grants.grantee_participant_id = participants.id
              AND grants.job_id = jobs.id
              AND grants.scope_type = 'job'
              AND grants.scope_job_id = jobs.id
              AND grants.scope_concern_id IS NULL
              AND grants.capability = 'workstream.read'
              AND grants.valid_from <= CURRENT_TIMESTAMP
              AND (grants.valid_until IS NULL OR grants.valid_until > CURRENT_TIMESTAMP)
              AND revocations.id IS NULL
          )
      ), approved_workstreams AS (
        SELECT DISTINCT snapshots.job_id, snapshots.source_workstream_id AS workstream_id
        FROM canonical_quote_scope_item_snapshots snapshots
        INNER JOIN canonical_quote_customer_decisions decisions
          ON decisions.quote_id = snapshots.quote_id
          AND decisions.job_id = snapshots.job_id
          AND decisions.issued_quote_version = snapshots.quote_version
          AND decisions.decision = 'APPROVED'
        INNER JOIN canonical_quotes quotes
          ON quotes.id = snapshots.quote_id
          AND quotes.job_id = snapshots.job_id
          AND quotes.status = 'ISSUED'
        INNER JOIN professional_jobs jobs ON jobs.job_id = snapshots.job_id
        WHERE snapshots.source_workstream_id IS NOT NULL
          AND snapshots.included_in_total = TRUE
      ), current_workstreams AS (
        SELECT workstreams.id, workstreams.job_id, current.state
        FROM canonical_workstreams workstreams
        INNER JOIN approved_workstreams approved
          ON approved.job_id = workstreams.job_id AND approved.workstream_id = workstreams.id
        INNER JOIN LATERAL (
          SELECT state FROM canonical_workstream_versions versions
          WHERE versions.workstream_id = workstreams.id AND versions.job_id = workstreams.job_id
          ORDER BY versions.version DESC LIMIT 1
        ) current ON TRUE
      ), current_activities AS (
        SELECT activities.id, activities.job_id, activities.workstream_id, current.status
        FROM canonical_work_activities activities
        INNER JOIN approved_workstreams approved
          ON approved.job_id = activities.job_id AND approved.workstream_id = activities.workstream_id
        INNER JOIN LATERAL (
          SELECT status FROM canonical_work_activity_versions versions
          WHERE versions.activity_id = activities.id
            AND versions.workstream_id = activities.workstream_id
            AND versions.job_id = activities.job_id
          ORDER BY versions.version DESC LIMIT 1
        ) current ON TRUE
      ), open_obligations AS (
        SELECT obligations.job_id, obligations.workstream_id, count(*)::integer AS count
        FROM canonical_workstream_obligations obligations
        INNER JOIN approved_workstreams approved
          ON approved.job_id = obligations.job_id AND approved.workstream_id = obligations.workstream_id
        INNER JOIN LATERAL (
          SELECT status FROM canonical_workstream_obligation_versions versions
          WHERE versions.obligation_id = obligations.id
            AND versions.workstream_id = obligations.workstream_id
            AND versions.job_id = obligations.job_id
          ORDER BY versions.version DESC LIMIT 1
        ) current ON TRUE
        WHERE current.status = 'OPEN'
        GROUP BY obligations.job_id, obligations.workstream_id
      )
      SELECT jobs.job_id, jobs.job_request_id, jobs.relationship_id,
        jobs.title, jobs.customer_name,
        count(DISTINCT workstreams.id)::integer AS workstream_count,
        count(DISTINCT activities.id) FILTER (WHERE activities.status <> 'CANCELLED')::integer AS work_item_count,
        count(DISTINCT activities.id) FILTER (WHERE activities.status = 'DONE')::integer AS completed_count,
        count(DISTINCT activities.id) FILTER (WHERE activities.status IN ('PLANNED','IN_PROGRESS'))::integer AS remaining_count,
        count(DISTINCT workstreams.id) FILTER (
          WHERE workstreams.state = 'BLOCKED' OR obligations.count > 0
        )::integer AS needs_attention_count,
        (count(DISTINCT workstreams.id) > 0 AND
          count(DISTINCT workstreams.id) = count(DISTINCT workstreams.id) FILTER (WHERE workstreams.state = 'COMPLETED'))
          AS ready_for_completion_review
      FROM professional_jobs jobs
      INNER JOIN current_workstreams workstreams ON workstreams.job_id = jobs.job_id
      LEFT JOIN current_activities activities ON activities.job_id = jobs.job_id
        AND activities.workstream_id = workstreams.id
      LEFT JOIN open_obligations obligations ON obligations.job_id = jobs.job_id
        AND obligations.workstream_id = workstreams.id
      GROUP BY jobs.job_id, jobs.job_request_id, jobs.relationship_id,
        jobs.title, jobs.customer_name
      ORDER BY needs_attention_count DESC, remaining_count DESC, jobs.job_id`,
      [validated.actorId]
    );
    const jobs = result.rows.map((row) => ({
      jobId: row.job_id,
      requestId: Number(row.job_request_id),
      relationshipId: Number(row.relationship_id),
      title: row.title || "Job",
      customerName: row.customer_name || "Customer",
      workstreamCount: Number(row.workstream_count),
      workItemCount: Number(row.work_item_count),
      completedCount: Number(row.completed_count),
      remainingCount: Number(row.remaining_count),
      needsAttentionCount: Number(row.needs_attention_count),
      readyForCompletionReview: row.ready_for_completion_review === true,
    }));
    return {
      ok: true,
      success: true,
      status: 200,
      code: "PROFESSIONAL_WORK_PLAN_SUMMARY_FOUND",
      workPlanSummary: {
        contractVersion: 1,
        jobCount: jobs.length,
        workItemCount: jobs.reduce((sum, job) => sum + job.workItemCount, 0),
        completedCount: jobs.reduce((sum, job) => sum + job.completedCount, 0),
        remainingCount: jobs.reduce((sum, job) => sum + job.remainingCount, 0),
        needsAttentionCount: jobs.reduce((sum, job) => sum + job.needsAttentionCount, 0),
        jobs,
      },
    };
  });
}

module.exports = {
  buildCustomerProjection,
  buildProfessionalProjection,
  getCustomerJobWorkPlan,
  getProfessionalJobWorkPlan,
  getProfessionalWorkPlanSummary,
};
