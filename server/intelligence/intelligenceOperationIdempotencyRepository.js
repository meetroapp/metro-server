"use strict";

const OPERATION_COLUMNS = `
  id,
  actor_user_id,
  authority_scope,
  operation,
  idempotency_key,
  request_fingerprint,
  status,
  provider_execution_state,
  result_classification,
  result_payload,
  error_classification,
  usage_state,
  usage_classification,
  correlation_id,
  version,
  created_at,
  started_at,
  completed_at,
  failed_at,
  updated_at
`;

function requirePool(pool) {
  if (!pool || typeof pool.connect !== "function") {
    throw new TypeError("A database pool with connect() is required.");
  }
}

async function withTransaction(pool, work) {
  requirePool(pool);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original persistence failure.
    }
    throw error;
  } finally {
    client.release();
  }
}

async function reserveIntelligenceOperation({
  pool,
  operationId,
  actorUserId,
  authorityScope,
  operation,
  idempotencyKey,
  requestFingerprint,
  correlationId,
}) {
  return withTransaction(pool, async (client) => {
    const inserted = await client.query(
      `
      /* intelligence_operation:idempotency_reserve */
      INSERT INTO intelligence_operation_idempotency
      (
        id,
        actor_user_id,
        authority_scope,
        operation,
        idempotency_key,
        request_fingerprint,
        correlation_id
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (
        actor_user_id,
        authority_scope,
        operation,
        idempotency_key
      )
      DO NOTHING
      RETURNING ${OPERATION_COLUMNS}
      `,
      [
        operationId,
        actorUserId,
        authorityScope,
        operation,
        idempotencyKey,
        requestFingerprint,
        correlationId,
      ]
    );

    if (inserted.rows[0]) {
      const owned = await client.query(
        `
        /* intelligence_operation:execution_claim */
        UPDATE intelligence_operation_idempotency
        SET
          status = 'executing',
          provider_execution_state = 'started',
          started_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP,
          version = version + 1
        WHERE id = $1
          AND status = 'reserved'
          AND provider_execution_state = 'not_started'
        RETURNING ${OPERATION_COLUMNS}
        `,
        [operationId]
      );

      if (!owned.rows[0]) {
        throw new Error("Intelligence operation execution ownership could not be established.");
      }

      return { created: true, record: owned.rows[0] };
    }

    const existing = await client.query(
      `
      /* intelligence_operation:idempotency_existing */
      SELECT ${OPERATION_COLUMNS}
      FROM intelligence_operation_idempotency
      WHERE actor_user_id = $1
        AND authority_scope = $2
        AND operation = $3
        AND idempotency_key = $4
      FOR UPDATE
      `,
      [actorUserId, authorityScope, operation, idempotencyKey]
    );

    if (!existing.rows[0]) {
      throw new Error("Intelligence operation reservation could not be resolved.");
    }

    return { created: false, record: existing.rows[0] };
  });
}

async function recordProviderSuccess({
  pool,
  operationId,
  resultClassification,
  resultPayload,
}) {
  return withTransaction(pool, async (client) => {
    const result = await client.query(
      `
      /* intelligence_operation:provider_success */
      UPDATE intelligence_operation_idempotency
      SET
        provider_execution_state = 'succeeded',
        result_classification = $2,
        result_payload = $3::jsonb,
        updated_at = CURRENT_TIMESTAMP,
        version = version + 1
      WHERE id = $1
        AND status = 'executing'
        AND provider_execution_state = 'started'
        AND usage_state = 'pending'
      RETURNING ${OPERATION_COLUMNS}
      `,
      [operationId, resultClassification, JSON.stringify(resultPayload)]
    );

    if (!result.rows[0]) {
      throw new Error("Intelligence provider success could not be persisted.");
    }
    return result.rows[0];
  });
}

async function claimUsageFinalization({ pool, operationId }) {
  return withTransaction(pool, async (client) => {
    const result = await client.query(
      `
      /* intelligence_operation:usage_claim */
      UPDATE intelligence_operation_idempotency
      SET
        usage_state = 'finalizing',
        updated_at = CURRENT_TIMESTAMP,
        version = version + 1
      WHERE id = $1
        AND status = 'executing'
        AND provider_execution_state = 'succeeded'
        AND usage_state = 'pending'
      RETURNING ${OPERATION_COLUMNS}
      `,
      [operationId]
    );

    if (!result.rows[0]) {
      throw new Error("Intelligence usage finalization ownership could not be established.");
    }
    return result.rows[0];
  });
}

async function completeIntelligenceOperation({
  pool,
  operationId,
  expectedUsageState,
  usageState,
  usageClassification,
}) {
  return withTransaction(pool, async (client) => {
    const result = await client.query(
      `
      /* intelligence_operation:complete */
      UPDATE intelligence_operation_idempotency
      SET
        status = 'completed',
        usage_state = $3,
        usage_classification = $4,
        completed_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP,
        version = version + 1
      WHERE id = $1
        AND status = 'executing'
        AND provider_execution_state = 'succeeded'
        AND usage_state = $2
      RETURNING ${OPERATION_COLUMNS}
      `,
      [operationId, expectedUsageState, usageState, usageClassification]
    );

    if (!result.rows[0]) {
      throw new Error("Intelligence operation completion could not be persisted.");
    }
    return result.rows[0];
  });
}

async function failIntelligenceOperation({
  pool,
  operationId,
  providerExecutionState,
  usageState,
  errorClassification,
  resultClassification = null,
  resultPayload = null,
}) {
  return withTransaction(pool, async (client) => {
    const result = await client.query(
      `
      /* intelligence_operation:fail */
      UPDATE intelligence_operation_idempotency
      SET
        status = 'failed',
        provider_execution_state = $2,
        usage_state = $3,
        error_classification = $4,
        result_classification = COALESCE($5, result_classification),
        result_payload = COALESCE($6::jsonb, result_payload),
        failed_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP,
        version = version + 1
      WHERE id = $1
        AND status = 'executing'
      RETURNING ${OPERATION_COLUMNS}
      `,
      [
        operationId,
        providerExecutionState,
        usageState,
        errorClassification,
        resultClassification,
        resultPayload ? JSON.stringify(resultPayload) : null,
      ]
    );

    return result.rows[0] || null;
  });
}

module.exports = {
  claimUsageFinalization,
  completeIntelligenceOperation,
  failIntelligenceOperation,
  recordProviderSuccess,
  reserveIntelligenceOperation,
};
