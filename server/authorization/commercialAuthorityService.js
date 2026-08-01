"use strict";

const { createHash, randomUUID } = require("node:crypto");

const AUTHORITY_SOURCE = "canonical-commercial-authority";
const OWNING_ENGINE = "authorization_engine";

const AGGREGATE_TYPES = Object.freeze([
  "evaluation",
  "quote",
  "customer_decision",
  "authorization",
  "change_order",
  "invoice",
  "payment",
  "receipt",
  "commercial_completion",
]);

const SOURCE_CONTEXT_TYPES = Object.freeze([
  "ordinary_request",
  "emergency_request",
]);

const COMMANDS = Object.freeze({
  CREATE: "commercial.aggregate.create",
  ADVANCE: "commercial.aggregate.version.advance",
});

const EVIDENCE_TYPES = Object.freeze({
  CREATED: "commercial.aggregate.created",
  VERSION_ADVANCED: "commercial.aggregate.version_advanced",
});

const TRACEABILITY = Object.freeze({
  governingCharterId: "MC-WORKFLOW-001C",
  governingProgramId: "MC-WORKFLOW-001D",
  implementationMilestoneId: "MC-WORKFLOW-002A",
  certificationTarget: "MC-WORKFLOW-002R",
});

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

const SERVER_OWNED_INPUT_FIELDS = Object.freeze([
  "actorId",
  "actorUserId",
  "actor_user_id",
  "ownerId",
  "ownerUserId",
  "owner_user_id",
  "sourceOwnerUserId",
  "source_owner_user_id",
  "owningEngine",
  "owning_engine",
  "resultingVersion",
  "resulting_version",
  "persistedAt",
  "persisted_at",
  "evidenceId",
  "evidence_id",
  "evidencePayload",
  "evidence_payload",
  "currentVersion",
  "current_version",
  "createdByUserId",
  "created_by_user_id",
  "createdAt",
  "created_at",
  "updatedAt",
  "updated_at",
  "occurredAt",
  "occurred_at",
  "idempotencyId",
  "idempotency_id",
  "traceability",
  "confirmed",
  "authoritySource",
]);

function failure(status, code, message) {
  return { ok: false, status, code, message };
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function nonNegativeInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function normalizedUuid(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return UUID_PATTERN.test(normalized) ? normalized : null;
}

function validateServerOwnedFields(input) {
  if (!isPlainObject(input)) {
    return failure(
      400,
      "COMMERCIAL_AUTHORITY_INVARIANT_VIOLATION",
      "The commercial authority command is invalid."
    );
  }

  if (SERVER_OWNED_INPUT_FIELDS.some((field) => Object.hasOwn(input, field))) {
    return failure(
      400,
      "COMMERCIAL_AUTHORITY_INVARIANT_VIOLATION",
      "Server-owned commercial authority fields cannot be supplied."
    );
  }

  return null;
}

function validateAuthenticatedActor(authenticatedActor) {
  const id = positiveInteger(authenticatedActor?.id);
  if (!id) {
    return {
      error: failure(
        401,
        "COMMERCIAL_AUTHORITY_AUTHENTICATION_REQUIRED",
        "Authentication is required."
      ),
    };
  }
  return { id };
}

function validateAggregateType(value) {
  const aggregateType = typeof value === "string" ? value.trim() : "";
  if (!AGGREGATE_TYPES.includes(aggregateType)) {
    return {
      error: failure(
        400,
        "INVALID_COMMERCIAL_AGGREGATE_TYPE",
        "The commercial aggregate type is invalid."
      ),
    };
  }
  return { aggregateType };
}

function validateCommandDefinition({ commandName, expectedCommand, evidenceType, expectedEvidence }) {
  if (commandName !== expectedCommand) {
    return {
      error: failure(
        400,
        "INVALID_COMMERCIAL_COMMAND",
        "The commercial command is invalid."
      ),
    };
  }

  if (evidenceType !== expectedEvidence) {
    return {
      error: failure(
        400,
        "INVALID_COMMERCIAL_EVIDENCE_TYPE",
        "The commercial evidence type is invalid."
      ),
    };
  }

  return { commandName, evidenceType };
}

function validateIdempotencyKey(value) {
  const idempotencyKey = typeof value === "string" ? value.trim() : "";
  if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    return {
      error: failure(
        400,
        "INVALID_COMMERCIAL_IDEMPOTENCY_KEY",
        "A valid idempotency key is required."
      ),
    };
  }
  return { idempotencyKey };
}

