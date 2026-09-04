"use strict";

const { randomUUID } = require("node:crypto");

const {
  AUTHORITY_SOURCE,
  OWNING_ENGINE,
  TRACEABILITY,
  commercialAuthorityInternals,
  validateSourceContext,
} = require("./commercialAuthorityService");

const {
  completeIdempotency,
  databaseClient,
  failure,
  fingerprint,
  isPlainObject,
  normalizedUuid,
  positiveInteger,
  reserveIdempotency,
  rollback,
  validateAuthenticatedActor,
  validateIdempotencyKey,
} = commercialAuthorityInternals;
const {
  hasActiveLifecycleGrant,
} = require("./lifecycleAuthorityService");

const EVALUATION_STATUS = Object.freeze({
  DRAFT: "draft",
  COMPLETED: "completed",
});

const EVALUATION_COMMANDS = Object.freeze({
  CREATE: "evaluation.create",
  UPDATE_DRAFT: "evaluation.draft.update",
  COMPLETE: "evaluation.complete",
  REVISE: "evaluation.revise",
});

const EVALUATION_EVIDENCE_TYPES = Object.freeze({
  CREATED: "evaluation_created",
  DRAFT_UPDATED: "evaluation_draft_updated",
  COMPLETED: "evaluation_completed",
  REVISED: "evaluation_revised",
});

const EVALUATION_COMPLETION_MODES = Object.freeze({
  PHYSICAL: "PHYSICAL",
  REMOTE: "REMOTE",
});

const REMOTE_ASSESSMENT_METHODS = Object.freeze([
  "PHONE",
  "VIDEO",
  "CUSTOMER_PHOTOS",
  "DOCUMENT_REVIEW",
  "OTHER_REMOTE",
]);
const REMOTE_ASSESSMENT_METHOD_SET = new Set(REMOTE_ASSESSMENT_METHODS);

const CAPABILITY_MILESTONE_ID = "MC-WORKFLOW-002B";
const ORDINARY_EVALUATION_CAPABILITY = "evaluation.perform";
const ALLOWED_EMERGENCY_EVALUATION_STATUSES = Object.freeze([
  "professional_arrived",
  "work_in_progress",
  "completed",
]);
const CONTENT_KEYS = new Set([
  "serviceType",
  "evaluationContext",
  "templateKey",
  "observations",
  "measurements",
  "findings",
  "diagnosisSummary",
  "limitations",
  "scopeRecommendations",
  "relevantConditions",
  "supportingMediaReferences",
  "internalNotes",
]);
const SERVER_OWNED_FIELDS = new Set([
  "id",
  "evaluationId",
  "aggregateId",
  "actorId",
  "actorUserId",
  "ownerId",
  "ownerUserId",
  "professionalUserId",
  "homeownerUserId",
  "version",
  "currentVersion",
  "status",
  "createdAt",
  "updatedAt",
  "completedAt",
  "confirmed",
  "authoritySource",
  "owningEngine",
  "capabilities",
  "traceability",
  "quoteReady",
  "authorizationAvailable",
  "workflowStatus",
  "price",
  "total",
  "approved",
  "paymentStatus",
]);

function validateCommandInput(input, allowedFields) {
  if (!isPlainObject(input)) {
    return failure(400, "INVALID_EVALUATION_COMMAND", "The Evaluation command is invalid.");
  }
  if (
    Object.keys(input).some(
      (key) => !allowedFields.has(key)
    )
  ) {
    return failure(
      400,
      "EVALUATION_AUTHORITY_FIELD_REJECTED",
      "Server-owned Evaluation fields cannot be supplied."
    );
  }
  return null;
}

function text(value, maximum, { required = false } = {}) {
  if (value == null) return required ? null : "";
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if ((required && !normalized) || normalized.length > maximum) return null;
  return normalized;
}

function optionalIdentifier(value, maximum) {
  if (value == null || value === "") return null;
  return text(value, maximum, { required: true });
}

function boundedStringArray(value, field) {
  if (value == null) return { value: [] };
  if (!Array.isArray(value) || value.length > 50) {
    return {
      error: failure(400, "INVALID_EVALUATION_CONTENT", `${field} is invalid.`),
    };
  }
  const normalized = value.map((item) => text(item, 1000, { required: true }));
  if (normalized.some((item) => item == null)) {
    return {
      error: failure(400, "INVALID_EVALUATION_CONTENT", `${field} is invalid.`),
    };
  }
  return { value: normalized };
}

function validateMeasurements(value) {
  if (value == null) return { value: [] };
  if (!Array.isArray(value) || value.length > 50) {
    return {
      error: failure(
        400,
        "INVALID_EVALUATION_CONTENT",
        "Evaluation measurements are invalid."
      ),
    };
  }

  const allowed = new Set(["label", "value", "unit", "notes"]);
  const measurements = [];
  for (const item of value) {
    if (!isPlainObject(item) || Object.keys(item).some((key) => !allowed.has(key))) {
      return {
        error: failure(
          400,
          "INVALID_EVALUATION_CONTENT",
          "Evaluation measurements are invalid."
        ),
      };
    }
    const label = text(item.label, 200, { required: true });
    const measuredValue = text(item.value, 200, { required: true });
    const unit = optionalIdentifier(item.unit, 80);
    const notes = text(item.notes, 500);
    if (!label || !measuredValue || unit === null && item.unit || notes == null) {
      return {
        error: failure(
          400,
          "INVALID_EVALUATION_CONTENT",
          "Evaluation measurements are invalid."
        ),
      };
    }
    measurements.push({ label, value: measuredValue, unit, notes });
  }
  return { value: measurements };
}

function validateFindings(value) {
  if (value == null) return { value: [] };
  if (!Array.isArray(value) || value.length > 50) {
    return {
      error: failure(
        400,
        "INVALID_EVALUATION_CONTENT",
        "Evaluation findings are invalid."
      ),
    };
  }

  const allowed = new Set(["summary", "severity", "customerShareable"]);
  const allowedSeverities = new Set([
    "informational",
    "low",
    "moderate",
    "high",
    "critical",
  ]);
  const findings = [];
  for (const item of value) {
    if (!isPlainObject(item) || Object.keys(item).some((key) => !allowed.has(key))) {
      return {
        error: failure(
          400,
          "INVALID_EVALUATION_CONTENT",
          "Evaluation findings are invalid."
        ),
      };
    }
    const summary = text(item.summary, 1000, { required: true });
    const severity = item.severity == null
      ? "informational"
      : optionalIdentifier(item.severity, 40);
    const customerShareable = item.customerShareable === true;
    if (!summary || !severity || !allowedSeverities.has(severity)) {
      return {
        error: failure(
          400,
          "INVALID_EVALUATION_CONTENT",
          "Evaluation findings are invalid."
        ),
      };
    }
    findings.push({ summary, severity, customerShareable });
  }
  return { value: findings };
}

function validateEvaluationContent(value) {
  if (!isPlainObject(value)) {
    return {
      error: failure(
        400,
        "INVALID_EVALUATION_CONTENT",
        "Evaluation content is invalid."
      ),
    };
  }
  if (
    Object.keys(value).some(
      (key) => !CONTENT_KEYS.has(key) || SERVER_OWNED_FIELDS.has(key)
    )
  ) {
    return {
      error: failure(
        400,
        "INVALID_EVALUATION_CONTENT",
        "Evaluation content contains unsupported authority fields."
      ),
    };
  }

  const serviceType = optionalIdentifier(value.serviceType, 120);
  const evaluationContext = optionalIdentifier(value.evaluationContext, 120);
  const templateKey = optionalIdentifier(value.templateKey, 160);
  const observations = text(value.observations, 5000);
  const diagnosisSummary = text(value.diagnosisSummary, 5000);
  const limitations = text(value.limitations, 5000);
  const internalNotes = text(value.internalNotes, 5000);
  if (
    observations == null ||
    diagnosisSummary == null ||
    limitations == null ||
    internalNotes == null ||
    (value.serviceType != null && value.serviceType !== "" && !serviceType) ||
    (value.evaluationContext != null &&
      value.evaluationContext !== "" &&
      !evaluationContext) ||
    (value.templateKey != null && value.templateKey !== "" && !templateKey)
  ) {
    return {
      error: failure(
        400,
        "INVALID_EVALUATION_CONTENT",
        "Evaluation content is invalid."
      ),
    };
  }

  const measurements = validateMeasurements(value.measurements);
  if (measurements.error) return measurements;
  const findings = validateFindings(value.findings);
  if (findings.error) return findings;
  const scopeRecommendations = boundedStringArray(
    value.scopeRecommendations,
    "Evaluation scope recommendations"
  );
  if (scopeRecommendations.error) return scopeRecommendations;
  const relevantConditions = boundedStringArray(
    value.relevantConditions,
    "Evaluation relevant conditions"
  );
  if (relevantConditions.error) return relevantConditions;

  if (
    value.supportingMediaReferences != null &&
    (!Array.isArray(value.supportingMediaReferences) ||
      value.supportingMediaReferences.length > 0)
  ) {
    return {
      error: failure(
        409,
        "EVALUATION_MEDIA_UNSUPPORTED",
        "Supporting Evaluation media is not available yet."
      ),
    };
  }

  return {
    content: {
      serviceType,
      evaluationContext,
      templateKey,
      observations,
      measurements: measurements.value,
      findings: findings.value,
      diagnosisSummary,
      limitations,
      scopeRecommendations: scopeRecommendations.value,
      relevantConditions: relevantConditions.value,
      supportingMediaReferences: [],
      internalNotes,
    },
  };
}

