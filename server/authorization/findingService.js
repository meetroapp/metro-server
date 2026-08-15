"use strict";

const { randomUUID } = require("node:crypto");

const {
  AUTHORITY_SOURCE,
  OWNING_ENGINE,
  commercialAuthorityInternals,
} = require("./commercialAuthorityService");
const { hasActiveLifecycleGrant } = require("./lifecycleAuthorityService");

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

const FINDING_CAPABILITIES = Object.freeze({
  SUBMIT: "finding.submit",
  CONFIRM: "finding.confirm",
});

const FINDING_COMMANDS = Object.freeze({
  SUBMIT: "finding.submit",
  UPDATE: "finding.update",
  LINK_CONCERN: "finding.concern.link",
  ADD_EVIDENCE: "finding.evidence.add",
  CONFIRM: "finding.confirm",
});

const FINDING_RELATIONSHIPS = Object.freeze([
  "EXPLAINS",
  "RELATED",
  "CONTRADICTS",
]);

const FINDING_EVIDENCE_TYPES = Object.freeze([
  "PROFESSIONAL_OBSERVATION",
  "PHOTO_MEDIA",
  "SPECIALIST_CONTRIBUTION",
  "MEASUREMENT",
  "COMMUNICATION",
  "AI_PROPOSAL_LINEAGE",
]);

function validateInput(input, allowedFields) {
  if (!isPlainObject(input)) {
    return failure(400, "INVALID_FINDING_COMMAND", "The Finding command is invalid.");
  }
  if (Object.keys(input).some((key) => !allowedFields.has(key))) {
    return failure(
      400,
      "FINDING_AUTHORITY_FIELD_REJECTED",
      "Server-owned Finding fields cannot be supplied."
    );
  }
  return null;
}

function boundedText(value, maximum) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= maximum ? normalized : null;
}

function safeLogger(value) {
  return value && typeof value.info === "function" && typeof value.warn === "function"
    ? value
    : console;
}

function validateBaseCommand(input, extraFields) {
  const inputError = validateInput(input, new Set([
    "pool",
    "authenticatedActor",
    "idempotencyKey",
    "logger",
    ...extraFields,
  ]));
  if (inputError) return { error: inputError };
  const actor = validateAuthenticatedActor(input.authenticatedActor);
  if (actor.error) return actor;
  const idempotency = validateIdempotencyKey(input.idempotencyKey);
  if (idempotency.error) return idempotency;
  return {
    actorId: actor.id,
    idempotencyKey: idempotency.idempotencyKey,
  };
}

async function runTransaction(pool, action) {
  const client = await databaseClient(pool);
  let transactionStarted = false;
  try {
    await client.query("BEGIN");
    transactionStarted = true;
    const outcome = await action(client);
    if (outcome.abort) {
      await rollback(client);
      transactionStarted = false;
      return outcome.abort;
    }
    await client.query("COMMIT");
    transactionStarted = false;
    if (outcome.afterCommit) outcome.afterCommit();
    return outcome.result;
  } catch (error) {
    if (transactionStarted) await rollback(client);
    throw error;
  } finally {
    if (client !== pool && typeof client.release === "function") client.release();
  }
}

