"use strict";

const { createHash, randomUUID } = require("node:crypto");
const {
  commercialAuthorityInternals,
} = require("../authorization/commercialAuthorityService");

const {
  databaseClient,
  failure,
  isPlainObject,
  normalizedUuid,
  rollback,
  validateAuthenticatedActor,
} = commercialAuthorityInternals;

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const DEFAULT_HISTORY_LIMIT = 20;
const MAX_HISTORY_LIMIT = 50;

function safeLogger(value) {
  return value && typeof value.info === "function" && typeof value.warn === "function"
    ? value
    : console;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function iso(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function nonNegativeInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function validIdempotencyKey(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return IDEMPOTENCY_KEY_PATTERN.test(normalized) ? normalized : null;
}

function historyLimit(value) {
  if (value == null || value === "") return DEFAULT_HISTORY_LIMIT;
  const parsed = positiveInteger(value);
  return parsed && parsed <= MAX_HISTORY_LIMIT ? parsed : null;
}

function encodeCursor(row) {
  if (!row?.completed_at || !row?.job_id) return null;
  return Buffer.from(JSON.stringify({
    completedAt: iso(row.completed_at),
    jobId: row.job_id,
  }), "utf8").toString("base64url");
}

function decodeCursor(value) {
  if (value == null || value === "") return { completedAt: null, jobId: null };
  try {
    const parsed = JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
    const completedAt = iso(parsed?.completedAt);
    const jobId = normalizedUuid(parsed?.jobId);
    return completedAt && jobId ? { completedAt, jobId } : null;
  } catch {
    return null;
  }
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

async function runCommand(pool, action) {
  const client = await databaseClient(pool);
  let started = false;
  try {
    await client.query("BEGIN");
    started = true;
    const outcome = await action(client);
    if (outcome.abort) {
      await rollback(client);
      started = false;
      return outcome.abort;
    }
    await client.query("COMMIT");
    started = false;
    outcome.afterCommit?.();
    return outcome.result;
  } catch (error) {
    if (started) await rollback(client);
    throw error;
  } finally {
    if (client !== pool && typeof client.release === "function") client.release();
  }
}

async function loadProfessionalContext(client, jobId, actorUserId, { lock = false } = {}) {
  const result = await client.query(
    `SELECT jobs.id AS job_id, jobs.job_request_id,
      jobs.source_request_relationship_id AS relationship_id,
      relationships.status AS relationship_status,
      relationships.professional_user_id,
      professional.id AS professional_participant_id,
      EXISTS (
        SELECT 1 FROM participant_role_assignments roles
        LEFT JOIN participant_role_revocations revocations
          ON revocations.role_assignment_id = roles.id
        WHERE roles.participant_id = professional.id
          AND roles.job_id = jobs.id
          AND roles.role = 'PRIMARY_PROFESSIONAL'
          AND roles.valid_from <= CURRENT_TIMESTAMP
          AND (roles.valid_until IS NULL OR roles.valid_until > CURRENT_TIMESTAMP)
          AND revocations.id IS NULL
      ) AS primary_role_active,
      completions.id AS completion_id,
      completions.version AS job_version,
      completions.completed_at
    FROM jobs
    INNER JOIN posts ON posts.id = jobs.job_request_id
      AND posts.lifecycle_contract_version = 2
      AND posts.cancelled_at IS NULL
    INNER JOIN request_relationships relationships
      ON relationships.id = jobs.source_request_relationship_id
      AND relationships.post_id = jobs.job_request_id
      AND relationships.emergency_request_id IS NULL
      AND relationships.professional_user_id = $2
    INNER JOIN relationship_participants professional
      ON professional.job_id = jobs.id
      AND professional.request_relationship_id = relationships.id
      AND professional.user_id = $2
    LEFT JOIN canonical_job_completion_records completions
      ON completions.job_id = jobs.id
    WHERE jobs.id = $1 AND jobs.lifecycle_contract_version = 2
    LIMIT 1
    ${lock ? "FOR UPDATE OF jobs, relationships" : ""}`,
    [jobId, actorUserId]
  );
  return result.rows[0] || null;
}

function professionalUnavailable(context, actorUserId) {
  return Boolean(
    !context ||
    !["active", "closed"].includes(context.relationship_status) ||
    Number(context.professional_user_id) !== actorUserId ||
    context.primary_role_active !== true
  );
}

async function loadCompletionReadiness(client, jobId) {
  const result = await client.query(
    `WITH approved_workstreams AS (
      SELECT DISTINCT snapshots.source_workstream_id AS workstream_id
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
    ), current_workstreams AS (
      SELECT workstreams.id, current.version, current.state
      FROM canonical_workstreams workstreams
      INNER JOIN approved_workstreams approved ON approved.workstream_id = workstreams.id
      INNER JOIN LATERAL (
        SELECT version, state FROM canonical_workstream_versions versions
        WHERE versions.workstream_id = workstreams.id AND versions.job_id = $1
        ORDER BY version DESC LIMIT 1
      ) current ON TRUE
      WHERE workstreams.job_id = $1
    ), current_activities AS (
      SELECT activities.id, activities.workstream_id, current.version,
        current.status, current.customer_visible
      FROM canonical_work_activities activities
      INNER JOIN approved_workstreams approved
        ON approved.workstream_id = activities.workstream_id
      INNER JOIN LATERAL (
        SELECT version, status, customer_visible
        FROM canonical_work_activity_versions versions
        WHERE versions.activity_id = activities.id
          AND versions.workstream_id = activities.workstream_id
          AND versions.job_id = $1
        ORDER BY version DESC LIMIT 1
      ) current ON TRUE
      WHERE activities.job_id = $1
    ), current_obligations AS (
      SELECT obligations.id, obligations.workstream_id, current.version, current.status
      FROM canonical_workstream_obligations obligations
      INNER JOIN approved_workstreams approved
        ON approved.workstream_id = obligations.workstream_id
      INNER JOIN LATERAL (
        SELECT version, status FROM canonical_workstream_obligation_versions versions
        WHERE versions.obligation_id = obligations.id
          AND versions.workstream_id = obligations.workstream_id
          AND versions.job_id = $1
        ORDER BY version DESC LIMIT 1
      ) current ON TRUE
      WHERE obligations.job_id = $1
    ), current_findings AS (
      SELECT assignments.finding_id, assignments.workstream_id,
        current.version, current.confirmation_state, current.resolution_state
      FROM canonical_finding_workstream_assignments assignments
      INNER JOIN approved_workstreams approved
        ON approved.workstream_id = assignments.workstream_id
      INNER JOIN LATERAL (
        SELECT version, confirmation_state, resolution_state
        FROM canonical_evaluation_finding_versions versions
        WHERE versions.finding_id = assignments.finding_id
          AND versions.job_id = $1
        ORDER BY version DESC LIMIT 1
      ) current ON TRUE
      WHERE assignments.job_id = $1
    )
    SELECT
      (SELECT count(*) FROM current_workstreams)::integer AS workstream_count,
      (SELECT count(*) FROM current_workstreams WHERE state = 'COMPLETED')::integer
        AS completed_workstream_count,
      (SELECT count(*) FROM current_activities WHERE status <> 'CANCELLED')::integer
        AS work_item_count,
      (SELECT count(*) FROM current_activities WHERE status = 'DONE')::integer
        AS completed_work_item_count,
      (SELECT count(*) FROM current_activities
        WHERE status IN ('PLANNED', 'IN_PROGRESS'))::integer AS incomplete_work_item_count,
      (SELECT count(*) FROM current_obligations WHERE status = 'OPEN')::integer
        AS open_obligation_count,
      (SELECT count(*) FROM current_findings
        WHERE confirmation_state = 'CONFIRMED'
          AND resolution_state IN ('OPEN', 'PARTIALLY_RESOLVED'))::integer
        AS unresolved_finding_count,
      (SELECT count(*) FROM current_activities WHERE customer_visible = TRUE)::integer
        AS customer_update_count,
      jsonb_build_object(
        'workstreams', COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'id', id, 'version', version, 'state', state) ORDER BY id)
          FROM current_workstreams), '[]'::jsonb),
        'activities', COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'id', id, 'workstreamId', workstream_id, 'version', version,
          'status', status) ORDER BY id) FROM current_activities), '[]'::jsonb),
        'obligations', COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'id', id, 'workstreamId', workstream_id, 'version', version,
          'status', status) ORDER BY id) FROM current_obligations), '[]'::jsonb),
        'findings', COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'id', finding_id, 'workstreamId', workstream_id, 'version', version,
          'confirmationState', confirmation_state, 'resolutionState', resolution_state)
          ORDER BY finding_id) FROM current_findings), '[]'::jsonb)
      ) AS evidence_snapshot`,
    [jobId]
  );
  return result.rows[0];
}

function readinessProjection(context, row) {
  const workstreamCount = Number(row.workstream_count);
  const completedWorkstreamCount = Number(row.completed_workstream_count);
  const workItemCount = Number(row.work_item_count);
  const completedWorkItemCount = Number(row.completed_work_item_count);
  const outstanding = {
    workstreams: Math.max(0, workstreamCount - completedWorkstreamCount),
    workItems: Number(row.incomplete_work_item_count),
    obligations: Number(row.open_obligation_count),
    findings: Number(row.unresolved_finding_count),
  };
  const reasons = [];
  if (workstreamCount === 0) reasons.push("NO_APPROVED_WORK");
  if (outstanding.workstreams > 0) reasons.push("INCOMPLETE_WORKSTREAM");
  if (outstanding.workItems > 0) reasons.push("INCOMPLETE_WORK_ITEM");
  if (outstanding.obligations > 0) reasons.push("OPEN_OBLIGATION");
  if (outstanding.findings > 0) reasons.push("UNRESOLVED_FINDING");
  const completed = Boolean(context.completion_id);
  return {
    contractVersion: 1,
    jobId: context.job_id,
    requestId: Number(context.job_request_id),
    relationshipId: Number(context.relationship_id),
    currentVersion: completed ? Number(context.job_version) : 0,
    state: completed ? "COMPLETED" : "ACTIVE",
    eligible: !completed && reasons.length === 0,
    canComplete: !completed && reasons.length === 0,
    reasons: completed ? ["JOB_ALREADY_COMPLETED"] : reasons,
    work: {
      workstreamCount,
      completedWorkstreamCount,
      workItemCount,
      completedWorkItemCount,
    },
    outstanding,
    customerUpdates: {
      count: Number(row.customer_update_count),
      status: "UP_TO_DATE",
    },
    completedAt: completed ? iso(context.completed_at) : null,
  };
}

function validateProfessionalRead(input, { command = false } = {}) {
  const allowed = new Set([
    "pool", "authenticatedActor", "jobId", "logger",
    ...(command ? ["expectedVersion", "idempotencyKey"] : []),
  ]);
  if (!isPlainObject(input) || Object.keys(input).some((key) => !allowed.has(key))) {
    return { error: failure(400, "JOB_COMPLETION_FIELD_REJECTED", "The Job completion request is invalid.") };
  }
  const actor = validateAuthenticatedActor(input.authenticatedActor);
  if (actor.error) return { error: actor.error };
  const jobId = normalizedUuid(input.jobId);
  if (!jobId) return { error: failure(400, "INVALID_JOB_ID", "A valid Job ID is required.") };
  if (!input.pool || typeof input.pool.query !== "function") throw new TypeError("A database pool is required.");
  if (!command) return { actorId: actor.id, jobId, logger: safeLogger(input.logger) };
  const expectedVersion = nonNegativeInteger(input.expectedVersion);
  const idempotencyKey = validIdempotencyKey(input.idempotencyKey);
  if (expectedVersion == null || !idempotencyKey) {
    return { error: failure(400, "INVALID_JOB_COMPLETION_COMMAND", "The Job completion command is invalid.") };
  }
  return { actorId: actor.id, jobId, expectedVersion, idempotencyKey, logger: safeLogger(input.logger) };
}

async function getJobCompletionReview(input = {}) {
  const validated = validateProfessionalRead(input);
  if (validated.error) return validated.error;
  return runRead(input.pool, async (client) => {
    const context = await loadProfessionalContext(client, validated.jobId, validated.actorId);
    if (professionalUnavailable(context, validated.actorId)) {
      return failure(404, "JOB_COMPLETION_UNAVAILABLE", "Completion Review is unavailable.");
    }
    const readiness = await loadCompletionReadiness(client, validated.jobId);
    return {
      ok: true, success: true, status: 200, code: "JOB_COMPLETION_REVIEW_FOUND",
      completionReview: readinessProjection(context, readiness),
    };
  });
}

async function reserveCompletionCommand(client, validated, participantId) {
  const requestFingerprint = fingerprint({
    jobId: validated.jobId,
    expectedVersion: validated.expectedVersion,
  });
  const inserted = await client.query(
    `INSERT INTO canonical_job_completion_command_idempotency (
      id, actor_participant_id, job_id, command_name,
      expected_job_version, idempotency_key, request_fingerprint
    ) VALUES ($1, $2, $3, 'job.complete', $4, $5, $6)
    ON CONFLICT (actor_participant_id, job_id, command_name, idempotency_key)
    DO NOTHING RETURNING id`,
    [randomUUID(), participantId, validated.jobId, validated.expectedVersion,
      validated.idempotencyKey, requestFingerprint]
  );
  if (inserted.rows[0]) return { id: inserted.rows[0].id };
  const existing = await client.query(
    `SELECT id, request_fingerprint, result_reference, completed_at
     FROM canonical_job_completion_command_idempotency
     WHERE actor_participant_id = $1 AND job_id = $2
       AND command_name = 'job.complete' AND idempotency_key = $3
     LIMIT 1 FOR UPDATE`,
    [participantId, validated.jobId, validated.idempotencyKey]
  );
  const row = existing.rows[0];
  if (!row || row.request_fingerprint !== requestFingerprint) {
    return { error: failure(409, "JOB_COMPLETION_IDEMPOTENCY_KEY_CONFLICT", "The idempotency key was already used for a different command.") };
  }
  if (!row.completed_at || !row.result_reference) {
    return { error: failure(409, "JOB_COMPLETION_COMMAND_IN_PROGRESS", "The Job completion command is still in progress.") };
  }
  return { replay: { ...row.result_reference, replayed: true } };
}

async function completeJob(input = {}) {
  const validated = validateProfessionalRead(input, { command: true });
  if (validated.error) return validated.error;
  return runCommand(input.pool, async (client) => {
    const context = await loadProfessionalContext(
      client, validated.jobId, validated.actorId, { lock: true }
    );
    if (professionalUnavailable(context, validated.actorId) || context.relationship_status !== "active") {
      return { abort: failure(404, "JOB_COMPLETION_UNAVAILABLE", "Completion Review is unavailable.") };
    }
    const reserved = await reserveCompletionCommand(
      client, validated, context.professional_participant_id
    );
    if (reserved.error) return { abort: reserved.error };
    if (reserved.replay) return { result: reserved.replay };

    const currentVersion = context.completion_id ? Number(context.job_version) : 0;
    if (currentVersion !== validated.expectedVersion) {
      return { abort: failure(409, "STALE_JOB_VERSION", "The Job version is no longer current.") };
    }
    if (context.completion_id) {
      return { abort: failure(409, "JOB_ALREADY_COMPLETED", "The Job is already completed.") };
    }
    const readiness = await loadCompletionReadiness(client, validated.jobId);
    const review = readinessProjection(context, readiness);
    if (!review.eligible) {
      validated.logger.warn("Job completion rejected", {
        code: "JOB_COMPLETION_INELIGIBLE",
        actorUserId: validated.actorId,
        jobId: validated.jobId,
        reasons: review.reasons,
      });
      return { abort: { ...failure(409, "JOB_COMPLETION_INELIGIBLE", "The Job is not ready for completion."), reasons: review.reasons } };
    }

    const completionId = randomUUID();
    const completedAt = new Date().toISOString();
    const evidenceSnapshot = readiness.evidence_snapshot;
    const completion = {
      contractVersion: 1,
      id: completionId,
      jobId: validated.jobId,
      requestId: Number(context.job_request_id),
      relationshipId: Number(context.relationship_id),
      currentVersion: 1,
      status: "COMPLETED",
      completedAt,
      summary: {
        workstreamCount: Number(readiness.workstream_count),
        workItemCount: Number(readiness.work_item_count),
        customerUpdateCount: Number(readiness.customer_update_count),
      },
      nextAction: { code: "READY_TO_INVOICE", label: "Ready to Invoice" },
    };
    const integrityHash = fingerprint({
      completionId,
      jobId: validated.jobId,
      version: 1,
      participantId: context.professional_participant_id,
      completedAt,
      evidenceSnapshot,
    });
    await client.query(
      `INSERT INTO canonical_job_completion_records (
        id, job_id, version, status, completed_by_participant_id,
        workstream_count, work_item_count, customer_update_count,
        evidence_snapshot, integrity_hash, completed_at
      ) VALUES ($1, $2, 1, 'COMPLETED', $3, $4, $5, $6, $7::jsonb, $8, $9)`,
      [completionId, validated.jobId, context.professional_participant_id,
        completion.summary.workstreamCount, completion.summary.workItemCount,
        completion.summary.customerUpdateCount, JSON.stringify(evidenceSnapshot),
        integrityHash, completedAt]
    );
    const result = {
      ok: true, success: true, status: 200, code: "JOB_COMPLETED", completion,
    };
    await client.query(
      `UPDATE canonical_job_completion_command_idempotency
       SET completion_record_id = $2, result_reference = $3::jsonb,
         completed_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND completion_record_id IS NULL`,
      [reserved.id, completionId, JSON.stringify(result)]
    );
    return {
      result,
      afterCommit: () => validated.logger.info("Job completed", {
        code: "JOB_COMPLETED",
        actorUserId: validated.actorId,
        jobId: validated.jobId,
        completionId,
      }),
    };
  });
}

function historySummary(row) {
  return {
    contractVersion: 1,
    jobId: row.job_id,
    requestId: Number(row.job_request_id),
    relationshipId: Number(row.relationship_id),
    conversationId: positiveInteger(row.conversation_id),
    customerName: row.customer_name || "Customer",
    professionalName: row.professional_name || "Professional",
    serviceTitle: row.service_title || "Job",
    status: "COMPLETED",
    completedAt: iso(row.completed_at),
    approvedQuote: row.approved_total_minor == null || !row.approved_currency ? null : {
      totalMinor: Number(row.approved_total_minor),
      currency: row.approved_currency,
    },
    completionSummary: {
      workstreamCount: Number(row.workstream_count),
      workItemCount: Number(row.work_item_count),
      customerUpdateCount: Number(row.customer_update_count),
    },
    nextAction: { code: "READY_TO_INVOICE", label: "Ready to Invoice" },
  };
}

const HISTORY_BASE_SQL = `
  SELECT completions.job_id, jobs.job_request_id,
    jobs.source_request_relationship_id AS relationship_id,
    selections.conversation_id, homeowners.username AS customer_name,
    COALESCE(profiles.business_name, professionals.username) AS professional_name,
    posts.title AS service_title, completions.completed_at,
    completions.workstream_count, completions.work_item_count,
    completions.customer_update_count,
    approved.total_minor AS approved_total_minor,
    approved.currency AS approved_currency
  FROM canonical_job_completion_records completions
  INNER JOIN jobs ON jobs.id = completions.job_id
  INNER JOIN posts ON posts.id = jobs.job_request_id
  INNER JOIN request_relationships relationships
    ON relationships.id = jobs.source_request_relationship_id
    AND relationships.post_id = jobs.job_request_id
    AND relationships.emergency_request_id IS NULL
  INNER JOIN request_selections selections
    ON selections.id = jobs.source_request_selection_id
  INNER JOIN users homeowners ON homeowners.id = relationships.homeowner_id
  INNER JOIN users professionals ON professionals.id = relationships.professional_user_id
  LEFT JOIN contractor_profiles profiles ON profiles.user_id = professionals.id
  LEFT JOIN LATERAL (
    SELECT sum(current.total_minor)::bigint AS total_minor,
      CASE WHEN count(DISTINCT current.currency) = 1 THEN max(current.currency) END AS currency
    FROM canonical_quotes quotes
    INNER JOIN canonical_quote_customer_decisions decisions
      ON decisions.quote_id = quotes.id AND decisions.job_id = quotes.job_id
      AND decisions.decision = 'APPROVED'
    INNER JOIN LATERAL (
      SELECT versions.total_minor, versions.currency
      FROM canonical_quote_versions versions
      WHERE versions.quote_id = quotes.id
        AND versions.version = decisions.issued_quote_version
      LIMIT 1
    ) current ON TRUE
    WHERE quotes.job_id = jobs.id AND quotes.status = 'ISSUED'
  ) approved ON TRUE`;

async function listProfessionalJobHistory(input = {}) {
  const allowed = new Set(["pool", "authenticatedActor", "limit", "cursor"]);
  if (!isPlainObject(input) || Object.keys(input).some((key) => !allowed.has(key))) {
    return failure(400, "JOB_HISTORY_FIELD_REJECTED", "The Job History request is invalid.");
  }
  const actor = validateAuthenticatedActor(input.authenticatedActor);
  if (actor.error) return actor.error;
  const limit = historyLimit(input.limit);
  const cursor = decodeCursor(input.cursor);
  if (!limit || !cursor) return failure(400, "INVALID_JOB_HISTORY_PAGE", "The Job History page is invalid.");
  if (!input.pool || typeof input.pool.query !== "function") throw new TypeError("A database pool is required.");
  return runRead(input.pool, async (client) => {
    const result = await client.query(
      `WITH history AS (${HISTORY_BASE_SQL}
        WHERE relationships.professional_user_id = $1
      ), counted AS (
        SELECT history.*, count(*) OVER()::integer AS total_count
        FROM history
      )
      SELECT * FROM counted
      WHERE ($2::timestamptz IS NULL OR (completed_at, job_id) < ($2::timestamptz, $3::uuid))
      ORDER BY completed_at DESC, job_id DESC
      LIMIT $4`,
      [actor.id, cursor.completedAt, cursor.jobId, limit + 1]
    );
    const hasMore = result.rows.length > limit;
    const pageRows = result.rows.slice(0, limit);
    return {
      ok: true, success: true, status: 200, code: "PROFESSIONAL_JOB_HISTORY_FOUND",
      jobHistory: {
        contractVersion: 1,
        totalCount: Number(result.rows[0]?.total_count || 0),
        jobs: pageRows.map(historySummary),
        pagination: {
          limit,
          nextCursor: hasMore ? encodeCursor(pageRows.at(-1)) : null,
        },
      },
    };
  });
}

async function getHistoryDetail(input = {}, audience) {
  const allowed = new Set(["pool", "authenticatedActor", "jobId"]);
  if (!isPlainObject(input) || Object.keys(input).some((key) => !allowed.has(key))) {
    return failure(400, "JOB_HISTORY_FIELD_REJECTED", "The Job History request is invalid.");
  }
  const actor = validateAuthenticatedActor(input.authenticatedActor);
  if (actor.error) return actor.error;
  const jobId = normalizedUuid(input.jobId);
  if (!jobId) return failure(400, "INVALID_JOB_ID", "A valid Job ID is required.");
  if (!input.pool || typeof input.pool.query !== "function") throw new TypeError("A database pool is required.");
  return runRead(input.pool, async (client) => {
    const actorColumn = audience === "customer" ? "relationships.homeowner_id" : "relationships.professional_user_id";
    const result = await client.query(
      `${HISTORY_BASE_SQL}
       WHERE completions.job_id = $1 AND ${actorColumn} = $2
       LIMIT 1`,
      [jobId, actor.id]
    );
    const row = result.rows[0];
    if (!row) return failure(404, "JOB_HISTORY_UNAVAILABLE", "Job History is unavailable.");
    const concern = await client.query(
      `SELECT original_text, reported_at
       FROM reported_concerns WHERE job_request_id = $1
       ORDER BY sequence ASC LIMIT 1`,
      [row.job_request_id]
    );
    const summary = historySummary(row);
    return {
      ok: true, success: true, status: 200, code: "JOB_HISTORY_DETAIL_FOUND",
      jobHistory: {
        ...summary,
        audience,
        originalRequest: concern.rows[0] ? {
          concern: concern.rows[0].original_text,
          reportedAt: iso(concern.rows[0].reported_at),
        } : null,
        preservedRecords: {
          evaluation: true,
          findings: true,
          recommendations: true,
          approvedQuotes: true,
          visits: true,
          workPlan: true,
        },
        actions: audience === "customer"
          ? { canMessageProfessional: positiveInteger(row.conversation_id) !== null }
          : { canViewJob: true },
      },
    };
  });
}

const getProfessionalJobHistory = (input) => getHistoryDetail(input, "professional");
const getCustomerJobHistory = (input) => getHistoryDetail(input, "customer");

module.exports = {
  completeJob,
  decodeCursor,
  getCustomerJobHistory,
  getJobCompletionReview,
  getProfessionalJobHistory,
  historySummary,
  listProfessionalJobHistory,
  loadCompletionReadiness,
  readinessProjection,
};