function validateCompletionContent(content) {
  if (
    !content.observations ||
    content.findings.length === 0 ||
    content.scopeRecommendations.length === 0
  ) {
    return failure(
      409,
      "EVALUATION_INCOMPLETE",
      "Observations, findings, and scope recommendations are required before completion."
    );
  }
  return null;
}

function validateOrdinaryEvaluationContent(content) {
  if (content.findings.length > 0 || content.scopeRecommendations.length > 0) {
    return failure(
      409,
      "ORDINARY_EVALUATION_DOWNSTREAM_AUTHORITY_UNAVAILABLE",
      "Finding and Recommendation authority is unavailable for ordinary Evaluations."
    );
  }
  return null;
}

function validateOrdinaryCompletionContent(content) {
  if (!content.observations) {
    return failure(
      409,
      "EVALUATION_INCOMPLETE",
      "Observations are required before confirmation."
    );
  }
  return null;
}

function validateCreateInput(input) {
  const inputError = validateCommandInput(
    input,
    new Set([
      "pool",
      "authenticatedActor",
      "sourceContext",
      "content",
      "expectedVersion",
      "idempotencyKey",
    ])
  );
  if (inputError) return { error: inputError };
  const actor = validateAuthenticatedActor(input.authenticatedActor);
  if (actor.error) return actor;
  const idempotency = validateIdempotencyKey(input.idempotencyKey);
  if (idempotency.error) return idempotency;
  const source = validateSourceContext(input.sourceContext);
  if (source.error) return source;
  if (source.sourceContext.type !== "emergency_request") {
    return {
      error: failure(
        409,
        "ORDINARY_EVALUATION_AUTHORITY_UNAVAILABLE",
        "Evaluation authority is unavailable for this request context."
      ),
    };
  }
  const content = validateEvaluationContent(input.content);
  if (content.error) return content;
  if (input.expectedVersion != null && Number(input.expectedVersion) !== 0) {
    return {
      error: failure(
        409,
        "STALE_EVALUATION_VERSION",
        "The Evaluation version is no longer current."
      ),
    };
  }
  return {
    actorId: actor.id,
    idempotencyKey: idempotency.idempotencyKey,
    sourceContext: source.sourceContext,
    content: content.content,
  };
}

function validateOrdinaryCreateInput(input) {
  const inputError = validateCommandInput(
    input,
    new Set([
      "pool",
      "authenticatedActor",
      "jobId",
      "visitId",
      "content",
      "expectedVersion",
      "idempotencyKey",
      "logger",
    ])
  );
  if (inputError) return { error: inputError };
  const actor = validateAuthenticatedActor(input.authenticatedActor);
  if (actor.error) return actor;
  const jobId = normalizedUuid(input.jobId);
  const visitId = input.visitId == null ? null : normalizedUuid(input.visitId);
  if (!jobId) {
    return {
      error: failure(400, "INVALID_JOB_ID", "A valid Job ID is required."),
    };
  }
  if (input.visitId != null && !visitId) {
    return {
      error: failure(
        400,
        "INVALID_EVALUATION_VISIT_ID",
        "The Evaluation Visit ID is invalid."
      ),
    };
  }
  const idempotency = validateIdempotencyKey(input.idempotencyKey);
  if (idempotency.error) return idempotency;
  const content = validateEvaluationContent(input.content);
  if (content.error) return content;
  const boundaryError = validateOrdinaryEvaluationContent(content.content);
  if (boundaryError) return { error: boundaryError };
  if (input.expectedVersion != null && Number(input.expectedVersion) !== 0) {
    return {
      error: failure(
        409,
        "STALE_EVALUATION_VERSION",
        "The Evaluation version is no longer current."
      ),
    };
  }
  return {
    actorId: actor.id,
    jobId,
    visitId,
    idempotencyKey: idempotency.idempotencyKey,
    content: content.content,
  };
}

function validateCompletionContract(input) {
  const suppliedMode = input.completionMode == null
    ? null
    : String(input.completionMode).trim().toUpperCase();
  if (
    suppliedMode != null &&
    !Object.values(EVALUATION_COMPLETION_MODES).includes(suppliedMode)
  ) {
    return {
      error: failure(
        400,
        "INVALID_EVALUATION_COMPLETION_MODE",
        "The Evaluation completion mode is invalid."
      ),
    };
  }

  if (suppliedMode === EVALUATION_COMPLETION_MODES.REMOTE) {
    const assessmentMethod = input.assessmentMethod == null
      ? ""
      : String(input.assessmentMethod).trim().toUpperCase();
    if (!assessmentMethod) {
      return {
        error: failure(
          400,
          "REMOTE_EVALUATION_METHOD_REQUIRED",
          "A remote assessment method is required."
        ),
      };
    }
    if (!REMOTE_ASSESSMENT_METHOD_SET.has(assessmentMethod)) {
      return {
        error: failure(
          400,
          "INVALID_REMOTE_EVALUATION_METHOD",
          "The remote assessment method is invalid."
        ),
      };
    }
    if (input.assessmentBasis == null || typeof input.assessmentBasis !== "string") {
      return {
        error: failure(
          400,
          "REMOTE_EVALUATION_BASIS_REQUIRED",
          "A professional remote assessment basis is required."
        ),
      };
    }
    const assessmentBasis = input.assessmentBasis.trim();
    if (!assessmentBasis) {
      return {
        error: failure(
          400,
          "REMOTE_EVALUATION_BASIS_REQUIRED",
          "A professional remote assessment basis is required."
        ),
      };
    }
    if (assessmentBasis.length > 2000) {
      return {
        error: failure(
          400,
          "INVALID_REMOTE_EVALUATION_BASIS",
          "The remote assessment basis is too long."
        ),
      };
    }
    return {
      completionMode: suppliedMode,
      assessmentMethod,
      assessmentBasis,
    };
  }

  if (input.assessmentMethod != null || input.assessmentBasis != null) {
    return {
      error: failure(
        400,
        "REMOTE_EVALUATION_DETAILS_NOT_ALLOWED",
        "Remote assessment details require explicit REMOTE completion."
      ),
    };
  }
  return {
    completionMode: suppliedMode,
    assessmentMethod: null,
    assessmentBasis: null,
  };
}

function validateExistingInput(input, { requireContent, completion = false }) {
  const allowedFields = new Set([
    "pool",
    "authenticatedActor",
    "evaluationId",
    "expectedVersion",
    "idempotencyKey",
    "logger",
  ]);
  if (requireContent) allowedFields.add("content");
  if (completion) {
    allowedFields.add("completionMode");
    allowedFields.add("assessmentMethod");
    allowedFields.add("assessmentBasis");
  }
  const inputError = validateCommandInput(input, allowedFields);
  if (inputError) return { error: inputError };
  const actor = validateAuthenticatedActor(input.authenticatedActor);
  if (actor.error) return actor;
  const idempotency = validateIdempotencyKey(input.idempotencyKey);
  if (idempotency.error) return idempotency;
  const evaluationId = normalizedUuid(input.evaluationId);
  if (!evaluationId) {
    return {
      error: failure(
        400,
        "INVALID_EVALUATION_ID",
        "A valid Evaluation ID is required."
      ),
    };
  }
  const expectedVersion = positiveInteger(input.expectedVersion);
  if (!expectedVersion) {
    return {
      error: failure(
        400,
        "EVALUATION_EXPECTED_VERSION_REQUIRED",
        "The current Evaluation version is required."
      ),
    };
  }
  const content = requireContent ? validateEvaluationContent(input.content) : null;
  if (content?.error) return content;
  const completionContract = completion ? validateCompletionContract(input) : null;
  if (completionContract?.error) return completionContract;
  return {
    actorId: actor.id,
    idempotencyKey: idempotency.idempotencyKey,
    evaluationId,
    expectedVersion,
    content: content?.content,
    completionMode: completionContract?.completionMode || null,
    assessmentMethod: completionContract?.assessmentMethod || null,
    assessmentBasis: completionContract?.assessmentBasis || null,
  };
}

async function resolveEmergencyWriteContext(client, sourceContext, actorUserId) {
  const result = await client.query(
    `
    SELECT
      er.id AS emergency_request_id,
      er.homeowner_id,
      er.status AS emergency_status,
      er.arrived_at,
      rr.id AS relationship_id,
      rr.status AS relationship_status,
      rr.professional_user_id
    FROM emergency_requests AS er
    INNER JOIN request_relationships AS rr
      ON rr.emergency_request_id = er.id
      AND rr.post_id IS NULL
      AND rr.homeowner_id = er.homeowner_id
      AND rr.status = 'active'
    INNER JOIN contractor_profiles AS cp
      ON cp.id = rr.contractor_id
      AND cp.user_id = rr.professional_user_id
    WHERE er.id = $1
      AND rr.professional_user_id = $3
      AND cp.user_id = $3
      AND ($2::integer IS NULL OR rr.id = $2)
      AND er.arrived_at IS NOT NULL
      AND er.status = ANY($4::text[])
    ORDER BY rr.id ASC
    LIMIT 2
    FOR UPDATE OF er, rr
    `,
    [
      sourceContext.emergencyRequestId,
      sourceContext.relationshipId,
      actorUserId,
      ALLOWED_EMERGENCY_EVALUATION_STATUSES,
    ]
  );
  return result.rows.length === 1 ? result.rows[0] : null;
}