async function loadEvaluationContext(
  client,
  evaluationId,
  actorUserId,
  { lock = false } = {}
) {
  const result = await client.query(
    `
    /* finding:evaluation_context */
    SELECT
      canonical_evaluations.id AS evaluation_id,
      canonical_evaluations.status AS evaluation_status,
      commercial_authority_aggregates.current_version AS evaluation_version,
      canonical_evaluation_job_subjects.job_id,
      canonical_evaluation_job_subjects.job_request_id,
      canonical_evaluation_job_subjects.relationship_id,
      relationship_participants.id AS actor_participant_id,
      relationship_participants.user_id AS actor_user_id
    FROM canonical_evaluations
    INNER JOIN commercial_authority_aggregates
      ON commercial_authority_aggregates.id = canonical_evaluations.id
      AND commercial_authority_aggregates.aggregate_type = 'evaluation'
      AND commercial_authority_aggregates.owning_engine = $3
      AND commercial_authority_aggregates.source_context_type = 'ordinary_request'
    INNER JOIN canonical_evaluation_job_subjects
      ON canonical_evaluation_job_subjects.evaluation_id = canonical_evaluations.id
      AND canonical_evaluation_job_subjects.job_request_id =
        commercial_authority_aggregates.ordinary_request_id
      AND canonical_evaluation_job_subjects.relationship_id =
        commercial_authority_aggregates.relationship_id
    INNER JOIN jobs
      ON jobs.id = canonical_evaluation_job_subjects.job_id
      AND jobs.job_request_id = canonical_evaluation_job_subjects.job_request_id
      AND jobs.source_request_relationship_id =
        canonical_evaluation_job_subjects.relationship_id
      AND jobs.lifecycle_contract_version = 2
    INNER JOIN posts
      ON posts.id = jobs.job_request_id
      AND posts.lifecycle_contract_version = 2
      AND posts.user_id = commercial_authority_aggregates.source_owner_user_id
    INNER JOIN request_relationships
      ON request_relationships.id = jobs.source_request_relationship_id
      AND request_relationships.post_id = jobs.job_request_id
      AND request_relationships.emergency_request_id IS NULL
      AND request_relationships.homeowner_id = posts.user_id
      AND request_relationships.professional_user_id = $2
      AND request_relationships.professional_user_id =
        canonical_evaluations.professional_user_id
      AND request_relationships.status = 'active'
    INNER JOIN request_selections
      ON request_selections.id = jobs.source_request_selection_id
      AND request_selections.request_relationship_id = request_relationships.id
      AND request_selections.post_id = posts.id
      AND request_selections.selected_by_user_id = posts.user_id
    INNER JOIN relationship_participants
      ON relationship_participants.job_id = jobs.id
      AND relationship_participants.request_relationship_id =
        request_relationships.id
      AND relationship_participants.user_id = $2
    WHERE canonical_evaluations.id = $1
      AND canonical_evaluations.professional_user_id = $2
    LIMIT 1
    ${lock
      ? "FOR UPDATE OF canonical_evaluations, commercial_authority_aggregates, jobs, request_relationships"
      : ""}
    `,
    [evaluationId, actorUserId, OWNING_ENGINE]
  );
  return result.rows[0] || null;
}

async function requireCapability({ client, context, actorUserId, capability, logger }) {
  if (!context) {
    logger.warn("Finding authorization denied", {
      code: "FINDING_CONTEXT_DENIED",
      actorUserId,
      capability,
    });
    return failure(404, "FINDING_UNAVAILABLE", "The Finding is unavailable.");
  }
  const granted = await hasActiveLifecycleGrant({
    client,
    participantId: context.actor_participant_id,
    capability,
    jobId: context.job_id,
    logger,
  });
  if (!granted) {
    logger.warn("Finding authorization denied", {
      code: "FINDING_AUTHORITY_DENIED",
      actorUserId,
      evaluationId: context.evaluation_id,
      jobId: context.job_id,
      capability,
    });
    return failure(403, "FINDING_AUTHORITY_REQUIRED", "Finding authority is required.");
  }
  return null;
}

async function requireReadAuthority({ client, context, actorUserId, logger }) {
  if (!context) {
    return requireCapability({
      client,
      context,
      actorUserId,
      capability: FINDING_CAPABILITIES.SUBMIT,
      logger,
    });
  }
  for (const capability of [
    FINDING_CAPABILITIES.SUBMIT,
    FINDING_CAPABILITIES.CONFIRM,
  ]) {
    if (await hasActiveLifecycleGrant({
      client,
      participantId: context.actor_participant_id,
      capability,
      jobId: context.job_id,
    })) {
      return null;
    }
  }
  logger.warn("Finding read authorization denied", {
    code: "FINDING_READ_AUTHORITY_DENIED",
    actorUserId,
    evaluationId: context.evaluation_id,
    jobId: context.job_id,
  });
  return failure(403, "FINDING_AUTHORITY_REQUIRED", "Finding authority is required.");
}

async function loadFindingIdentity(client, findingId, { lock = false } = {}) {
  const result = await client.query(
    `
    SELECT id, evaluation_id, job_id, author_participant_id, created_at
    FROM canonical_evaluation_findings
    WHERE id = $1
    LIMIT 1
    ${lock ? "FOR UPDATE" : ""}
    `,
    [findingId]
  );
  return result.rows[0] || null;
}

async function loadFindingVersion(client, findingId, { lock = false } = {}) {
  const result = await client.query(
    `
    SELECT *
    FROM canonical_evaluation_finding_versions
    WHERE finding_id = $1
    ORDER BY version DESC
    LIMIT 1
    ${lock ? "FOR UPDATE" : ""}
    `,
    [findingId]
  );
  return result.rows[0] || null;
}