function validateSourceContext(value) {
  if (!isPlainObject(value) || !SOURCE_CONTEXT_TYPES.includes(value.type)) {
    return {
      error: failure(
        400,
        "INVALID_COMMERCIAL_SOURCE_CONTEXT",
        "The commercial source context is invalid."
      ),
    };
  }

  const allowedKeys =
    value.type === "ordinary_request"
      ? new Set(["type", "requestId", "relationshipId"])
      : new Set(["type", "emergencyRequestId", "relationshipId"]);

  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    return {
      error: failure(
        400,
        "INVALID_COMMERCIAL_SOURCE_CONTEXT",
        "The commercial source context is invalid."
      ),
    };
  }

  const relationshipId =
    value.relationshipId == null ? null : positiveInteger(value.relationshipId);
  if (value.relationshipId != null && !relationshipId) {
    return {
      error: failure(
        400,
        "INVALID_COMMERCIAL_SOURCE_CONTEXT",
        "The commercial source context is invalid."
      ),
    };
  }

  if (value.type === "ordinary_request") {
    const requestId = positiveInteger(value.requestId);
    if (!requestId) {
      return {
        error: failure(
          400,
          "INVALID_COMMERCIAL_SOURCE_CONTEXT",
          "The commercial source context is invalid."
        ),
      };
    }
    return {
      sourceContext: {
        type: value.type,
        requestId,
        relationshipId,
      },
    };
  }

  const emergencyRequestId = positiveInteger(value.emergencyRequestId);
  if (!emergencyRequestId) {
    return {
      error: failure(
        400,
        "INVALID_COMMERCIAL_SOURCE_CONTEXT",
        "The commercial source context is invalid."
      ),
    };
  }

  return {
    sourceContext: {
      type: value.type,
      emergencyRequestId,
      relationshipId,
    },
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function sourceCommandScope(sourceContext) {
  const sourceId =
    sourceContext.type === "ordinary_request"
      ? sourceContext.requestId
      : sourceContext.emergencyRequestId;
  return [
    "create",
    sourceContext.type,
    sourceId,
    sourceContext.relationshipId || "none",
  ].join(":");
}

async function resolveSourceContext(client, sourceContext, actorUserId) {
  const ordinary = sourceContext.type === "ordinary_request";
  const result = await client.query(
    ordinary
      ? `
        SELECT
          p.id AS source_id,
          p.user_id AS source_owner_user_id,
          rr.id AS relationship_id,
          rr.homeowner_id AS relationship_homeowner_id,
          rr.professional_user_id
        FROM posts AS p
        LEFT JOIN request_relationships AS rr
          ON rr.id = $2
          AND rr.post_id = p.id
          AND rr.emergency_request_id IS NULL
        WHERE p.id = $1
        LIMIT 1
        `
      : `
        SELECT
          er.id AS source_id,
          er.homeowner_id AS source_owner_user_id,
          rr.id AS relationship_id,
          rr.homeowner_id AS relationship_homeowner_id,
          rr.professional_user_id
        FROM emergency_requests AS er
        LEFT JOIN request_relationships AS rr
          ON rr.id = $2
          AND rr.emergency_request_id = er.id
          AND rr.post_id IS NULL
        WHERE er.id = $1
        LIMIT 1
        `,
    [
      ordinary ? sourceContext.requestId : sourceContext.emergencyRequestId,
      sourceContext.relationshipId,
    ]
  );

  const row = result.rows[0];
  if (
    !row ||
    (sourceContext.relationshipId &&
      Number(row.relationship_id) !== sourceContext.relationshipId) ||
    (row.relationship_id &&
      Number(row.relationship_homeowner_id) !== Number(row.source_owner_user_id))
  ) {
    return null;
  }

  if (Number(row.source_owner_user_id) === actorUserId) {
    return { row, actorRole: "homeowner" };
  }

  if (
    row.relationship_id &&
    Number(row.professional_user_id) === actorUserId
  ) {
    return { row, actorRole: "professional" };
  }

  return null;
}

async function reserveIdempotency({
  client,
  actorUserId,
  commandName,
  commandScope,
  idempotencyKey,
  requestFingerprint,
}) {
  const id = randomUUID();
  const inserted = await client.query(
    `
    INSERT INTO commercial_command_idempotency
    (
      id,
      actor_user_id,
      command_name,
      command_scope,
      idempotency_key,
      request_fingerprint
    )
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (
      actor_user_id,
      command_name,
      command_scope,
      idempotency_key
    )
    DO NOTHING
    RETURNING *
    `,
    [
      id,
      actorUserId,
      commandName,
      commandScope,
      idempotencyKey,
      requestFingerprint,
    ]
  );

  if (inserted.rows[0]) {
    return { reservation: inserted.rows[0], replay: null };
  }

  const existing = await client.query(
    `
    SELECT *
    FROM commercial_command_idempotency
    WHERE actor_user_id = $1
      AND command_name = $2
      AND command_scope = $3
      AND idempotency_key = $4
    LIMIT 1
    FOR UPDATE
    `,
    [actorUserId, commandName, commandScope, idempotencyKey]
  );
  const reservation = existing.rows[0];

  if (!reservation) {
    return {
      error: failure(
        500,
        "COMMERCIAL_AUTHORITY_INVARIANT_VIOLATION",
        "The commercial command could not be completed."
      ),
    };
  }

  if (reservation.request_fingerprint !== requestFingerprint) {
    return {
      error: failure(
        409,
        "COMMERCIAL_IDEMPOTENCY_KEY_CONFLICT",
        "The idempotency key was already used for a different command."
      ),
    };
  }

  if (
    !reservation.aggregate_id ||
    !reservation.result_reference ||
    !reservation.completed_at
  ) {
    return {
      error: failure(
        500,
        "COMMERCIAL_AUTHORITY_INVARIANT_VIOLATION",
        "The commercial command could not be completed."
      ),
    };
  }

  const replay =
    typeof reservation.result_reference === "string"
      ? JSON.parse(reservation.result_reference)
      : reservation.result_reference;
  return { reservation, replay };
}

async function completeIdempotency(client, reservationId, aggregateId, result) {
  const completed = await client.query(
    `
    UPDATE commercial_command_idempotency
    SET
      aggregate_id = $2,
      result_reference = $3::jsonb,
      completed_at = CURRENT_TIMESTAMP
    WHERE id = $1
      AND aggregate_id IS NULL
      AND result_reference IS NULL
      AND completed_at IS NULL
    RETURNING id
    `,
    [reservationId, aggregateId, JSON.stringify(result)]
  );

  return Boolean(completed.rows[0]);
}

function sourceContextProjection(row) {
  if (row.source_context_type === "ordinary_request") {
    return {
      type: "ordinary_request",
      requestId: Number(row.ordinary_request_id),
      relationshipId: row.relationship_id == null ? null : Number(row.relationship_id),
    };
  }
  return {
    type: "emergency_request",
    emergencyRequestId: Number(row.emergency_request_id),
    relationshipId: row.relationship_id == null ? null : Number(row.relationship_id),
  };
}

function aggregateProjection(row) {
  return {
    id: row.id,
    type: row.aggregate_type,
    owningEngine: row.owning_engine,
    version: Number(row.current_version),
    sourceContext: sourceContextProjection(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function evidenceProjection(row) {
  return {
    id: row.id,
    aggregateId: row.aggregate_id,
    aggregateType: row.aggregate_type,
    owningEngine: row.owning_engine,
    type: row.evidence_type,
    actorUserId: Number(row.actor_user_id),
    actorRole: row.actor_role,
    relationshipId: row.relationship_id == null ? null : Number(row.relationship_id),
    previousVersion: Number(row.previous_version),
    resultingVersion: Number(row.resulting_version),
    occurredAt: row.occurred_at,
    persistedAt: row.persisted_at,
    payload: row.evidence_payload,
    sourceCommand: row.source_command,
    traceability: {
      governingCharterId: row.governing_charter_id,
      governingProgramId: row.governing_program_id,
      implementationMilestoneId: row.implementation_milestone_id,
      certificationTarget: row.certification_target,
    },
  };
}

function commandResult({ status, code, aggregate, evidence }) {
  return {
    ok: true,
    success: true,
    status,
    code,
    confirmed: true,
    authoritySource: AUTHORITY_SOURCE,
    aggregate: aggregateProjection(aggregate),
    evidence: evidenceProjection(evidence),
  };
}

async function rollback(client) {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the authoritative operation failure.
  }
}

function databaseClient(pool) {
  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("A database pool or client is required.");
  }
  return typeof pool.connect === "function" ? pool.connect() : Promise.resolve(pool);
}

async function createCommercialAggregate(input = {}) {
  const serverOwnedError = validateServerOwnedFields(input);
  if (serverOwnedError) return serverOwnedError;
  if (
    Object.hasOwn(input, "aggregateId") ||
    Object.hasOwn(input, "aggregate_id") ||
    Object.hasOwn(input, "id")
  ) {
    return failure(
      400,
      "COMMERCIAL_AUTHORITY_INVARIANT_VIOLATION",
      "Server-owned commercial authority fields cannot be supplied."
    );
  }

  const actor = validateAuthenticatedActor(input.authenticatedActor);
  if (actor.error) return actor.error;
  const type = validateAggregateType(input.aggregateType);
  if (type.error) return type.error;
  const source = validateSourceContext(input.sourceContext);
  if (source.error) return source.error;
  const idempotency = validateIdempotencyKey(input.idempotencyKey);
  if (idempotency.error) return idempotency.error;

  const definition = validateCommandDefinition({
    commandName:
      input.commandName === undefined ? COMMANDS.CREATE : input.commandName,
    expectedCommand: COMMANDS.CREATE,
    evidenceType:
      input.evidenceType === undefined
        ? EVIDENCE_TYPES.CREATED
        : input.evidenceType,
    expectedEvidence: EVIDENCE_TYPES.CREATED,
  });
  if (definition.error) return definition.error;

  const expectedVersion =
    input.expectedVersion == null ? 0 : nonNegativeInteger(input.expectedVersion);
  if (expectedVersion !== 0) {
    return failure(
      409,
      "STALE_COMMERCIAL_VERSION",
      "The commercial aggregate version is no longer current."
    );
  }

  const commandScope = sourceCommandScope(source.sourceContext);
  const requestFingerprint = fingerprint({
    aggregateType: type.aggregateType,
    commandName: definition.commandName,
    evidenceType: definition.evidenceType,
    expectedVersion,
    sourceContext: source.sourceContext,
  });

  const client = await databaseClient(input.pool);
  let transactionStarted = false;

  try {
    await client.query("BEGIN");
    transactionStarted = true;

    const idempotencyState = await reserveIdempotency({
      client,
      actorUserId: actor.id,
      commandName: definition.commandName,
      commandScope,
      idempotencyKey: idempotency.idempotencyKey,
      requestFingerprint,
    });

    if (idempotencyState.error) {
      await rollback(client);
      transactionStarted = false;
      return idempotencyState.error;
    }
    if (idempotencyState.replay) {
      await client.query("COMMIT");
      transactionStarted = false;
      return idempotencyState.replay;
    }

    const resolvedSource = await resolveSourceContext(
      client,
      source.sourceContext,
      actor.id
    );
    if (!resolvedSource) {
      await rollback(client);
      transactionStarted = false;
      return failure(
        404,
        "COMMERCIAL_AUTHORITY_UNAVAILABLE",
        "The commercial authority record is unavailable."
      );
    }

    const aggregateId = randomUUID();
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
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1)
      RETURNING *
      `,
      [
        aggregateId,
        type.aggregateType,
        OWNING_ENGINE,
        source.sourceContext.type,
        source.sourceContext.type === "ordinary_request"
          ? source.sourceContext.requestId
          : null,
        source.sourceContext.type === "emergency_request"
          ? source.sourceContext.emergencyRequestId
          : null,
        source.sourceContext.relationshipId,
        Number(resolvedSource.row.source_owner_user_id),
        actor.id,
      ]
    );
    const aggregate = aggregateResult.rows[0];
    if (!aggregate) {
      throw new Error("Commercial aggregate creation failed.");
    }

    const evidenceResult = await client.query(
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
        certification_target
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, 0, 1, $9, $10::jsonb, $11,
        $12, $13, $14, $15
      )
      RETURNING *
      `,
      [
        randomUUID(),
        aggregate.id,
        aggregate.aggregate_type,
        aggregate.owning_engine,
        definition.evidenceType,
        actor.id,
        resolvedSource.actorRole,
        source.sourceContext.relationshipId,
        idempotencyState.reservation.id,
        JSON.stringify({
          schemaVersion: 1,
          sourceContextType: source.sourceContext.type,
          relationshipScoped: Boolean(source.sourceContext.relationshipId),
        }),
        definition.commandName,
        TRACEABILITY.governingCharterId,
        TRACEABILITY.governingProgramId,
        TRACEABILITY.implementationMilestoneId,
        TRACEABILITY.certificationTarget,
      ]
    );
    const evidence = evidenceResult.rows[0];
    if (!evidence) {
      throw new Error("Commercial evidence creation failed.");
    }

    const result = commandResult({
      status: 201,
      code: "COMMERCIAL_AGGREGATE_CREATED",
      aggregate,
      evidence,
    });
    const completed = await completeIdempotency(
      client,
      idempotencyState.reservation.id,
      aggregate.id,
      result
    );
    if (!completed) {
      throw new Error("Commercial idempotency completion failed.");
    }

    await client.query("COMMIT");
    transactionStarted = false;
    return result;
  } catch (error) {
    if (transactionStarted) await rollback(client);
    throw error;
  } finally {
    if (client !== input.pool && typeof client.release === "function") {
      client.release();
    }
  }
}