function safeLogger(value) {
  return value && typeof value.info === "function" && typeof value.warn === "function"
    ? value
    : console;
}

async function resolveOrdinaryJobContext(
  client,
  jobId,
  actorUserId,
  { lock = false } = {}
) {
  const result = await client.query(
    `
    /* ordinary_evaluation:job_context */
    SELECT
      jobs.id AS job_id,
      jobs.job_request_id,
      jobs.source_request_selection_id,
      jobs.source_request_relationship_id AS relationship_id,
      posts.user_id AS homeowner_id,
      posts.lifecycle_contract_version AS request_contract_version,
      request_relationships.professional_user_id,
      request_relationships.status AS relationship_status,
      relationship_participants.id AS actor_participant_id
    FROM jobs
    INNER JOIN posts
      ON posts.id = jobs.job_request_id
      AND posts.lifecycle_contract_version = 2
    INNER JOIN request_relationships
      ON request_relationships.id = jobs.source_request_relationship_id
      AND request_relationships.post_id = jobs.job_request_id
      AND request_relationships.emergency_request_id IS NULL
      AND request_relationships.homeowner_id = posts.user_id
      AND request_relationships.professional_user_id = $2
      AND request_relationships.status = 'active'
    INNER JOIN request_selections
      ON request_selections.id = jobs.source_request_selection_id
      AND request_selections.request_relationship_id =
        jobs.source_request_relationship_id
      AND request_selections.post_id = jobs.job_request_id
      AND request_selections.selected_by_user_id = posts.user_id
    INNER JOIN relationship_participants
      ON relationship_participants.job_id = jobs.id
      AND relationship_participants.request_relationship_id =
        jobs.source_request_relationship_id
      AND relationship_participants.user_id = $2
    WHERE jobs.id = $1
      AND jobs.lifecycle_contract_version = 2
    LIMIT 1
    ${lock ? "FOR UPDATE OF jobs, request_relationships" : ""}
    `,
    [jobId, actorUserId]
  );
  return result.rows[0] || null;
}

async function requireOrdinaryEvaluationAuthority({
  client,
  context,
  actorUserId,
  logger,
}) {
  if (!context) {
    logger.warn("Ordinary Evaluation authorization denied", {
      code: "ORDINARY_EVALUATION_CONTEXT_DENIED",
      actorUserId,
    });
    return failure(404, "EVALUATION_UNAVAILABLE", "The Evaluation is unavailable.");
  }
  const granted = await hasActiveLifecycleGrant({
    client,
    participantId: context.actor_participant_id,
    capability: ORDINARY_EVALUATION_CAPABILITY,
    jobId: context.job_id,
    logger,
  });
  if (!granted) {
    logger.warn("Ordinary Evaluation authorization denied", {
      code: "ORDINARY_EVALUATION_AUTHORITY_DENIED",
      actorUserId,
      jobId: context.job_id,
      relationshipId: Number(context.relationship_id),
      capability: ORDINARY_EVALUATION_CAPABILITY,
    });
    return failure(
      403,
      "EVALUATION_AUTHORITY_REQUIRED",
      "Evaluation authority is required."
    );
  }
  return null;
}

async function loadCompletedEvaluationVisit(
  client,
  { jobId, visitId, requireUnlinked = false, evaluationId = null, lock = false }
) {
  const result = await client.query(
    `
    /* ordinary_evaluation:completed_visit */
    SELECT
      visits.id AS visit_id,
      visits.job_id,
      visits.purpose,
      versions.version AS visit_version,
      versions.state AS visit_state,
      versions.completed_at,
      links.evaluation_id
    FROM canonical_visits visits
    INNER JOIN LATERAL (
      SELECT version, state, completed_at
      FROM canonical_visit_versions
      WHERE visit_id = visits.id AND job_id = visits.job_id
      ORDER BY version DESC
      LIMIT 1
    ) versions ON TRUE
    LEFT JOIN canonical_visit_evaluation_links links
      ON links.visit_id = visits.id
      AND links.job_id = visits.job_id
    WHERE visits.id = $1
      AND visits.job_id = $2
      AND visits.purpose = 'EVALUATION'
      AND versions.state = 'COMPLETED'
      AND versions.completed_at IS NOT NULL
      AND ($3::boolean = FALSE OR links.visit_id IS NULL)
      AND ($4::uuid IS NULL OR links.evaluation_id = $4)
    LIMIT 1
    ${lock ? "FOR UPDATE OF visits" : ""}
    `,
    [visitId, jobId, requireUnlinked === true, evaluationId]
  );
  return result.rows[0] || null;
}

async function loadEvaluationVisitForDraft(
  client,
  { jobId, visitId, lock = false }
) {
  const result = await client.query(
    `
    /* ordinary_evaluation:active_or_completed_visit */
    SELECT
      visits.id AS visit_id,
      visits.job_id,
      visits.purpose,
      versions.version AS visit_version,
      versions.state AS visit_state,
      versions.started_at,
      versions.completed_at,
      links.evaluation_id
    FROM canonical_visits visits
    INNER JOIN LATERAL (
      SELECT version, state, started_at, completed_at
      FROM canonical_visit_versions
      WHERE visit_id = visits.id AND job_id = visits.job_id
      ORDER BY version DESC
      LIMIT 1
    ) versions ON TRUE
    LEFT JOIN canonical_visit_evaluation_links links
      ON links.visit_id = visits.id
      AND links.job_id = visits.job_id
    WHERE visits.id = $1
      AND visits.job_id = $2
      AND visits.purpose = 'EVALUATION'
      AND (
        (versions.state = 'STARTED' AND versions.started_at IS NOT NULL)
        OR
        (versions.state = 'COMPLETED' AND versions.completed_at IS NOT NULL)
      )
      AND links.visit_id IS NULL
    LIMIT 1
    ${lock ? "FOR UPDATE OF visits" : ""}
    `,
    [visitId, jobId]
  );
  return result.rows[0] || null;
}

async function reserveVisitEvaluationLinkCommand({
  client,
  context,
  visitId,
  evaluationId,
  idempotencyKey,
}) {
  const requestFingerprint = fingerprint({
    command: "visit.link_evaluation",
    jobId: context.job_id,
    visitId,
    evaluationId,
  });
  const inserted = await client.query(
    `
    INSERT INTO canonical_visit_command_idempotency (
      id, actor_participant_id, job_id, command_name, command_scope,
      idempotency_key, request_fingerprint
    )
    VALUES ($1, $2, $3, 'visit.link_evaluation', $4, $5, $6)
    ON CONFLICT (
      actor_participant_id, command_name, command_scope, idempotency_key
    )
    DO NOTHING
    RETURNING *
    `,
    [
      randomUUID(),
      context.actor_participant_id,
      context.job_id,
      `visit:${visitId}:evaluation-link`,
      idempotencyKey,
      requestFingerprint,
    ]
  );
  if (inserted.rows[0]) return { reservation: inserted.rows[0] };
  const existing = await client.query(
    `SELECT *
     FROM canonical_visit_command_idempotency
     WHERE actor_participant_id = $1
       AND command_name = 'visit.link_evaluation'
       AND command_scope = $2
       AND idempotency_key = $3
     LIMIT 1
     FOR UPDATE`,
    [
      context.actor_participant_id,
      `visit:${visitId}:evaluation-link`,
      idempotencyKey,
    ]
  );
  const reservation = existing.rows[0];
  if (!reservation || reservation.request_fingerprint !== requestFingerprint) {
    return {
      error: failure(
        409,
        "VISIT_LINK_IDEMPOTENCY_KEY_CONFLICT",
        "The Evaluation Visit linkage key was already used differently."
      ),
    };
  }
  return { reservation, replay: reservation.result_reference || null };
}

async function completeVisitEvaluationLinkCommand(
  client,
  reservationId,
  { visitId, evaluationId, jobId }
) {
  const result = await client.query(
    `UPDATE canonical_visit_command_idempotency
     SET result_reference = $2::jsonb, completed_at = CURRENT_TIMESTAMP
     WHERE id = $1
       AND result_reference IS NULL
       AND completed_at IS NULL
     RETURNING id`,
    [
      reservationId,
      JSON.stringify({
        visitId,
        evaluationId,
        jobId,
        command: "visit.link_evaluation",
      }),
    ]
  );
  if (!result.rows[0]) {
    throw new Error("Evaluation Visit linkage idempotency completion failed.");
  }
}

async function requireCompletedEvaluationVisitEvidence({
  client,
  jobId,
  evaluationId,
}) {
  const result = await client.query(
    `
    /* ordinary_evaluation:completed_visit_evidence */
    SELECT links.visit_id
    FROM canonical_visit_evaluation_links links
    INNER JOIN canonical_visits visits
      ON visits.id = links.visit_id
      AND visits.job_id = links.job_id
      AND visits.purpose = 'EVALUATION'
    INNER JOIN LATERAL (
      SELECT state, completed_at
      FROM canonical_visit_versions
      WHERE visit_id = visits.id AND job_id = visits.job_id
      ORDER BY version DESC
      LIMIT 1
    ) versions ON TRUE
    WHERE links.evaluation_id = $1
      AND links.job_id = $2
      AND versions.state = 'COMPLETED'
      AND versions.completed_at IS NOT NULL
    LIMIT 1
    `,
    [evaluationId, jobId]
  );
  return result.rows[0] || null;
}