function findingVersionProjection(row) {
  return {
    version: Number(row.version),
    evaluationVersion: Number(row.evaluation_version),
    statement: row.statement,
    confirmationState: row.confirmation_state,
    resolutionState: row.resolution_state,
    customerVisible: row.customer_visible === true,
    createdByParticipantId: row.created_by_participant_id,
    integrity: {
      algorithm: row.integrity_algorithm,
      hash: row.integrity_hash,
      version: Number(row.integrity_version),
    },
    createdAt: row.created_at,
  };
}

async function findingProjection(client, identity, context) {
  const versionsResult = await client.query(
      `
      SELECT *
      FROM canonical_evaluation_finding_versions
      WHERE finding_id = $1 AND evaluation_id = $2 AND job_id = $3
      ORDER BY version ASC
      `,
      [identity.id, identity.evaluation_id, identity.job_id]
    );
  const linksResult = await client.query(
      `
      SELECT id, concern_id, relationship_type, created_by_participant_id,
        created_at
      FROM canonical_finding_concern_links
      WHERE finding_id = $1 AND job_id = $2
      ORDER BY created_at ASC, id ASC
      `,
      [identity.id, identity.job_id]
    );
  const evidenceResult = await client.query(
      `
      SELECT id, finding_version, evidence_type, reference_namespace,
        reference_id, recorded_by_participant_id, created_at
      FROM canonical_finding_evidence_references
      WHERE finding_id = $1 AND job_id = $2
      ORDER BY finding_version ASC, created_at ASC, id ASC
      `,
      [identity.id, identity.job_id]
    );
  const versions = versionsResult.rows.map(findingVersionProjection);
  const current = versions.at(-1);
  return {
    authoritySource: AUTHORITY_SOURCE,
    id: identity.id,
    evaluationId: identity.evaluation_id,
    jobId: identity.job_id,
    requestId: Number(context.job_request_id),
    relationshipId: Number(context.relationship_id),
    authorParticipantId: identity.author_participant_id,
    currentVersion: current.version,
    statement: current.statement,
    confirmationState: current.confirmationState,
    resolutionState: current.resolutionState,
    customerVisible: current.customerVisible,
    evaluationVersion: current.evaluationVersion,
    createdAt: identity.created_at,
    versions,
    concernLinks: linksResult.rows.map((row) => ({
      id: row.id,
      concernId: row.concern_id,
      relationshipType: row.relationship_type,
      createdByParticipantId: row.created_by_participant_id,
      createdAt: row.created_at,
    })),
    evidenceReferences: evidenceResult.rows.map((row) => ({
      id: row.id,
      findingVersion: Number(row.finding_version),
      evidenceType: row.evidence_type,
      referenceNamespace: row.reference_namespace,
      referenceId: row.reference_id,
      recordedByParticipantId: row.recorded_by_participant_id,
      createdAt: row.created_at,
    })),
  };
}

async function loadAuthorizedFinding({
  client,
  findingId,
  actorUserId,
  capability,
  logger,
  lock = false,
}) {
  const identity = await loadFindingIdentity(client, findingId, { lock });
  if (!identity) {
    return { error: failure(404, "FINDING_UNAVAILABLE", "The Finding is unavailable.") };
  }
  const context = await loadEvaluationContext(
    client,
    identity.evaluation_id,
    actorUserId,
    { lock }
  );
  if (!context || context.job_id !== identity.job_id) {
    return { error: failure(404, "FINDING_UNAVAILABLE", "The Finding is unavailable.") };
  }
  const authorityError = capability
    ? await requireCapability({ client, context, actorUserId, capability, logger })
    : await requireReadAuthority({ client, context, actorUserId, logger });
  return authorityError ? { error: authorityError } : { identity, context };
}

function commandResult(code, status, finding, extra = {}) {
  return {
    ok: true,
    success: true,
    status,
    code,
    finding,
    ...extra,
  };
}

function integrityHash({
  findingId,
  version,
  evaluationId,
  evaluationVersion,
  jobId,
  statement,
  confirmationState,
  resolutionState,
  customerVisible = false,
  actorParticipantId,
}) {
  return fingerprint({
    integrityVersion: 1,
    findingId,
    version,
    evaluationId,
    evaluationVersion,
    jobId,
    statement,
    confirmationState,
    resolutionState,
    customerVisible,
    actorParticipantId,
  });
}

