"use strict";

function requirePool(pool) {
  if (!pool || typeof pool.connect !== "function") {
    throw new TypeError(
      "Quick Quote analysis persistence requires a database pool."
    );
  }
}

async function withTransaction(pool, work) {
  requirePool(pool);

  const client = await pool.connect();
  let started = false;

  try {
    await client.query("BEGIN");
    started = true;

    const result = await work(client);

    await client.query("COMMIT");
    started = false;

    return result;
  } catch (error) {
    if (started) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original persistence failure.
      }
    }

    throw error;
  } finally {
    client.release();
  }
}

async function withReadTransaction(pool, work) {
  requirePool(pool);

  const client = await pool.connect();
  let started = false;

  try {
    await client.query(
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"
    );
    started = true;

    const result = await work(client);

    await client.query("COMMIT");
    started = false;

    return result;
  } catch (error) {
    if (started) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original persistence failure.
      }
    }

    throw error;
  } finally {
    client.release();
  }
}

async function findCommand(
  client,
  {
    actorUserId,
    authorityScope,
    commandName,
    commandScope,
    idempotencyKey,
    lock = false,
  }
) {
  const result = await client.query(
    `
    /* quick_quote_analysis:command_find */
    SELECT *
    FROM quick_quote_analysis_command_idempotency
    WHERE actor_user_id = $1
      AND authority_scope = $2
      AND command_name = $3
      AND command_scope = $4
      AND idempotency_key = $5
    LIMIT 1
    ${lock ? "FOR UPDATE" : ""}
    `,
    [
      actorUserId,
      authorityScope,
      commandName,
      commandScope,
      idempotencyKey,
    ]
  );

  return result.rows[0] || null;
}

async function reserveCommand(
  client,
  {
    commandId,
    actorUserId,
    authorityScope,
    commandName,
    commandScope,
    idempotencyKey,
    requestFingerprint,
  }
) {
  const inserted = await client.query(
    `
    /* quick_quote_analysis:command_reserve */
    INSERT INTO quick_quote_analysis_command_idempotency (
      id,
      actor_user_id,
      authority_scope,
      command_name,
      command_scope,
      idempotency_key,
      request_fingerprint
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (
      actor_user_id,
      authority_scope,
      command_name,
      command_scope,
      idempotency_key
    )
    DO NOTHING
    RETURNING *
    `,
    [
      commandId,
      actorUserId,
      authorityScope,
      commandName,
      commandScope,
      idempotencyKey,
      requestFingerprint,
    ]
  );

  if (inserted.rows[0]) {
    return {
      created: true,
      record: inserted.rows[0],
    };
  }

  const existing = await findCommand(
    client,
    {
      actorUserId,
      authorityScope,
      commandName,
      commandScope,
      idempotencyKey,
      lock: true,
    }
  );

  if (!existing) {
    throw new Error(
      "Quick Quote analysis command reservation could not be resolved."
    );
  }

  return {
    created: false,
    record: existing,
  };
}

async function completeCommand(
  client,
  {
    commandId,
    resultReference,
  }
) {
  const result = await client.query(
    `
    /* quick_quote_analysis:command_complete */
    UPDATE quick_quote_analysis_command_idempotency
    SET
      result_reference = $2::jsonb,
      completed_at = CURRENT_TIMESTAMP
    WHERE id = $1
      AND result_reference IS NULL
      AND completed_at IS NULL
    RETURNING *
    `,
    [
      commandId,
      JSON.stringify(resultReference),
    ]
  );

  if (!result.rows[0]) {
    throw new Error(
      "Quick Quote analysis command completion could not be persisted."
    );
  }

  return result.rows[0];
}

async function createSessionRecord(
  client,
  {
    sessionId,
    actorUserId,
    authorityScope,
    commandId,
  }
) {
  const result = await client.query(
    `
    /* quick_quote_analysis:session_create */
    INSERT INTO quick_quote_analysis_sessions (
      id,
      actor_user_id,
      authority_scope,
      created_command_idempotency_id
    )
    VALUES ($1, $2, $3, $4)
    RETURNING *
    `,
    [
      sessionId,
      actorUserId,
      authorityScope,
      commandId,
    ]
  );

  return result.rows[0];
}

async function loadOwnedSession(
  client,
  {
    sessionId,
    actorUserId,
    lock = false,
  }
) {
  const result = await client.query(
    `
    /* quick_quote_analysis:session_owned */
    SELECT *
    FROM quick_quote_analysis_sessions
    WHERE id = $1
      AND actor_user_id = $2
    LIMIT 1
    ${lock ? "FOR UPDATE" : ""}
    `,
    [
      sessionId,
      actorUserId,
    ]
  );

  return result.rows[0] || null;
}

async function appendEvidenceRecord(
  client,
  {
    sessionId,
    version,
    actorUserId,
    professionalInput,
    photoReferences,
    evidenceFingerprint,
    commandId,
  }
) {
  const result = await client.query(
    `
    /* quick_quote_analysis:evidence_append */
    INSERT INTO quick_quote_analysis_evidence_versions (
      session_id,
      version,
      actor_user_id,
      professional_input,
      photo_references,
      evidence_fingerprint,
      command_idempotency_id
    )
    VALUES (
      $1,
      $2,
      $3,
      $4,
      $5::jsonb,
      $6,
      $7
    )
    RETURNING *
    `,
    [
      sessionId,
      version,
      actorUserId,
      professionalInput,
      JSON.stringify(photoReferences),
      evidenceFingerprint,
      commandId,
    ]
  );

  return result.rows[0];
}