async function advanceCommercialAggregate(input = {}) {
  const serverOwnedError = validateServerOwnedFields(input);
  if (serverOwnedError) return serverOwnedError;

  const actor = validateAuthenticatedActor(input.authenticatedActor);
  if (actor.error) return actor.error;
  const aggregateId = normalizedUuid(input.aggregateId);
  if (!aggregateId) {
    return failure(
      400,
      "INVALID_COMMERCIAL_AGGREGATE_ID",
      "A valid commercial aggregate ID is required."
    );
  }
  const expectedVersion = positiveInteger(input.expectedVersion);
  if (!expectedVersion) {
    return failure(
      400,
      "INVALID_COMMERCIAL_EXPECTED_VERSION",
      "A valid expected commercial version is required."
    );
  }
  const idempotency = validateIdempotencyKey(input.idempotencyKey);
  if (idempotency.error) return idempotency.error;

  const definition = validateCommandDefinition({
    commandName:
      input.commandName === undefined ? COMMANDS.ADVANCE : input.commandName,
    expectedCommand: COMMANDS.ADVANCE,
    evidenceType:
      input.evidenceType === undefined
        ? EVIDENCE_TYPES.VERSION_ADVANCED
        : input.evidenceType,
    expectedEvidence: EVIDENCE_TYPES.VERSION_ADVANCED,
  });
  if (definition.error) return definition.error;

  const commandScope = `aggregate:${aggregateId}`;
  const requestFingerprint = fingerprint({
    aggregateId,
    commandName: definition.commandName,
    evidenceType: definition.evidenceType,
    expectedVersion,
  });

  const client = await databaseClient(input.pool);
  let transactionStarted = false;

  try {
    await client.query("BEGIN");
    transactionStarted = true;

    const idempotencyState = await reserveIdempotency({
      client,
      actorUserId: actor.id,
      commandName: definition.commandName,
      commandScope,
      idempotencyKey: idempotency.idempotencyKey,
      requestFingerprint,
    });
    if (idempotencyState.error) {
      await rollback(client);
      transactionStarted = false;
      return idempotencyState.error;
    }
    if (idempotencyState.replay) {
      await client.query("COMMIT");
      transactionStarted = false;
      return idempotencyState.replay;
    }

    const aggregateResult = await client.query(
      `
      SELECT a.*
      FROM commercial_authority_aggregates AS a
      LEFT JOIN request_relationships AS rr
        ON rr.id = a.relationship_id
      WHERE a.id = $1
        AND (
          a.source_owner_user_id = $2
          OR rr.professional_user_id = $2
        )
      LIMIT 1
      FOR UPDATE OF a
      `,
      [aggregateId, actor.id]
    );
    const aggregate = aggregateResult.rows[0];
    if (!aggregate) {
      await rollback(client);
      transactionStarted = false;
      return failure(
        404,
        "COMMERCIAL_AGGREGATE_UNAVAILABLE",
        "The commercial aggregate is unavailable."
      );
    }

    if (Number(aggregate.current_version) !== expectedVersion) {
      await rollback(client);
      transactionStarted = false;
      return failure(
        409,
        "STALE_COMMERCIAL_VERSION",
        "The commercial aggregate version is no longer current."
      );
    }

    const resultingVersion = expectedVersion + 1;
    const updatedResult = await client.query(
      `
      UPDATE commercial_authority_aggregates
      SET
        current_version = $2,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
        AND current_version = $3
      RETURNING *
      `,
      [aggregateId, resultingVersion, expectedVersion]
    );
    const updatedAggregate = updatedResult.rows[0];
    if (!updatedAggregate) {
      await rollback(client);
      transactionStarted = false;
      return failure(
        409,
        "STALE_COMMERCIAL_VERSION",
        "The commercial aggregate version is no longer current."
      );
    }

    const actorRole =
      Number(updatedAggregate.source_owner_user_id) === actor.id
        ? "homeowner"
        : "professional";
    const evidenceResult = await client.query(
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
        certification_target
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13,
        $14, $15, $16, $17
      )
      RETURNING *
      `,
      [
        randomUUID(),
        updatedAggregate.id,
        updatedAggregate.aggregate_type,
        updatedAggregate.owning_engine,
        definition.evidenceType,
        actor.id,
        actorRole,
        updatedAggregate.relationship_id,
        expectedVersion,
        resultingVersion,
        idempotencyState.reservation.id,
        JSON.stringify({ schemaVersion: 1 }),
        definition.commandName,
        TRACEABILITY.governingCharterId,
        TRACEABILITY.governingProgramId,
        TRACEABILITY.implementationMilestoneId,
        TRACEABILITY.certificationTarget,
      ]
    );
    const evidence = evidenceResult.rows[0];
    if (!evidence) {
      throw new Error("Commercial evidence creation failed.");
    }

    const result = commandResult({
      status: 200,
      code: "COMMERCIAL_AGGREGATE_VERSION_ADVANCED",
      aggregate: updatedAggregate,
      evidence,
    });
    const completed = await completeIdempotency(
      client,
      idempotencyState.reservation.id,
      updatedAggregate.id,
      result
    );
    if (!completed) {
      throw new Error("Commercial idempotency completion failed.");
    }

    await client.query("COMMIT");
    transactionStarted = false;
    return result;
  } catch (error) {
    if (transactionStarted) await rollback(client);
    throw error;
  } finally {
    if (client !== input.pool && typeof client.release === "function") {
      client.release();
    }
  }
}

async function getCommercialAggregateEvidence(input = {}) {
  const actor = validateAuthenticatedActor(input.authenticatedActor);
  if (actor.error) return actor.error;
  const aggregateId = normalizedUuid(input.aggregateId);
  if (!aggregateId) {
    return failure(
      400,
      "INVALID_COMMERCIAL_AGGREGATE_ID",
      "A valid commercial aggregate ID is required."
    );
  }
  if (!input.pool || typeof input.pool.query !== "function") {
    throw new TypeError("A database pool or client is required.");
  }

  const aggregateResult = await input.pool.query(
    `
    SELECT a.*
    FROM commercial_authority_aggregates AS a
    LEFT JOIN request_relationships AS rr
      ON rr.id = a.relationship_id
    WHERE a.id = $1
      AND (
        a.source_owner_user_id = $2
        OR rr.professional_user_id = $2
      )
    LIMIT 1
    `,
    [aggregateId, actor.id]
  );
  const aggregate = aggregateResult.rows[0];
  if (!aggregate) {
    return failure(
      404,
      "COMMERCIAL_AGGREGATE_UNAVAILABLE",
      "The commercial aggregate is unavailable."
    );
  }

  const evidenceResult = await input.pool.query(
    `
    SELECT *
    FROM commercial_authority_evidence
    WHERE aggregate_id = $1
      AND aggregate_type = $2
      AND owning_engine = $3
    ORDER BY resulting_version ASC, persisted_at ASC, id ASC
    `,
    [aggregate.id, aggregate.aggregate_type, aggregate.owning_engine]
  );

  return {
    ok: true,
    success: true,
    status: 200,
    code: "COMMERCIAL_AGGREGATE_EVIDENCE_FOUND",
    confirmed: true,
    authoritySource: AUTHORITY_SOURCE,
    aggregate: aggregateProjection(aggregate),
    evidence: evidenceResult.rows.map(evidenceProjection),
  };
}

module.exports = {
  AGGREGATE_TYPES,
  AUTHORITY_SOURCE,
  COMMANDS,
  EVIDENCE_TYPES,
  OWNING_ENGINE,
  SOURCE_CONTEXT_TYPES,
  TRACEABILITY,
  advanceCommercialAggregate,
  createCommercialAggregate,
  getCommercialAggregateEvidence,
  validateAggregateType,
  validateSourceContext,
};