async function submitFinding(input = {}) {
  const validated = validateBaseCommand(input, [
    "evaluationId",
    "statement",
    "customerVisible",
  ]);
  if (validated.error) return validated.error;
  const evaluationId = normalizedUuid(input.evaluationId);
  const statement = boundedText(input.statement, 5000);
  const customerVisible = input.customerVisible === true;
  if (input.customerVisible != null && typeof input.customerVisible !== "boolean") {
    return failure(400, "INVALID_FINDING_VISIBILITY", "Finding visibility is invalid.");
  }
  if (!evaluationId) {
    return failure(400, "INVALID_EVALUATION_ID", "A valid Evaluation ID is required.");
  }
  if (!statement) {
    return failure(400, "INVALID_FINDING_STATEMENT", "A valid Finding statement is required.");
  }
  const logger = safeLogger(input.logger);

  return runTransaction(input.pool, async (client) => {
    const context = await loadEvaluationContext(
      client,
      evaluationId,
      validated.actorId,
      { lock: true }
    );
    const authorityError = await requireCapability({
      client,
      context,
      actorUserId: validated.actorId,
      capability: FINDING_CAPABILITIES.SUBMIT,
      logger,
    });
    if (authorityError) return { abort: authorityError };
    const idempotency = await reserveIdempotency({
      client,
      actorUserId: validated.actorId,
      commandName: FINDING_COMMANDS.SUBMIT,
      commandScope: `finding:submit:evaluation:${evaluationId}`,
      idempotencyKey: validated.idempotencyKey,
      requestFingerprint: fingerprint({ evaluationId, statement, customerVisible }),
    });
    if (idempotency.error) return { abort: idempotency.error };
    if (idempotency.replay) {
      return {
        result: { ...idempotency.replay, replayed: true },
        afterCommit: () => logger.info("Finding command replayed", {
          code: "FINDING_SUBMIT_REPLAYED",
          actorUserId: validated.actorId,
          evaluationId,
          findingId: idempotency.replay.finding?.id || null,
        }),
      };
    }
    if (!["draft", "completed"].includes(context.evaluation_status)) {
      return {
        abort: failure(
          409,
          "FINDING_SUBMISSION_CLOSED",
          "Findings cannot be submitted for this Evaluation state."
        ),
      };
    }

    const findingId = randomUUID();
    const identityResult = await client.query(
      `
      INSERT INTO canonical_evaluation_findings
        (id, evaluation_id, job_id, author_participant_id)
      VALUES ($1, $2, $3, $4)
      RETURNING *
      `,
      [findingId, evaluationId, context.job_id, context.actor_participant_id]
    );
    await client.query(
      `
      INSERT INTO canonical_evaluation_finding_versions (
        finding_id, version, evaluation_id, evaluation_version, job_id,
        statement, confirmation_state, resolution_state,
        customer_visible, created_by_participant_id, integrity_hash
      )
      VALUES ($1, 1, $2, $3, $4, $5, 'PROPOSED', 'OPEN', $6, $7, $8)
      `,
      [
        findingId,
        evaluationId,
        Number(context.evaluation_version),
        context.job_id,
        statement,
        customerVisible,
        context.actor_participant_id,
        integrityHash({
          findingId,
          version: 1,
          evaluationId,
          evaluationVersion: Number(context.evaluation_version),
          jobId: context.job_id,
          statement,
          confirmationState: "PROPOSED",
          resolutionState: "OPEN",
          customerVisible,
          actorParticipantId: context.actor_participant_id,
        }),
      ]
    );
    const finding = await findingProjection(client, identityResult.rows[0], context);
    const result = commandResult("FINDING_SUBMITTED", 201, finding);
    if (!(await completeIdempotency(
      client,
      idempotency.reservation.id,
      evaluationId,
      result
    ))) {
      throw new Error("Finding submission idempotency completion failed.");
    }
    return {
      result,
      afterCommit: () => logger.info("Finding submitted", {
        code: "FINDING_SUBMITTED",
        actorUserId: validated.actorId,
        evaluationId,
        findingId,
        jobId: context.job_id,
        version: 1,
      }),
    };
  });
}