async function loadOrdinaryEvaluationProvenance({
  client,
  evaluationId,
  jobId,
}) {
  const result = await client.query(
    `SELECT
       EXISTS (
         SELECT 1
         FROM canonical_visit_evaluation_links links
         WHERE links.evaluation_id = $1
           AND links.job_id = $2
       ) AS has_physical_link,
       EXISTS (
         SELECT 1
         FROM canonical_evaluation_remote_provenance remote
         WHERE remote.evaluation_id = $1
           AND remote.job_id = $2
       ) AS has_remote_provenance`,
    [evaluationId, jobId]
  );
  return result.rows[0] || {
    has_physical_link: false,
    has_remote_provenance: false,
  };
}

async function insertRemoteEvaluationProvenance({
  client,
  evaluationId,
  evaluationVersion,
  jobId,
  professionalParticipantId,
  assessmentMethod,
  assessmentBasis,
  completionCommandId,
}) {
  const result = await client.query(
    `INSERT INTO canonical_evaluation_remote_provenance (
       id, evaluation_id, evaluation_version, job_id,
       professional_participant_id, assessment_method, assessment_basis,
       completion_command_idempotency_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING assessment_method, assessment_basis`,
    [
      randomUUID(),
      evaluationId,
      evaluationVersion,
      jobId,
      professionalParticipantId,
      assessmentMethod,
      assessmentBasis,
      completionCommandId,
    ]
  );
  return result.rows[0] || null;
}

function evaluationProvenanceFailure(error, completionMode) {
  if (!error) return null;
  const message = String(error.message || "");
  const constraint = String(error.constraint || "");
  const isXorConflict =
    /Physical and remote Evaluation provenance are mutually exclusive/i.test(message) ||
    constraint === "canonical_evaluation_provenance_claims_pkey";
  if (!isXorConflict) return null;
  if (completionMode === EVALUATION_COMPLETION_MODES.REMOTE) {
    return failure(
      409,
      "REMOTE_EVALUATION_PHYSICAL_PROVENANCE_CONFLICT",
      "Remote completion conflicts with the Evaluation's physical Visit record."
    );
  }
  return failure(
    409,
    "PHYSICAL_EVALUATION_REMOTE_PROVENANCE_CONFLICT",
    "Physical completion conflicts with the Evaluation's remote assessment record."
  );
}

function parseArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function contentFromRow(row) {
  return {
    serviceType: row.service_type || null,
    evaluationContext: row.evaluation_context || null,
    templateKey: row.template_key || null,
    observations: row.observations || "",
    measurements: parseArray(row.measurements),
    findings: parseArray(row.findings),
    diagnosisSummary: row.diagnosis_summary || "",
    limitations: row.limitations || "",
    scopeRecommendations: parseArray(row.scope_recommendations),
    relevantConditions: parseArray(row.relevant_conditions),
    supportingMediaReferences: parseArray(row.supporting_media_references),
    internalNotes: row.internal_notes || "",
  };
}

function sourceContextFromRow(row) {
  if (row.source_context_type === "ordinary_request" || row.job_id) {
    return {
      type: "ordinary_job",
      jobId: row.job_id,
      requestId: Number(row.ordinary_request_id || row.job_request_id),
      relationshipId: Number(row.relationship_id),
      evaluationVisitId: row.evaluation_visit_id || null,
    };
  }
  return {
    type: "emergency_request",
    emergencyRequestId: Number(row.emergency_request_id),
    relationshipId: Number(row.relationship_id),
  };
}

function evaluationProjection(row) {
  const status = row.evaluation_status || row.status;
  const ordinaryEvaluation =
    row.source_context_type === "ordinary_request" || Boolean(row.job_id);
  const physicalProvenanceAvailable = Boolean(row.evaluation_visit_id);
  const completionMode = status === EVALUATION_STATUS.COMPLETED
    ? row.remote_assessment_method
      ? EVALUATION_COMPLETION_MODES.REMOTE
      : physicalProvenanceAvailable
        ? EVALUATION_COMPLETION_MODES.PHYSICAL
        : null
    : null;
  const projection = {
    authoritySource: AUTHORITY_SOURCE,
    confirmed: true,
    aggregate: {
      id: row.evaluation_id || row.id,
      type: "evaluation",
      owningEngine: OWNING_ENGINE,
      version: Number(row.current_version || row.version),
      sourceContext: sourceContextFromRow(row),
    },
    evaluation: {
      id: row.evaluation_id || row.id,
      status,
      createdAt: row.evaluation_created_at || row.created_at,
      updatedAt: row.evaluation_updated_at || row.updated_at,
      completedAt: row.completed_at || null,
      completionMode,
      content: contentFromRow(row),
      capabilities: {
        canEditDraft: status === EVALUATION_STATUS.DRAFT,
        canComplete:
          status === EVALUATION_STATUS.DRAFT &&
          (!ordinaryEvaluation || physicalProvenanceAvailable),
        canRevise: status === EVALUATION_STATUS.COMPLETED,
        canShareWithCustomer: false,
        quoteReady: false,
        authorizationAvailable: false,
        startWorkAvailable: false,
      },
      traceability: {
        governingCharterId: TRACEABILITY.governingCharterId,
        governingProgramId: TRACEABILITY.governingProgramId,
        foundationMilestoneId: TRACEABILITY.implementationMilestoneId,
        capabilityMilestoneId: CAPABILITY_MILESTONE_ID,
        certificationTarget: TRACEABILITY.certificationTarget,
      },
    },
  };
  if (row.source_context_type === "ordinary_request" || row.job_id) {
    projection.evaluation.reportedConcerns = parseArray(row.reported_concerns).map(
      (concern) => ({
        id: concern.id,
        originalText: concern.originalText,
        reportedAt: concern.reportedAt,
        sequence: Number(concern.sequence),
      })
    );
    if (completionMode === EVALUATION_COMPLETION_MODES.REMOTE) {
      projection.evaluation.assessmentMethod = row.remote_assessment_method;
      projection.evaluation.assessmentBasis = row.remote_assessment_basis;
    }
  }
  return projection;
}

function successResult({ status, code, row, evidenceType, replayed = false }) {
  return {
    ok: true,
    success: true,
    status,
    code,
    replayed,
    ...evaluationProjection(row),
    evidence: {
      type: evidenceType,
      aggregateVersion: Number(row.current_version || row.version),
      capabilityMilestoneId: CAPABILITY_MILESTONE_ID,
    },
  };
}

function evidenceSummary(content, status) {
  return {
    schemaVersion: 1,
    status,
    measurementCount: content.measurements.length,
    findingCount: content.findings.length,
    scopeRecommendationCount: content.scopeRecommendations.length,
    hasObservations: Boolean(content.observations),
    hasDiagnosisSummary: Boolean(content.diagnosisSummary),
    hasLimitations: Boolean(content.limitations),
    hasInternalNotes: Boolean(content.internalNotes),
    supportingMediaReferenceCount: 0,
  };
}

async function insertVersion({ client, evaluationId, version, status, content, actorId }) {
  const result = await client.query(
    `
    INSERT INTO canonical_evaluation_versions
    (
      evaluation_id,
      version,
      status,
      service_type,
      evaluation_context,
      template_key,
      observations,
      measurements,
      findings,
      diagnosis_summary,
      limitations,
      scope_recommendations,
      relevant_conditions,
      supporting_media_references,
      internal_notes,
      created_by_user_id
    )
    VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11,
      $12::jsonb, $13::jsonb, $14::jsonb, $15, $16
    )
    RETURNING *
    `,
    [
      evaluationId,
      version,
      status,
      content.serviceType,
      content.evaluationContext,
      content.templateKey,
      content.observations,
      JSON.stringify(content.measurements),
      JSON.stringify(content.findings),
      content.diagnosisSummary,
      content.limitations,
      JSON.stringify(content.scopeRecommendations),
      JSON.stringify(content.relevantConditions),
      "[]",
      content.internalNotes,
      actorId,
    ]
  );
  return result.rows[0] || null;
}

async function insertEvaluationEvidence({
  client,
  aggregate,
  context,
  actorId,
  idempotencyId,
  evidenceType,
  commandName,
  previousVersion,
  resultingVersion,
  content,
  status,
}) {
  const result = await client.query(
    `
    INSERT INTO commercial_authority_evidence
    (
      id,
      aggregate_id,
      aggregate_type,
      owning_engine,
      evidence_type,
      actor_user_id,
      actor_role,
      relationship_id,
      previous_version,
      resulting_version,
      idempotency_id,
      evidence_payload,
      source_command,
      governing_charter_id,
      governing_program_id,
      implementation_milestone_id,
      capability_milestone_id,
      certification_target
    )
    VALUES (
      $1, $2, 'evaluation', $3, $4, $5, 'professional', $6, $7, $8, $9,
      $10::jsonb, $11, $12, $13, $14, $15, $16
    )
    RETURNING id
    `,
    [
      randomUUID(),
      aggregate.id,
      OWNING_ENGINE,
      evidenceType,
      actorId,
      Number(context.relationship_id),
      previousVersion,
      resultingVersion,
      idempotencyId,
      JSON.stringify(evidenceSummary(content, status)),
      commandName,
      TRACEABILITY.governingCharterId,
      TRACEABILITY.governingProgramId,
      TRACEABILITY.implementationMilestoneId,
      CAPABILITY_MILESTONE_ID,
      TRACEABILITY.certificationTarget,
    ]
  );
  return result.rows[0] || null;
}

