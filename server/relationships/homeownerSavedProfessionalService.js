"use strict";

const {
  createHash,
  randomUUID,
} = require("node:crypto");

function positiveInteger(value) {
  const parsed = Number(value);

  return Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : null;
}

function uuid(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();

  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    normalized
  )
    ? normalized
    : null;
}

function iso(value) {
  if (!value) return null;

  const parsed = new Date(value);

  return Number.isNaN(parsed.getTime())
    ? null
    : parsed.toISOString();
}

function failure(status, code, message, details = {}) {
  return {
    ok: false,
    status,
    code,
    message,
    ...details,
  };
}

function fingerprint(contractorProfileId) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        contractorProfileId,
      })
    )
    .digest("hex");
}

function serialize(row = {}) {
  return {
    savedProfessionalId:
      String(row.id || "").trim(),

    contractorProfileId:
      positiveInteger(row.contractor_profile_id),

    businessName:
      String(row.business_name || "").trim(),

    category:
      String(row.category || "").trim(),

    imageUrl:
      String(row.image_url || "").trim(),

    status:
      String(row.status || "").trim(),

    savedAt:
      iso(row.saved_at),

    removedAt:
      iso(row.removed_at),

    version:
      positiveInteger(row.version),
  };
}

async function resolveProfessional(
  client,
  contractorProfileId
) {
  const result = await client.query(
    `
    /* homeowner_saved_professional:resolve_business */
    SELECT
      id,
      user_id,
      business_name,
      category,
      image_url
    FROM contractor_profiles
    WHERE id = $1
    LIMIT 1
    `,
    [contractorProfileId]
  );

  return result.rows[0] || null;
}

async function loadState(
  client,
  homeownerUserId,
  contractorProfileId,
  { lock = false } = {}
) {
  const result = await client.query(
    `
    /* homeowner_saved_professional:load_state */
    SELECT
      saved.*,
      profiles.business_name,
      profiles.category,
      profiles.image_url
    FROM homeowner_saved_professionals saved
    INNER JOIN contractor_profiles profiles
      ON profiles.id =
         saved.contractor_profile_id
     AND profiles.user_id =
         saved.professional_user_id
    WHERE saved.homeowner_user_id = $1
      AND saved.contractor_profile_id = $2
    LIMIT 1
    ${lock ? "FOR UPDATE OF saved" : ""}
    `,
    [
      homeownerUserId,
      contractorProfileId,
    ]
  );

  return result.rows[0] || null;
}

async function reserveCommand({
  client,
  homeownerUserId,
  operation,
  idempotencyKey,
  requestHash,
  contractorProfileId,
  professionalUserId,
}) {
  const inserted = await client.query(
    `
    /* homeowner_saved_professional:reserve_command */
    INSERT INTO homeowner_saved_professional_commands (
      id,
      homeowner_user_id,
      operation,
      idempotency_key,
      request_hash,
      contractor_profile_id,
      professional_user_id
    )
    VALUES (
      $1, $2, $3, $4, $5, $6, $7
    )
    ON CONFLICT (
      homeowner_user_id,
      operation,
      idempotency_key
    )
    DO NOTHING
    RETURNING *
    `,
    [
      randomUUID(),
      homeownerUserId,
      operation,
      idempotencyKey,
      requestHash,
      contractorProfileId,
      professionalUserId,
    ]
  );

  if (inserted.rows[0]) {
    return {
      command: inserted.rows[0],
      replay: null,
    };
  }

  const existing = await client.query(
    `
    /* homeowner_saved_professional:load_command */
    SELECT *
    FROM homeowner_saved_professional_commands
    WHERE homeowner_user_id = $1
      AND operation = $2
      AND idempotency_key = $3
    LIMIT 1
    FOR UPDATE
    `,
    [
      homeownerUserId,
      operation,
      idempotencyKey,
    ]
  );

  const command = existing.rows[0];

  if (!command) {
    throw new Error(
      "Saved Professional command reservation could not be resolved."
    );
  }

  if (command.request_hash !== requestHash) {
    return {
      command: null,
      replay: failure(
        409,
        "SAVED_PROFESSIONAL_IDEMPOTENCY_CONFLICT",
        "The save identity was already used for a different professional."
      ),
    };
  }

  if (!command.completed_at) {
    return {
      command: null,
      replay: failure(
        409,
        "SAVED_PROFESSIONAL_COMMAND_IN_PROGRESS",
        "This Saved Professional request is already in progress."
      ),
    };
  }

  const response =
    command.response_json &&
    typeof command.response_json === "object"
      ? command.response_json
      : null;

  if (!response) {
    throw new Error(
      "Completed Saved Professional command has no response."
    );
  }

  return {
    command: null,
    replay: {
      ...response,
      replayed: true,
    },
  };
}