async function updateFinding(input = {}) {
  const validated = validateBaseCommand(input, [
    "findingId",
    "expectedVersion",
    "statement",
    "customerVisible",
  ]);
  if (validated.error) return validated.error;
  const findingId = normalizedUuid(input.findingId);
  const expectedVersion = positiveInteger(input.expectedVersion);
  const statement = boundedText(input.statement, 5000);
  const customerVisible = input.customerVisible === true;
  if (
    !findingId ||
    !expectedVersion ||
    !statement ||
    (input.customerVisible != null && typeof input.customerVisible !== "boolean")
  ) {
    return failure(400, "INVALID_FINDING_UPDATE", "The Finding update is invalid.");
  }
  const logger = safeLogger(input.logger);

  return runTransaction(input.pool, async (client) => {
    const authorized = await loadAuthorizedFinding({
      client,
      findingId,
      actorUserId: validated.actorId,
      capability: FINDING_CAPABILITIES.SUBMIT,
      logger,
      lock: true,
    });
    if (authorized.error) return { abort: authorized.error };
    const { identity, context } = authorized;
    const idempotency = await reserveIdempotency({
      client,
      actorUserId: validated.actorId,
      commandName: FINDING_COMMANDS.UPDATE,
      commandScope: `finding:update:${findingId}`,
      idempotencyKey: validated.idempotencyKey,
      requestFingerprint: fingerprint({
        findingId,
        expectedVersion,
        statement,
        customerVisible,
      }),
    });
    if (idempotency.error) return { abort: idempotency.error };
    if (idempotency.replay) {
      return { result: { ...idempotency.replay, replayed: true } };
    }
    const current = await loadFindingVersion(client, findingId, { lock: true });
    if (Number(current.version) !== expectedVersion) {
      return {
        abort: failure(409, "STALE_FINDING_VERSION", "The Finding version is no longer current."),
      };
    }
    if (
      !["draft", "completed"].includes(context.evaluation_status) ||
      current.confirmation_state !== "PROPOSED"
    ) {
      return {
        abort: failure(409, "FINDING_IMMUTABLE", "Only a proposed Finding can be updated."),
      };
    }
    const nextVersion = expectedVersion + 1;
    await client.query(
      `
      INSERT INTO canonical_evaluation_finding_versions (
        finding_id, version, evaluation_id, evaluation_version, job_id,
        statement, confirmation_state, resolution_state, customer_visible,
        created_by_participant_id, integrity_hash
      )
      VALUES ($1, $2, $3, $4, $5, $6, 'PROPOSED', 'OPEN', $7, $8, $9)
      `,
      [
        findingId,
        nextVersion,
        identity.evaluation_id,
        Number(context.evaluation_version),
        context.job_id,
        statement,
        customerVisible,
        context.actor_participant_id,
        integrityHash({
          findingId,
          version: nextVersion,
          evaluationId: identity.evaluation_id,
          evaluationVersion: Number(context.evaluation_version),
          jobId: context.job_id,
          statement,
          confirmationState: "PROPOSED",
          resolutionState: "OPEN",
          customerVisible,
          actorParticipantId: context.actor_participant_id,
        }),
      ]
    );
    const finding = await findingProjection(client, identity, context);
    const result = commandResult("FINDING_UPDATED", 200, finding);
    if (!(await completeIdempotency(
      client,
      idempotency.reservation.id,
      identity.evaluation_id,
      result
    ))) {
      throw new Error("Finding update idempotency completion failed.");
    }
    return {
      result,
      afterCommit: () => logger.info("Finding updated", {
        code: "FINDING_UPDATED",
        actorUserId: validated.actorId,
        evaluationId: identity.evaluation_id,
        findingId,
        jobId: context.job_id,
        version: nextVersion,
      }),
    };
  });
}