function combinedRow({
  aggregate,
  evaluation,
  version,
  context,
  visitId = null,
  remoteProvenance = null,
}) {
  return {
    evaluation_id: aggregate.id,
    current_version: aggregate.current_version,
    emergency_request_id: context.emergency_request_id,
    ordinary_request_id: context.job_request_id || null,
    source_context_type:
      context.job_id ? "ordinary_request" : "emergency_request",
    job_id: context.job_id || null,
    job_request_id: context.job_request_id || null,
    relationship_id: context.relationship_id,
    evaluation_visit_id: visitId,
    remote_assessment_method: remoteProvenance?.assessment_method || null,
    remote_assessment_basis: remoteProvenance?.assessment_basis || null,
    evaluation_status: evaluation.status,
    evaluation_created_at: evaluation.created_at,
    evaluation_updated_at: evaluation.updated_at,
    completed_at: evaluation.completed_at,
    ...version,
  };
}

async function loadEvaluation(client, evaluationId, actorUserId, { lock = false } = {}) {
  const result = await client.query(
    `
    SELECT
      a.id AS evaluation_id,
      a.current_version,
      a.source_context_type,
      a.ordinary_request_id,
      a.emergency_request_id,
      a.relationship_id,
      ordinary_subject.job_id,
      ordinary_subject.job_request_id,
      ordinary_visit_link.visit_id AS evaluation_visit_id,
      remote_provenance.assessment_method AS remote_assessment_method,
      remote_provenance.assessment_basis AS remote_assessment_basis,
      actor_participant.id AS actor_participant_id,
      CASE
        WHEN a.source_context_type = 'ordinary_request' THEN COALESCE(
          (
            SELECT jsonb_agg(
              jsonb_build_object(
                'id', reported_concerns.id,
                'originalText', reported_concerns.original_text,
                'reportedAt', reported_concerns.reported_at,
                'sequence', reported_concerns.sequence
              )
              ORDER BY reported_concerns.sequence ASC,
                reported_concerns.reported_at ASC,
                reported_concerns.id ASC
            )
            FROM reported_concerns
            WHERE reported_concerns.job_request_id = a.ordinary_request_id
          ),
          '[]'::jsonb
        )
        ELSE NULL
      END AS reported_concerns,
      ce.status AS evaluation_status,
      ce.created_at AS evaluation_created_at,
      ce.updated_at AS evaluation_updated_at,
      ce.completed_at,
      cev.service_type,
      cev.evaluation_context,
      cev.template_key,
      cev.observations,
      cev.measurements,
      cev.findings,
      cev.diagnosis_summary,
      cev.limitations,
      cev.scope_recommendations,
      cev.relevant_conditions,
      cev.supporting_media_references,
      cev.internal_notes
    FROM commercial_authority_aggregates AS a
    INNER JOIN canonical_evaluations AS ce
      ON ce.id = a.id
      AND ce.professional_user_id = $2
    INNER JOIN canonical_evaluation_versions AS cev
      ON cev.evaluation_id = ce.id
      AND cev.version = a.current_version
    INNER JOIN request_relationships AS rr
      ON rr.id = ce.relationship_id
      AND rr.id = a.relationship_id
      AND rr.professional_user_id = ce.professional_user_id
    LEFT JOIN emergency_requests AS er
      ON er.id = a.emergency_request_id
      AND er.homeowner_id = rr.homeowner_id
      AND er.homeowner_id = a.source_owner_user_id
    LEFT JOIN canonical_evaluation_job_subjects AS ordinary_subject
      ON ordinary_subject.evaluation_id = a.id
      AND ordinary_subject.relationship_id = a.relationship_id
      AND ordinary_subject.job_request_id = a.ordinary_request_id
    LEFT JOIN canonical_visit_evaluation_links AS ordinary_visit_link
      ON ordinary_visit_link.evaluation_id = ordinary_subject.evaluation_id
      AND ordinary_visit_link.job_id = ordinary_subject.job_id
    LEFT JOIN canonical_evaluation_remote_provenance AS remote_provenance
      ON remote_provenance.evaluation_id = ordinary_subject.evaluation_id
      AND remote_provenance.job_id = ordinary_subject.job_id
    LEFT JOIN jobs AS ordinary_job
      ON ordinary_job.id = ordinary_subject.job_id
      AND ordinary_job.job_request_id = ordinary_subject.job_request_id
      AND ordinary_job.source_request_relationship_id =
        ordinary_subject.relationship_id
      AND ordinary_job.lifecycle_contract_version = 2
    LEFT JOIN posts AS ordinary_post
      ON ordinary_post.id = ordinary_job.job_request_id
      AND ordinary_post.lifecycle_contract_version = 2
      AND ordinary_post.user_id = a.source_owner_user_id
    LEFT JOIN relationship_participants AS actor_participant
      ON actor_participant.job_id = ordinary_job.id
      AND actor_participant.request_relationship_id = rr.id
      AND actor_participant.user_id = $2
    WHERE a.id = $1
      AND a.aggregate_type = 'evaluation'
      AND a.owning_engine = $3
      AND (
        (
          a.source_context_type = 'emergency_request'
          AND rr.emergency_request_id = a.emergency_request_id
          AND rr.post_id IS NULL
          AND er.id IS NOT NULL
        )
        OR
        (
          a.source_context_type = 'ordinary_request'
          AND rr.post_id = a.ordinary_request_id
          AND rr.emergency_request_id IS NULL
          AND ordinary_job.id IS NOT NULL
          AND ordinary_post.id IS NOT NULL
          AND actor_participant.id IS NOT NULL
        )
      )
    LIMIT 1
    ${lock ? "FOR UPDATE OF a, ce, rr" : ""}
    `,
    [evaluationId, actorUserId, OWNING_ENGINE]
  );
  return result.rows[0] || null;
}

async function createEvaluation(input = {}) {
  const validated = validateCreateInput(input);
  if (validated.error) return validated.error;
  const client = await databaseClient(input.pool);
  let transactionStarted = false;

  try {
    await client.query("BEGIN");
    transactionStarted = true;
    const requestFingerprint = fingerprint({
      command: EVALUATION_COMMANDS.CREATE,
      expectedVersion: 0,
      sourceContext: validated.sourceContext,
      content: validated.content,
    });
    const idempotency = await reserveIdempotency({
      client,
      actorUserId: validated.actorId,
      commandName: EVALUATION_COMMANDS.CREATE,
      commandScope: `evaluation:create:emergency:${validated.sourceContext.emergencyRequestId}:relationship:${validated.sourceContext.relationshipId}`,
      idempotencyKey: validated.idempotencyKey,
      requestFingerprint,
    });
    if (idempotency.error) {
      await rollback(client);
      transactionStarted = false;
      return idempotency.error;
    }
    if (idempotency.replay) {
      await client.query("COMMIT");
      transactionStarted = false;
      return { ...idempotency.replay, replayed: true };
    }

    const context = await resolveEmergencyWriteContext(
      client,
      validated.sourceContext,
      validated.actorId
    );
    if (!context) {
      await rollback(client);
      transactionStarted = false;
      return failure(
        404,
        "EVALUATION_UNAVAILABLE",
        "The Evaluation is unavailable."
      );
    }

    const existing = await client.query(
      `
      SELECT id
      FROM canonical_evaluations
      WHERE relationship_id = $1
        AND professional_user_id = $2
      LIMIT 1
      FOR UPDATE
      `,
      [Number(context.relationship_id), validated.actorId]
    );
    if (existing.rows[0]) {
      await rollback(client);
      transactionStarted = false;
      return failure(
        409,
        "EVALUATION_ALREADY_EXISTS",
        "A canonical Evaluation already exists for this relationship."
      );
    }

    const evaluationId = randomUUID();
    const aggregateResult = await client.query(
      `
      INSERT INTO commercial_authority_aggregates
      (
        id,
        aggregate_type,
        owning_engine,
        source_context_type,
        ordinary_request_id,
        emergency_request_id,
        relationship_id,
        source_owner_user_id,
        created_by_user_id,
        current_version
      )
      VALUES ($1, 'evaluation', $2, 'emergency_request', NULL, $3, $4, $5, $6, 1)
      RETURNING *
      `,
      [
        evaluationId,
        OWNING_ENGINE,
        Number(context.emergency_request_id),
        Number(context.relationship_id),
        Number(context.homeowner_id),
        validated.actorId,
      ]
    );
    const aggregate = aggregateResult.rows[0];
    if (!aggregate) throw new Error("Canonical Evaluation aggregate creation failed.");

    const evaluationResult = await client.query(
      `
      INSERT INTO canonical_evaluations
      (id, relationship_id, professional_user_id, status)
      VALUES ($1, $2, $3, 'draft')
      RETURNING *
      `,
      [evaluationId, Number(context.relationship_id), validated.actorId]
    );
    const evaluation = evaluationResult.rows[0];
    const version = await insertVersion({
      client,
      evaluationId,
      version: 1,
      status: EVALUATION_STATUS.DRAFT,
      content: validated.content,
      actorId: validated.actorId,
    });
    if (!evaluation || !version) {
      throw new Error("Canonical Evaluation content creation failed.");
    }

    const evidence = await insertEvaluationEvidence({
      client,
      aggregate,
      context,
      actorId: validated.actorId,
      idempotencyId: idempotency.reservation.id,
      evidenceType: EVALUATION_EVIDENCE_TYPES.CREATED,
      commandName: EVALUATION_COMMANDS.CREATE,
      previousVersion: 0,
      resultingVersion: 1,
      content: validated.content,
      status: EVALUATION_STATUS.DRAFT,
    });
    if (!evidence) throw new Error("Canonical Evaluation evidence creation failed.");

    const row = combinedRow({ aggregate, evaluation, version, context });
    const result = successResult({
      status: 201,
      code: "EVALUATION_CREATED",
      row,
      evidenceType: EVALUATION_EVIDENCE_TYPES.CREATED,
    });
    if (
      !(await completeIdempotency(
        client,
        idempotency.reservation.id,
        evaluationId,
        result
      ))
    ) {
      throw new Error("Canonical Evaluation idempotency completion failed.");
    }

    await client.query("COMMIT");
    transactionStarted = false;
    return result;
  } catch (error) {
    if (transactionStarted) await rollback(client);
    throw error;
  } finally {
    if (client !== input.pool && typeof client.release === "function") client.release();
  }
}