async function loadLatestEvidence(
  client,
  {
    sessionId,
    actorUserId,
  }
) {
  const result = await client.query(
    `
    /* quick_quote_analysis:evidence_latest */
    SELECT *
    FROM quick_quote_analysis_evidence_versions
    WHERE session_id = $1
      AND actor_user_id = $2
    ORDER BY version DESC
    LIMIT 1
    `,
    [
      sessionId,
      actorUserId,
    ]
  );

  return result.rows[0] || null;
}

async function loadEvidenceVersion(
  client,
  {
    sessionId,
    actorUserId,
    version,
  }
) {
  const result = await client.query(
    `
    /* quick_quote_analysis:evidence_version */
    SELECT *
    FROM quick_quote_analysis_evidence_versions
    WHERE session_id = $1
      AND actor_user_id = $2
      AND version = $3
    LIMIT 1
    `,
    [
      sessionId,
      actorUserId,
      version,
    ]
  );

  return result.rows[0] || null;
}

async function listEvidence(
  client,
  {
    sessionId,
    actorUserId,
  }
) {
  const result = await client.query(
    `
    /* quick_quote_analysis:evidence_history */
    SELECT *
    FROM quick_quote_analysis_evidence_versions
    WHERE session_id = $1
      AND actor_user_id = $2
    ORDER BY version ASC
    `,
    [
      sessionId,
      actorUserId,
    ]
  );

  return result.rows;
}

async function nextEvidenceVersion(
  client,
  {
    sessionId,
    actorUserId,
  }
) {
  const result = await client.query(
    `
    /* quick_quote_analysis:evidence_next_version */
    SELECT COALESCE(MAX(version), 0)::int + 1 AS next_version
    FROM quick_quote_analysis_evidence_versions
    WHERE session_id = $1
      AND actor_user_id = $2
    `,
    [
      sessionId,
      actorUserId,
    ]
  );

  return Number(result.rows[0].next_version);
}

async function appendTurnRecord(
  client,
  {
    turnId,
    sessionId,
    turnIndex,
    actorUserId,
    evidenceVersion,
    role,
    turnPayload,
    commandId,
  }
) {
  const result = await client.query(
    `
    /* quick_quote_analysis:turn_append */
    INSERT INTO quick_quote_analysis_turns (
      id,
      session_id,
      turn_index,
      actor_user_id,
      evidence_version,
      role,
      turn_payload,
      command_idempotency_id
    )
    VALUES (
      $1,
      $2,
      $3,
      $4,
      $5,
      $6,
      $7::jsonb,
      $8
    )
    RETURNING *
    `,
    [
      turnId,
      sessionId,
      turnIndex,
      actorUserId,
      evidenceVersion,
      role,
      JSON.stringify(turnPayload),
      commandId,
    ]
  );

  return result.rows[0];
}

async function loadTurn(
  client,
  {
    turnId,
    sessionId,
    actorUserId,
  }
) {
  const result = await client.query(
    `
    /* quick_quote_analysis:turn_load */
    SELECT *
    FROM quick_quote_analysis_turns
    WHERE id = $1
      AND session_id = $2
      AND actor_user_id = $3
    LIMIT 1
    `,
    [
      turnId,
      sessionId,
      actorUserId,
    ]
  );

  return result.rows[0] || null;
}

async function listTurns(
  client,
  {
    sessionId,
    actorUserId,
  }
) {
  const result = await client.query(
    `
    /* quick_quote_analysis:turn_history */
    SELECT *
    FROM quick_quote_analysis_turns
    WHERE session_id = $1
      AND actor_user_id = $2
    ORDER BY turn_index ASC
    `,
    [
      sessionId,
      actorUserId,
    ]
  );

  return result.rows;
}

async function nextTurnIndex(
  client,
  {
    sessionId,
    actorUserId,
  }
) {
  const result = await client.query(
    `
    /* quick_quote_analysis:turn_next_index */
    SELECT COALESCE(MAX(turn_index), 0)::int + 1 AS next_index
    FROM quick_quote_analysis_turns
    WHERE session_id = $1
      AND actor_user_id = $2
    `,
    [
      sessionId,
      actorUserId,
    ]
  );

  return Number(result.rows[0].next_index);
}

async function deleteOwnedSession(
  client,
  {
    sessionId,
    actorUserId,
  }
) {
  const result = await client.query(
    `
    /* quick_quote_analysis:session_discard */
    DELETE FROM quick_quote_analysis_sessions
    WHERE id = $1
      AND actor_user_id = $2
    RETURNING id
    `,
    [
      sessionId,
      actorUserId,
    ]
  );

  return result.rows[0] || null;
}

module.exports = {
  appendEvidenceRecord,
  appendTurnRecord,
  completeCommand,
  createSessionRecord,
  deleteOwnedSession,
  findCommand,
  listEvidence,
  listTurns,
  loadEvidenceVersion,
  loadLatestEvidence,
  loadOwnedSession,
  loadTurn,
  nextEvidenceVersion,
  nextTurnIndex,
  reserveCommand,
  withReadTransaction,
  withTransaction,
};