async function linkFindingConcern(input = {}) {
  const validated = validateBaseCommand(input, [
    "findingId",
    "concernId",
    "relationshipType",
  ]);
  if (validated.error) return validated.error;
  const findingId = normalizedUuid(input.findingId);
  const concernId = normalizedUuid(input.concernId);
  const relationshipType = String(input.relationshipType || "").trim().toUpperCase();
  if (!findingId || !concernId || !FINDING_RELATIONSHIPS.includes(relationshipType)) {
    return failure(400, "INVALID_FINDING_CONCERN_LINK", "The Finding concern link is invalid.");
  }
  const logger = safeLogger(input.logger);

  return runTransaction(input.pool, async (client) => {
    const authorized = await loadAuthorizedFinding({
      client,
      findingId,
      actorUserId: validated.actorId,
      capability: FINDING_CAPABILITIES.SUBMIT,
      logger,
      lock: true,
    });
    if (authorized.error) return { abort: authorized.error };
    const { identity, context } = authorized;

    const idempotency = await reserveIdempotency({
      client,
      actorUserId: validated.actorId,
      commandName: FINDING_COMMANDS.LINK_CONCERN,
      commandScope: `finding:concern-link:${findingId}`,
      idempotencyKey: validated.idempotencyKey,
      requestFingerprint: fingerprint({ findingId, concernId, relationshipType }),
    });
    if (idempotency.error) return { abort: idempotency.error };
    if (idempotency.replay) {
      return {
        result: { ...idempotency.replay, replayed: true },
        afterCommit: () => logger.info("Finding command replayed", {
          code: "FINDING_CONCERN_LINK_REPLAYED",
          actorUserId: validated.actorId,
          findingId,
          jobId: context.job_id,
        }),
      };
    }
    const current = await loadFindingVersion(client, findingId, { lock: true });
    if (current.confirmation_state !== "PROPOSED") {
      return {
        abort: failure(409, "FINDING_IMMUTABLE", "A confirmed Finding is immutable."),
      };
    }
    const concern = await client.query(
      `
      SELECT id, job_request_id
      FROM reported_concerns
      WHERE id = $1
      LIMIT 1
      `,
      [concernId]
    );
    if (
      !concern.rows[0] ||
      Number(concern.rows[0].job_request_id) !== Number(context.job_request_id)
    ) {
      logger.warn("Finding concern scope rejected", {
        code: "FINDING_CONCERN_SCOPE_MISMATCH",
        actorUserId: validated.actorId,
        findingId,
        jobId: context.job_id,
        concernId,
      });
      return {
        abort: failure(
          409,
          "FINDING_CONCERN_SCOPE_MISMATCH",
          "The Finding and Reported Concern scopes do not match."
        ),
      };
    }

    let link = (await client.query(
      `
      SELECT *
      FROM canonical_finding_concern_links
      WHERE finding_id = $1 AND concern_id = $2 AND relationship_type = $3
      LIMIT 1
      `,
      [findingId, concernId, relationshipType]
    )).rows[0];
    let created = false;
    if (!link) {
      link = (await client.query(
        `
        INSERT INTO canonical_finding_concern_links (
          id, finding_id, job_id, job_request_id, concern_id,
          relationship_type, created_by_participant_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *
        `,
        [
          randomUUID(),
          findingId,
          context.job_id,
          Number(context.job_request_id),
          concernId,
          relationshipType,
          context.actor_participant_id,
        ]
      )).rows[0];
      created = true;
    }
    const finding = await findingProjection(client, identity, context);
    const result = commandResult(
      created ? "FINDING_CONCERN_LINKED" : "FINDING_CONCERN_LINK_FOUND",
      created ? 201 : 200,
      finding,
      { concernLinkId: link.id }
    );
    if (!(await completeIdempotency(
      client,
      idempotency.reservation.id,
      identity.evaluation_id,
      result
    ))) {
      throw new Error("Finding concern-link idempotency completion failed.");
    }
    return {
      result,
      afterCommit: () => logger.info("Finding concern link established", {
        code: created ? "FINDING_CONCERN_LINKED" : "FINDING_CONCERN_LINK_FOUND",
        actorUserId: validated.actorId,
        findingId,
        jobId: context.job_id,
        concernId,
        relationshipType,
      }),
    };
  });
}