async function createOrdinaryJobEvaluation(input = {}) {
  const validated = validateOrdinaryCreateInput(input);
  if (validated.error) return validated.error;
  const logger = safeLogger(input.logger);
  const client = await databaseClient(input.pool);
  let transactionStarted = false;

  try {
    await client.query("BEGIN");
    transactionStarted = true;
    const context = await resolveOrdinaryJobContext(
      client,
      validated.jobId,
      validated.actorId,
      { lock: true }
    );
    const authorityError = await requireOrdinaryEvaluationAuthority({
      client,
      context,
      actorUserId: validated.actorId,
      logger,
    });
    if (authorityError) {
      await rollback(client);
      transactionStarted = false;
      return authorityError;
    }

    const requestFingerprint = fingerprint({
      command: EVALUATION_COMMANDS.CREATE,
      expectedVersion: 0,
      jobId: validated.jobId,
      visitId: validated.visitId,
      content: validated.content,
    });
    const idempotency = await reserveIdempotency({
      client,
      actorUserId: validated.actorId,
      commandName: EVALUATION_COMMANDS.CREATE,
      commandScope: `evaluation:create:job:${validated.jobId}`,
      idempotencyKey: validated.idempotencyKey,
      requestFingerprint,
    });
    if (idempotency.error) {
      await rollback(client);
      transactionStarted = false;
      return idempotency.error;
    }
    if (idempotency.replay) {
      await client.query("COMMIT");
      transactionStarted = false;
      logger.info("Ordinary Evaluation idempotency replayed", {
        code: "ORDINARY_EVALUATION_IDEMPOTENCY_REPLAYED",
        actorUserId: validated.actorId,
        jobId: validated.jobId,
        evaluationId: idempotency.replay.evaluation?.id || null,
      });
      return { ...idempotency.replay, replayed: true };
    }

    const evaluationVisit = validated.visitId
      ? await loadEvaluationVisitForDraft(client, {
          jobId: validated.jobId,
          visitId: validated.visitId,
          lock: true,
        })
      : null;
    if (validated.visitId && !evaluationVisit) {
      await rollback(client);
      transactionStarted = false;
      return failure(
        409,
        "STARTED_EVALUATION_VISIT_REQUIRED",
        "Start the Evaluation Visit before documenting the onsite assessment."
      );
    }
    const completedVisit = evaluationVisit?.visit_state === "COMPLETED"
      ? evaluationVisit
      : null;

    const existing = await client.query(
      `
      SELECT id
      FROM canonical_evaluations
      WHERE relationship_id = $1
        AND professional_user_id = $2
      LIMIT 1
      FOR UPDATE
      `,
      [Number(context.relationship_id), validated.actorId]
    );
    if (existing.rows[0]) {
      await rollback(client);
      transactionStarted = false;
      return failure(
        409,
        "EVALUATION_ALREADY_EXISTS",
        "A canonical Evaluation already exists for this relationship."
      );
    }

    const evaluationId = randomUUID();
    const aggregateResult = await client.query(
      `
      INSERT INTO commercial_authority_aggregates
      (
        id,
        aggregate_type,
        owning_engine,
        source_context_type,
        ordinary_request_id,
        emergency_request_id,
        relationship_id,
        source_owner_user_id,
        created_by_user_id,
        current_version
      )
      VALUES ($1, 'evaluation', $2, 'ordinary_request', $3, NULL, $4, $5, $6, 1)
      RETURNING *
      `,
      [
        evaluationId,
        OWNING_ENGINE,
        Number(context.job_request_id),
        Number(context.relationship_id),
        Number(context.homeowner_id),
        validated.actorId,
      ]
    );
    const aggregate = aggregateResult.rows[0];
    if (!aggregate) throw new Error("Canonical Evaluation aggregate creation failed.");

    const evaluationResult = await client.query(
      `
      INSERT INTO canonical_evaluations
      (id, relationship_id, professional_user_id, status)
      VALUES ($1, $2, $3, 'draft')
      RETURNING *
      `,
      [evaluationId, Number(context.relationship_id), validated.actorId]
    );
    const evaluation = evaluationResult.rows[0];
    const version = await insertVersion({
      client,
      evaluationId,
      version: 1,
      status: EVALUATION_STATUS.DRAFT,
      content: validated.content,
      actorId: validated.actorId,
    });
    const subjectResult = await client.query(
      `
      INSERT INTO canonical_evaluation_job_subjects
      (evaluation_id, job_id, job_request_id, relationship_id)
      VALUES ($1, $2, $3, $4)
      RETURNING evaluation_id
      `,
      [
        evaluationId,
        context.job_id,
        Number(context.job_request_id),
        Number(context.relationship_id),
      ]
    );
    if (!evaluation || !version || !subjectResult.rows[0]) {
      throw new Error("Canonical ordinary Evaluation creation failed.");
    }

    if (completedVisit) {
      const linkCommand = await reserveVisitEvaluationLinkCommand({
        client,
        context,
        visitId: completedVisit.visit_id,
        evaluationId,
        idempotencyKey: validated.idempotencyKey,
      });
      if (linkCommand.error || linkCommand.replay) {
        throw new Error("Canonical Evaluation Visit linkage reservation failed.");
      }
      const linkResult = await client.query(
        `INSERT INTO canonical_visit_evaluation_links (
           visit_id, job_id, evaluation_id,
           linked_by_participant_id, command_idempotency_id
         ) VALUES ($1, $2, $3, $4, $5)
         RETURNING visit_id`,
        [
          completedVisit.visit_id,
          context.job_id,
          evaluationId,
          context.actor_participant_id,
          linkCommand.reservation.id,
        ]
      );
      if (!linkResult.rows[0]) {
        throw new Error("Canonical Evaluation Visit linkage failed.");
      }
      await completeVisitEvaluationLinkCommand(
        client,
        linkCommand.reservation.id,
        {
          visitId: completedVisit.visit_id,
          evaluationId,
          jobId: context.job_id,
        }
      );
    }

    const evidence = await insertEvaluationEvidence({
      client,
      aggregate,
      context,
      actorId: validated.actorId,
      idempotencyId: idempotency.reservation.id,
      evidenceType: EVALUATION_EVIDENCE_TYPES.CREATED,
      commandName: EVALUATION_COMMANDS.CREATE,
      previousVersion: 0,
      resultingVersion: 1,
      content: validated.content,
      status: EVALUATION_STATUS.DRAFT,
    });
    if (!evidence) throw new Error("Canonical Evaluation evidence creation failed.");

    const row = combinedRow({
      aggregate,
      evaluation,
      version,
      context,
      visitId: completedVisit?.visit_id || null,
    });
    const result = successResult({
      status: 201,
      code: "EVALUATION_CREATED",
      row,
      evidenceType: EVALUATION_EVIDENCE_TYPES.CREATED,
    });
    if (
      !(await completeIdempotency(
        client,
        idempotency.reservation.id,
        evaluationId,
        result
      ))
    ) {
      throw new Error("Canonical Evaluation idempotency completion failed.");
    }

    await client.query("COMMIT");
    transactionStarted = false;
    logger.info("Ordinary Evaluation created", {
      code: "ORDINARY_EVALUATION_CREATED",
      actorUserId: validated.actorId,
      jobId: validated.jobId,
      relationshipId: Number(context.relationship_id),
      evaluationId,
      version: 1,
    });
    return result;
  } catch (error) {
    if (transactionStarted) await rollback(client);
    throw error;
  } finally {
    if (client !== input.pool && typeof client.release === "function") client.release();
  }
}