async function finishCommand({
  client,
  commandId,
  savedProfessionalId,
  response,
}) {
  const completed = await client.query(
    `
    /* homeowner_saved_professional:finish_command */
    UPDATE homeowner_saved_professional_commands
    SET
      saved_professional_id = $2,
      response_json = $3::jsonb,
      completed_at = CURRENT_TIMESTAMP
    WHERE id = $1
      AND completed_at IS NULL
    RETURNING id
    `,
    [
      commandId,
      savedProfessionalId,
      JSON.stringify(response),
    ]
  );

  if (!completed.rows[0]) {
    throw new Error(
      "Saved Professional command completion failed."
    );
  }
}

async function mutate({
  pool,
  authenticatedActor,
  contractorProfileId: rawContractorProfileId,
  idempotencyKey: rawIdempotencyKey,
  operation,
} = {}) {
  const homeownerUserId =
    positiveInteger(authenticatedActor?.id);

  if (!homeownerUserId) {
    return failure(
      401,
      "AUTHENTICATION_REQUIRED",
      "Authentication is required."
    );
  }

  const contractorProfileId =
    positiveInteger(rawContractorProfileId);

  if (!contractorProfileId) {
    return failure(
      400,
      "PROFESSIONAL_ID_INVALID",
      "A valid professional is required."
    );
  }

  const idempotencyKey =
    uuid(rawIdempotencyKey);

  if (!idempotencyKey) {
    return failure(
      400,
      "SAVED_PROFESSIONAL_IDEMPOTENCY_REQUIRED",
      "A valid save identity is required."
    );
  }

  if (
    !pool ||
    typeof pool.query !== "function" &&
    typeof pool.connect !== "function"
  ) {
    throw new TypeError(
      "A database pool or client is required."
    );
  }

  const client =
    typeof pool.connect === "function"
      ? await pool.connect()
      : pool;

  let transactionStarted = false;

  try {
    await client.query("BEGIN");
    transactionStarted = true;

    const professional =
      await resolveProfessional(
        client,
        contractorProfileId
      );

    if (!professional) {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return failure(
        404,
        "PROFESSIONAL_NOT_FOUND",
        "The professional was not found."
      );
    }

    const professionalUserId =
      positiveInteger(professional.user_id);

    if (
      !professionalUserId ||
      professionalUserId === homeownerUserId
    ) {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return failure(
        409,
        "PROFESSIONAL_SAVE_UNAVAILABLE",
        "This professional cannot be saved by this account."
      );
    }

    const reservation =
      await reserveCommand({
        client,
        homeownerUserId,
        operation,
        idempotencyKey,
        requestHash:
          fingerprint(contractorProfileId),
        contractorProfileId,
        professionalUserId,
      });

    if (reservation.replay) {
      await client.query("COMMIT");
      transactionStarted = false;

      return reservation.replay;
    }

    let current =
      await loadState(
        client,
        homeownerUserId,
        contractorProfileId,
        {
          lock: true,
        }
      );

    let code;
    let status;

    if (operation === "SAVE") {
      if (!current) {
        const inserted =
          await client.query(
            `
            /* homeowner_saved_professional:create */
            INSERT INTO homeowner_saved_professionals (
              id,
              homeowner_user_id,
              contractor_profile_id,
              professional_user_id,
              status,
              version
            )
            VALUES (
              $1, $2, $3, $4,
              'SAVED', 1
            )
            RETURNING *
            `,
            [
              randomUUID(),
              homeownerUserId,
              contractorProfileId,
              professionalUserId,
            ]
          );

        current = inserted.rows[0];

        code =
          "HOMEOWNER_PROFESSIONAL_SAVED";

        status = 201;
      } else if (current.status === "SAVED") {
        code =
          "HOMEOWNER_PROFESSIONAL_ALREADY_SAVED";

        status = 200;
      } else if (current.status === "REMOVED") {
        const restored =
          await client.query(
            `
            /* homeowner_saved_professional:restore */
            UPDATE homeowner_saved_professionals
            SET
              status = 'SAVED',
              version = version + 1,
              saved_at = GREATEST(
                CURRENT_TIMESTAMP,
                saved_at + INTERVAL '1 microsecond'
              ),
              removed_at = NULL
            WHERE id = $1
              AND homeowner_user_id = $2
              AND contractor_profile_id = $3
              AND status = 'REMOVED'
            RETURNING *
            `,
            [
              current.id,
              homeownerUserId,
              contractorProfileId,
            ]
          );

        current = restored.rows[0];

        if (!current) {
          throw new Error(
            "Saved Professional restore conflict."
          );
        }

        code =
          "HOMEOWNER_PROFESSIONAL_SAVED";

        status = 200;
      } else {
        throw new Error(
          "Saved Professional state is invalid."
        );
      }
    } else if (operation === "REMOVE") {
      if (!current) {
        await client.query("ROLLBACK");
        transactionStarted = false;

        return failure(
          404,
          "SAVED_PROFESSIONAL_NOT_FOUND",
          "The saved professional was not found."
        );
      }

      if (current.status === "REMOVED") {
        code =
          "HOMEOWNER_PROFESSIONAL_ALREADY_REMOVED";

        status = 200;
      } else if (current.status === "SAVED") {
        const removed =
          await client.query(
            `
            /* homeowner_saved_professional:remove */
            UPDATE homeowner_saved_professionals
            SET
              status = 'REMOVED',
              version = version + 1,
              removed_at = CURRENT_TIMESTAMP
            WHERE id = $1
              AND homeowner_user_id = $2
              AND contractor_profile_id = $3
              AND status = 'SAVED'
            RETURNING *
            `,
            [
              current.id,
              homeownerUserId,
              contractorProfileId,
            ]
          );

        current = removed.rows[0];

        if (!current) {
          throw new Error(
            "Saved Professional remove conflict."
          );
        }

        code =
          "HOMEOWNER_PROFESSIONAL_REMOVED";

        status = 200;
      } else {
        throw new Error(
          "Saved Professional state is invalid."
        );
      }
    } else {
      throw new TypeError(
        "A supported Saved Professional operation is required."
      );
    }

    current = {
      ...current,
      business_name:
        professional.business_name,
      category:
        professional.category,
      image_url:
        professional.image_url,
    };

    const response = {
      ok: true,
      status,
      code,
      savedProfessional:
        serialize(current),
    };

    await finishCommand({
      client,
      commandId:
        reservation.command.id,
      savedProfessionalId:
        current.id,
      response,
    });

    await client.query("COMMIT");
    transactionStarted = false;

    return response;
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve primary failure.
      }
    }

    throw error;
  } finally {
    if (
      client !== pool &&
      typeof client.release === "function"
    ) {
      client.release();
    }
  }
}

function saveHomeownerProfessional(input = {}) {
  return mutate({
    ...input,
    operation: "SAVE",
  });
}

function removeHomeownerSavedProfessional(
  input = {}
) {
  return mutate({
    ...input,
    operation: "REMOVE",
  });
}

module.exports = {
  removeHomeownerSavedProfessional,
  saveHomeownerProfessional,
};