async function addFindingEvidenceReference(input = {}) {
  const validated = validateBaseCommand(input, [
    "findingId",
    "evidenceType",
    "referenceNamespace",
    "referenceId",
  ]);
  if (validated.error) return validated.error;
  const findingId = normalizedUuid(input.findingId);
  const evidenceType = String(input.evidenceType || "").trim().toUpperCase();
  const referenceNamespace = boundedText(input.referenceNamespace, 120);
  const referenceId = boundedText(input.referenceId, 200);
  if (
    !findingId ||
    !FINDING_EVIDENCE_TYPES.includes(evidenceType) ||
    !referenceNamespace ||
    !/^[a-z][a-z0-9_.-]*$/.test(referenceNamespace) ||
    !referenceId
  ) {
    return failure(400, "INVALID_FINDING_EVIDENCE", "The Finding evidence reference is invalid.");
  }
  const logger = safeLogger(input.logger);

  return runTransaction(input.pool, async (client) => {
    const authorized = await loadAuthorizedFinding({
      client,
      findingId,
      actorUserId: validated.actorId,
      capability: FINDING_CAPABILITIES.SUBMIT,
      logger,
      lock: true,
    });
    if (authorized.error) return { abort: authorized.error };
    const { identity, context } = authorized;
    const current = await loadFindingVersion(client, findingId, { lock: true });

    const idempotency = await reserveIdempotency({
      client,
      actorUserId: validated.actorId,
      commandName: FINDING_COMMANDS.ADD_EVIDENCE,
      commandScope: `finding:evidence:${findingId}`,
      idempotencyKey: validated.idempotencyKey,
      requestFingerprint: fingerprint({
        findingId,
        evidenceType,
        referenceNamespace,
        referenceId,
      }),
    });
    if (idempotency.error) return { abort: idempotency.error };
    if (idempotency.replay) {
      return {
        result: { ...idempotency.replay, replayed: true },
        afterCommit: () => logger.info("Finding command replayed", {
          code: "FINDING_EVIDENCE_REPLAYED",
          actorUserId: validated.actorId,
          findingId,
          jobId: context.job_id,
        }),
      };
    }
    if (current.confirmation_state !== "PROPOSED") {
      return {
        abort: failure(409, "FINDING_IMMUTABLE", "A confirmed Finding is immutable."),
      };
    }

    let evidence = (await client.query(
      `
      SELECT *
      FROM canonical_finding_evidence_references
      WHERE finding_id = $1 AND finding_version = $2
        AND evidence_type = $3 AND reference_namespace = $4
        AND reference_id = $5
      LIMIT 1
      `,
      [findingId, Number(current.version), evidenceType, referenceNamespace, referenceId]
    )).rows[0];
    let created = false;
    if (!evidence) {
      evidence = (await client.query(
        `
        INSERT INTO canonical_finding_evidence_references (
          id, finding_id, finding_version, job_id, evidence_type,
          reference_namespace, reference_id, recorded_by_participant_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *
        `,
        [
          randomUUID(),
          findingId,
          Number(current.version),
          context.job_id,
          evidenceType,
          referenceNamespace,
          referenceId,
          context.actor_participant_id,
        ]
      )).rows[0];
      created = true;
    }
    const finding = await findingProjection(client, identity, context);
    const result = commandResult(
      created ? "FINDING_EVIDENCE_ADDED" : "FINDING_EVIDENCE_FOUND",
      created ? 201 : 200,
      finding,
      { evidenceReferenceId: evidence.id }
    );
    if (!(await completeIdempotency(
      client,
      idempotency.reservation.id,
      identity.evaluation_id,
      result
    ))) {
      throw new Error("Finding evidence idempotency completion failed.");
    }
    return { result };
  });
}