async function mutateEvaluation(
  input,
  { completion = false, revision = false } = {}
) {
  if (completion && revision) {
    throw new TypeError(
      "Evaluation completion and revision cannot run in one command."
    );
  }

  const validated = validateExistingInput(input, {
    requireContent: !completion,
    completion,
  });
  if (validated.error) return validated.error;
  const logger = safeLogger(input.logger);
  const commandName = completion
    ? EVALUATION_COMMANDS.COMPLETE
    : revision
      ? EVALUATION_COMMANDS.REVISE
      : EVALUATION_COMMANDS.UPDATE_DRAFT;
  const evidenceType = completion
    ? EVALUATION_EVIDENCE_TYPES.COMPLETED
    : revision
      ? EVALUATION_EVIDENCE_TYPES.REVISED
      : EVALUATION_EVIDENCE_TYPES.DRAFT_UPDATED;
  const client = await databaseClient(input.pool);
  let transactionStarted = false;
  let effectiveCompletionMode = validated.completionMode;

  try {
    await client.query("BEGIN");
    transactionStarted = true;
    const requestFingerprint = fingerprint({
      command: commandName,
      evaluationId: validated.evaluationId,
      expectedVersion: validated.expectedVersion,
      ...(completion
        ? {
            completionMode:
              validated.completionMode || EVALUATION_COMPLETION_MODES.PHYSICAL,
            assessmentMethod: validated.assessmentMethod,
            assessmentBasis: validated.assessmentBasis,
          }
        : { content: validated.content }),
    });
    const idempotency = await reserveIdempotency({
      client,
      actorUserId: validated.actorId,
      commandName,
      commandScope: `evaluation:${validated.evaluationId}`,
      idempotencyKey: validated.idempotencyKey,
      requestFingerprint,
    });
    if (idempotency.error) {
      await rollback(client);
      transactionStarted = false;
      return idempotency.error;
    }
    if (idempotency.replay) {
      const replaySource = idempotency.replay.aggregate?.sourceContext;
      if (replaySource?.type === "ordinary_job") {
        const replayContext = await resolveOrdinaryJobContext(
          client,
          replaySource.jobId,
          validated.actorId,
          { lock: true }
        );
        const replayAuthorityError = await requireOrdinaryEvaluationAuthority({
          client,
          context: replayContext,
          actorUserId: validated.actorId,
          logger,
        });
        if (replayAuthorityError) {
          await rollback(client);
          transactionStarted = false;
          return replayAuthorityError;
        }
      }
      await client.query("COMMIT");
      transactionStarted = false;
      if (replaySource?.type === "ordinary_job") {
        logger.info("Ordinary Evaluation idempotency replayed", {
          code: "ORDINARY_EVALUATION_IDEMPOTENCY_REPLAYED",
          actorUserId: validated.actorId,
          jobId: replaySource.jobId,
          evaluationId: validated.evaluationId,
        });
      }
      return { ...idempotency.replay, replayed: true };
    }

    const current = await loadEvaluation(
      client,
      validated.evaluationId,
      validated.actorId,
      { lock: true }
    );
    if (!current) {
      await rollback(client);
      transactionStarted = false;
      return failure(404, "EVALUATION_UNAVAILABLE", "The Evaluation is unavailable.");
    }
    const sourceContext = sourceContextFromRow(current);
    let context;
    if (sourceContext.type === "ordinary_job") {
      context = await resolveOrdinaryJobContext(
        client,
        sourceContext.jobId,
        validated.actorId,
        { lock: true }
      );
      const authorityError = await requireOrdinaryEvaluationAuthority({
        client,
        context,
        actorUserId: validated.actorId,
        logger,
      });
      if (authorityError) {
        await rollback(client);
        transactionStarted = false;
        return authorityError;
      }
      if (completion) {
        effectiveCompletionMode =
          validated.completionMode || EVALUATION_COMPLETION_MODES.PHYSICAL;
        const provenance = await loadOrdinaryEvaluationProvenance({
          client,
          evaluationId: validated.evaluationId,
          jobId: context.job_id,
        });
        if (effectiveCompletionMode === EVALUATION_COMPLETION_MODES.PHYSICAL) {
          if (provenance.has_remote_provenance) {
            await rollback(client);
            transactionStarted = false;
            return failure(
              409,
              "PHYSICAL_EVALUATION_REMOTE_PROVENANCE_CONFLICT",
              "Physical completion conflicts with the Evaluation's remote assessment record."
            );
          }
          if (
            !(await requireCompletedEvaluationVisitEvidence({
              client,
              jobId: context.job_id,
              evaluationId: validated.evaluationId,
            }))
          ) {
            await rollback(client);
            transactionStarted = false;
            return failure(
              409,
              "COMPLETED_EVALUATION_VISIT_REQUIRED",
              "Completed Evaluation Visit provenance is required before completing the Evaluation."
            );
          }
        } else if (provenance.has_physical_link) {
          await rollback(client);
          transactionStarted = false;
          return failure(
            409,
            "REMOTE_EVALUATION_PHYSICAL_PROVENANCE_CONFLICT",
            "Remote completion conflicts with the Evaluation's physical Visit record."
          );
        } else if (provenance.has_remote_provenance) {
          await rollback(client);
          transactionStarted = false;
          return failure(
            409,
            "EVALUATION_COMPLETED",
            "The Evaluation is already completed."
          );
        }
      }
    } else {
      context = await resolveEmergencyWriteContext(
        client,
        sourceContext,
        validated.actorId
      );
      if (!context) {
        await rollback(client);
        transactionStarted = false;
        return failure(404, "EVALUATION_UNAVAILABLE", "The Evaluation is unavailable.");
      }
      if (completion && validated.completionMode != null) {
        await rollback(client);
        transactionStarted = false;
        return failure(
          409,
          "EVALUATION_COMPLETION_MODE_UNAVAILABLE",
          "This Evaluation does not use ordinary physical or remote completion."
        );
      }
    }
    if (
      completion &&
      current.evaluation_status !== EVALUATION_STATUS.DRAFT
    ) {
      await rollback(client);
      transactionStarted = false;
      return failure(
        409,
        "EVALUATION_COMPLETED",
        "The Evaluation is already completed."
      );
    }

    if (
      !completion &&
      !revision &&
      current.evaluation_status !== EVALUATION_STATUS.DRAFT
    ) {
      await rollback(client);
      transactionStarted = false;
      return failure(
        409,
        "EVALUATION_COMPLETED",
        "A completed Evaluation must use Evaluation revision authority."
      );
    }

    if (
      revision &&
      current.evaluation_status !== EVALUATION_STATUS.COMPLETED
    ) {
      await rollback(client);
      transactionStarted = false;
      return failure(
        409,
        "EVALUATION_REVISION_REQUIRES_COMPLETED",
        "Only a completed Evaluation can be revised."
      );
    }

    if (Number(current.current_version) !== validated.expectedVersion) {
      await rollback(client);
      transactionStarted = false;
      return failure(
        409,
        "STALE_EVALUATION_VERSION",
        "The Evaluation version is no longer current."
      );
    }

    const content = completion ? contentFromRow(current) : validated.content;
    if (sourceContext.type === "ordinary_job") {
      const boundaryError = validateOrdinaryEvaluationContent(content);
      if (boundaryError) {
        await rollback(client);
        transactionStarted = false;
        return boundaryError;
      }
    }
    if (completion) {
      const completionError = sourceContext.type === "ordinary_job"
        ? validateOrdinaryCompletionContent(content)
        : validateCompletionContent(content);
      if (completionError) {
        await rollback(client);
        transactionStarted = false;
        return completionError;
      }
    }
    const nextVersion = validated.expectedVersion + 1;
    const aggregateResult = await client.query(
      `
      UPDATE commercial_authority_aggregates
      SET current_version = $2, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
        AND current_version = $3
        AND aggregate_type = 'evaluation'
        AND owning_engine = $4
      RETURNING *
      `,
      [validated.evaluationId, nextVersion, validated.expectedVersion, OWNING_ENGINE]
    );
    const aggregate = aggregateResult.rows[0];
    if (!aggregate) {
      await rollback(client);
      transactionStarted = false;
      return failure(
        409,
        "STALE_EVALUATION_VERSION",
        "The Evaluation version is no longer current."
      );
    }

    const evaluationResult = await client.query(
      completion
        ? `
          UPDATE canonical_evaluations
          SET
            status = 'completed',
            updated_at = CURRENT_TIMESTAMP,
            completed_at = CURRENT_TIMESTAMP
          WHERE id = $1
            AND professional_user_id = $2
            AND status = 'draft'
          RETURNING *
          `
        : revision
          ? `
            UPDATE canonical_evaluations
            SET updated_at = CURRENT_TIMESTAMP
            WHERE id = $1
              AND professional_user_id = $2
              AND status = 'completed'
            RETURNING *
            `
          : `
            UPDATE canonical_evaluations
            SET updated_at = CURRENT_TIMESTAMP
            WHERE id = $1
              AND professional_user_id = $2
              AND status = 'draft'
            RETURNING *
            `,
      [validated.evaluationId, validated.actorId]
    );
    const evaluation = evaluationResult.rows[0];
    const nextStatus =
      completion || revision
        ? EVALUATION_STATUS.COMPLETED
        : EVALUATION_STATUS.DRAFT;
    const version = await insertVersion({
      client,
      evaluationId: validated.evaluationId,
      version: nextVersion,
      status: nextStatus,
      content,
      actorId: validated.actorId,
    });
    if (!evaluation || !version) {
      throw new Error("Canonical Evaluation version creation failed.");
    }

    const evidence = await insertEvaluationEvidence({
      client,
      aggregate,
      context,
      actorId: validated.actorId,
      idempotencyId: idempotency.reservation.id,
      evidenceType,
      commandName,
      previousVersion: validated.expectedVersion,
      resultingVersion: nextVersion,
      content,
      status: nextStatus,
    });
    if (!evidence) throw new Error("Canonical Evaluation evidence creation failed.");

    const row = combinedRow({
      aggregate,
      evaluation,
      version,
      context,
      visitId: current.evaluation_visit_id || null,
      remoteProvenance:
        completion &&
        effectiveCompletionMode === EVALUATION_COMPLETION_MODES.REMOTE
          ? {
              assessment_method: validated.assessmentMethod,
              assessment_basis: validated.assessmentBasis,
            }
          : revision && current.remote_assessment_method
            ? {
                assessment_method: current.remote_assessment_method,
                assessment_basis: current.remote_assessment_basis,
              }
            : null,
    });
    const result = successResult({
      status: 200,
      code: completion
        ? "EVALUATION_COMPLETED"
        : revision
          ? "EVALUATION_REVISED"
          : "EVALUATION_DRAFT_UPDATED",
      row,
      evidenceType,
    });
    if (
      !(await completeIdempotency(
        client,
        idempotency.reservation.id,
        validated.evaluationId,
        result
      ))
    ) {
      throw new Error("Canonical Evaluation idempotency completion failed.");
    }

    if (
      completion &&
      sourceContext.type === "ordinary_job" &&
      effectiveCompletionMode === EVALUATION_COMPLETION_MODES.REMOTE
    ) {
      const remoteProvenance = await insertRemoteEvaluationProvenance({
        client,
        evaluationId: validated.evaluationId,
        evaluationVersion: nextVersion,
        jobId: context.job_id,
        professionalParticipantId: context.actor_participant_id,
        assessmentMethod: validated.assessmentMethod,
        assessmentBasis: validated.assessmentBasis,
        completionCommandId: idempotency.reservation.id,
      });
      if (!remoteProvenance) {
        throw new Error("Canonical remote Evaluation provenance creation failed.");
      }
    }

    await client.query("COMMIT");
    transactionStarted = false;
    if (sourceContext.type === "ordinary_job") {
      logger.info(
        completion
          ? "Ordinary Evaluation confirmed"
          : revision
            ? "Ordinary Evaluation revised"
            : "Ordinary Evaluation version created",
        {
          code: completion
            ? "ORDINARY_EVALUATION_CONFIRMED"
            : revision
              ? "ORDINARY_EVALUATION_REVISED"
              : "ORDINARY_EVALUATION_VERSION_CREATED",
          actorUserId: validated.actorId,
          jobId: sourceContext.jobId,
          relationshipId: sourceContext.relationshipId,
          evaluationId: validated.evaluationId,
          version: nextVersion,
        }
      );
    }
    return result;
  } catch (error) {
    if (transactionStarted) {
      await rollback(client);
      transactionStarted = false;
    }
    const provenanceFailure = evaluationProvenanceFailure(
      error,
      effectiveCompletionMode
    );
    if (provenanceFailure) return provenanceFailure;
    throw error;
  } finally {
    if (client !== input.pool && typeof client.release === "function") client.release();
  }
}