async function confirmFinding(input = {}) {
  const validated = validateBaseCommand(input, ["findingId", "expectedVersion"]);
  if (validated.error) return validated.error;
  const findingId = normalizedUuid(input.findingId);
  const expectedVersion = positiveInteger(input.expectedVersion);
  if (!findingId || !expectedVersion) {
    return failure(400, "INVALID_FINDING_CONFIRMATION", "A valid Finding version is required.");
  }
  const logger = safeLogger(input.logger);

  return runTransaction(input.pool, async (client) => {
    const authorized = await loadAuthorizedFinding({
      client,
      findingId,
      actorUserId: validated.actorId,
      capability: FINDING_CAPABILITIES.CONFIRM,
      logger,
      lock: true,
    });
    if (authorized.error) return { abort: authorized.error };
    const { identity, context } = authorized;

    const idempotency = await reserveIdempotency({
      client,
      actorUserId: validated.actorId,
      commandName: FINDING_COMMANDS.CONFIRM,
      commandScope: `finding:confirm:${findingId}`,
      idempotencyKey: validated.idempotencyKey,
      requestFingerprint: fingerprint({ findingId, expectedVersion }),
    });
    if (idempotency.error) return { abort: idempotency.error };
    if (idempotency.replay) {
      return {
        result: { ...idempotency.replay, replayed: true },
        afterCommit: () => logger.info("Finding command replayed", {
          code: "FINDING_CONFIRM_REPLAYED",
          actorUserId: validated.actorId,
          findingId,
          jobId: context.job_id,
        }),
      };
    }

    const current = await loadFindingVersion(client, findingId, { lock: true });
    if (Number(current.version) !== expectedVersion) {
      return {
        abort: failure(409, "STALE_FINDING_VERSION", "The Finding version is no longer current."),
      };
    }
    if (current.confirmation_state !== "PROPOSED") {
      return {
        abort: failure(409, "FINDING_IMMUTABLE", "A confirmed Finding is immutable."),
      };
    }
    const nextVersion = expectedVersion + 1;
    await client.query(
      `
      INSERT INTO canonical_evaluation_finding_versions (
        finding_id, version, evaluation_id, evaluation_version, job_id,
        statement, confirmation_state, resolution_state,
        customer_visible, created_by_participant_id, integrity_hash
      )
      VALUES ($1, $2, $3, $4, $5, $6, 'CONFIRMED', 'OPEN', $7, $8, $9)
      `,
      [
        findingId,
        nextVersion,
        identity.evaluation_id,
        Number(current.evaluation_version),
        context.job_id,
        current.statement,
        current.customer_visible === true,
        context.actor_participant_id,
        integrityHash({
          findingId,
          version: nextVersion,
          evaluationId: identity.evaluation_id,
          evaluationVersion: Number(current.evaluation_version),
          jobId: context.job_id,
          statement: current.statement,
          confirmationState: "CONFIRMED",
          resolutionState: "OPEN",
          customerVisible: current.customer_visible === true,
          actorParticipantId: context.actor_participant_id,
        }),
      ]
    );
    const finding = await findingProjection(client, identity, context);
    const result = commandResult("FINDING_CONFIRMED", 200, finding);
    if (!(await completeIdempotency(
      client,
      idempotency.reservation.id,
      identity.evaluation_id,
      result
    ))) {
      throw new Error("Finding confirmation idempotency completion failed.");
    }
    return {
      result,
      afterCommit: () => logger.info("Finding confirmed", {
        code: "FINDING_CONFIRMED",
        actorUserId: validated.actorId,
        evaluationId: identity.evaluation_id,
        findingId,
        jobId: context.job_id,
        version: nextVersion,
      }),
    };
  });
}

async function getFinding(input = {}) {
  const actor = validateAuthenticatedActor(input.authenticatedActor);
  if (actor.error) return actor.error;
  const findingId = normalizedUuid(input.findingId);
  if (!findingId) {
    return failure(400, "INVALID_FINDING_ID", "A valid Finding ID is required.");
  }
  if (!input.pool || typeof input.pool.query !== "function") {
    throw new TypeError("A database pool or client is required.");
  }
  const logger = safeLogger(input.logger);
  const authorized = await loadAuthorizedFinding({
    client: input.pool,
    findingId,
    actorUserId: actor.id,
    logger,
  });
  if (authorized.error) return authorized.error;
  return commandResult(
    "FINDING_FOUND",
    200,
    await findingProjection(input.pool, authorized.identity, authorized.context)
  );
}

async function listEvaluationFindings(input = {}) {
  const actor = validateAuthenticatedActor(input.authenticatedActor);
  if (actor.error) return actor.error;
  const evaluationId = normalizedUuid(input.evaluationId);
  if (!evaluationId) {
    return failure(400, "INVALID_EVALUATION_ID", "A valid Evaluation ID is required.");
  }
  if (!input.pool || typeof input.pool.query !== "function") {
    throw new TypeError("A database pool or client is required.");
  }
  const logger = safeLogger(input.logger);
  const context = await loadEvaluationContext(input.pool, evaluationId, actor.id);
  const authorityError = await requireReadAuthority({
    client: input.pool,
    context,
    actorUserId: actor.id,
    logger,
  });
  if (authorityError) return authorityError;
  const identities = await input.pool.query(
    `
    SELECT *
    FROM canonical_evaluation_findings
    WHERE evaluation_id = $1 AND job_id = $2
    ORDER BY created_at ASC, id ASC
    `,
    [evaluationId, context.job_id]
  );
  const findings = [];
  for (const identity of identities.rows) {
    findings.push(await findingProjection(input.pool, identity, context));
  }
  return {
    ok: true,
    success: true,
    status: 200,
    code: "FINDINGS_FOUND",
    findings,
  };
}

module.exports = {
  FINDING_CAPABILITIES,
  FINDING_COMMANDS,
  FINDING_EVIDENCE_TYPES,
  FINDING_RELATIONSHIPS,
  addFindingEvidenceReference,
  confirmFinding,
  getFinding,
  linkFindingConcern,
  listEvaluationFindings,
  submitFinding,
  updateFinding,
};