async function updateEvaluationDraft(input = {}) {
  return mutateEvaluation(input, { completion: false });
}

async function reviseEvaluation(input = {}) {
  return mutateEvaluation(input, { revision: true });
}

async function completeEvaluation(input = {}) {
  return mutateEvaluation(input, { completion: true });
}

async function getEvaluation(input = {}) {
  const actor = validateAuthenticatedActor(input.authenticatedActor);
  if (actor.error) return actor.error;
  const logger = safeLogger(input.logger);
  const evaluationId = normalizedUuid(input.evaluationId);
  if (!evaluationId) {
    return failure(400, "INVALID_EVALUATION_ID", "A valid Evaluation ID is required.");
  }
  if (!input.pool || typeof input.pool.query !== "function") {
    throw new TypeError("A database pool or client is required.");
  }
  const row = await loadEvaluation(input.pool, evaluationId, actor.id);
  if (!row) {
    return failure(404, "EVALUATION_UNAVAILABLE", "The Evaluation is unavailable.");
  }
  if (row.source_context_type === "ordinary_request") {
    const context = await resolveOrdinaryJobContext(
      input.pool,
      row.job_id,
      actor.id
    );
    const authorityError = await requireOrdinaryEvaluationAuthority({
      client: input.pool,
      context,
      actorUserId: actor.id,
      logger,
    });
    if (authorityError) return authorityError;
  }
  return {
    ok: true,
    success: true,
    status: 200,
    code: "EVALUATION_FOUND",
    ...evaluationProjection(row),
  };
}

async function listEvaluationsForJob(input = {}) {
  const actor = validateAuthenticatedActor(input.authenticatedActor);
  if (actor.error) return actor.error;
  const jobId = normalizedUuid(input.jobId);
  if (!jobId) {
    return failure(400, "INVALID_JOB_ID", "A valid Job ID is required.");
  }
  if (!input.pool || typeof input.pool.query !== "function") {
    throw new TypeError("A database pool or client is required.");
  }
  const logger = safeLogger(input.logger);
  const context = await resolveOrdinaryJobContext(input.pool, jobId, actor.id);
  const authorityError = await requireOrdinaryEvaluationAuthority({
    client: input.pool,
    context,
    actorUserId: actor.id,
    logger,
  });
  if (authorityError) return authorityError;

  const result = await input.pool.query(
    `
    SELECT canonical_evaluation_job_subjects.evaluation_id
    FROM canonical_evaluation_job_subjects
    INNER JOIN canonical_evaluations
      ON canonical_evaluations.id =
        canonical_evaluation_job_subjects.evaluation_id
      AND canonical_evaluations.professional_user_id = $2
    WHERE canonical_evaluation_job_subjects.job_id = $1
      AND canonical_evaluation_job_subjects.job_request_id = $3
      AND canonical_evaluation_job_subjects.relationship_id = $4
    ORDER BY canonical_evaluations.updated_at DESC,
      canonical_evaluations.id ASC
    `,
    [
      jobId,
      actor.id,
      Number(context.job_request_id),
      Number(context.relationship_id),
    ]
  );
  const evaluations = [];
  for (const subject of result.rows) {
    const row = await loadEvaluation(
      input.pool,
      subject.evaluation_id,
      actor.id
    );
    if (row) evaluations.push(evaluationProjection(row));
  }
  return {
    ok: true,
    success: true,
    status: 200,
    code: "EVALUATIONS_FOUND",
    evaluations,
  };
}

async function listEvaluationsForEmergencyRequest(input = {}) {
  const actor = validateAuthenticatedActor(input.authenticatedActor);
  if (actor.error) return actor.error;
  const emergencyRequestId = positiveInteger(input.emergencyRequestId);
  if (!emergencyRequestId) {
    return failure(
      400,
      "INVALID_EVALUATION_SOURCE_CONTEXT",
      "A valid Emergency request is required."
    );
  }
  if (!input.pool || typeof input.pool.query !== "function") {
    throw new TypeError("A database pool or client is required.");
  }

  const result = await input.pool.query(
    `
    SELECT
      a.id AS evaluation_id,
      a.current_version,
      a.emergency_request_id,
      a.relationship_id,
      ce.status AS evaluation_status,
      ce.created_at AS evaluation_created_at,
      ce.updated_at AS evaluation_updated_at,
      ce.completed_at,
      cev.service_type,
      cev.evaluation_context,
      cev.template_key,
      cev.observations,
      cev.measurements,
      cev.findings,
      cev.diagnosis_summary,
      cev.limitations,
      cev.scope_recommendations,
      cev.relevant_conditions,
      cev.supporting_media_references,
      cev.internal_notes
    FROM commercial_authority_aggregates AS a
    INNER JOIN canonical_evaluations AS ce
      ON ce.id = a.id
      AND ce.professional_user_id = $2
    INNER JOIN canonical_evaluation_versions AS cev
      ON cev.evaluation_id = ce.id
      AND cev.version = a.current_version
    INNER JOIN request_relationships AS rr
      ON rr.id = ce.relationship_id
      AND rr.professional_user_id = ce.professional_user_id
      AND rr.emergency_request_id = a.emergency_request_id
      AND rr.post_id IS NULL
    INNER JOIN emergency_requests AS er
      ON er.id = a.emergency_request_id
      AND er.homeowner_id = rr.homeowner_id
      AND er.homeowner_id = a.source_owner_user_id
    WHERE a.aggregate_type = 'evaluation'
      AND a.owning_engine = $3
      AND a.source_context_type = 'emergency_request'
      AND a.emergency_request_id = $1
    ORDER BY ce.updated_at DESC, ce.id ASC
    `,
    [emergencyRequestId, actor.id, OWNING_ENGINE]
  );

  return {
    ok: true,
    success: true,
    status: 200,
    code: "EVALUATIONS_FOUND",
    evaluations: result.rows.map(evaluationProjection),
  };
}

module.exports = {
  ALLOWED_EMERGENCY_EVALUATION_STATUSES,
  CAPABILITY_MILESTONE_ID,
  EVALUATION_COMMANDS,
  EVALUATION_COMPLETION_MODES,
  EVALUATION_EVIDENCE_TYPES,
  EVALUATION_STATUS,
  ORDINARY_EVALUATION_CAPABILITY,
  REMOTE_ASSESSMENT_METHODS,
  completeEvaluation,
  createEvaluation,
  createOrdinaryJobEvaluation,
  getEvaluation,
  listEvaluationsForEmergencyRequest,
  listEvaluationsForJob,
  reviseEvaluation,
  updateEvaluationDraft,
  validateCompletionContract,
  validateCompletionContent,
  validateEvaluationContent,
  validateOrdinaryCompletionContent,
  validateOrdinaryEvaluationContent,
};
