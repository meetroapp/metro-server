"use strict";

const {
  createHash,
  randomUUID,
} = require("node:crypto");

const repository =
  require("./quickQuoteAnalysisSessionRepository");

const {
  cloneBoundedJson,
  isPlainObject,
  normalizeIdempotencyKey,
} = require("./intelligenceGatewayContracts");

const {
  normalizeQuoteDraftPhotoCollection,
} = require("../media/quoteDraftPhoto");

const {
  findOwnedContractorProfileId,
} = require("../media/uploadSignature");

const AUTHORITY_CLASSIFICATION =
  "PRIVATE_NON_CANONICAL";

const COMMANDS = Object.freeze({
  CREATE:
    "quick_quote.analysis_session.create",
  EVIDENCE:
    "quick_quote.analysis_evidence.append",
  TURN:
    "quick_quote.analysis_turn.append",
  DISCARD:
    "quick_quote.analysis_session.discard",
});

const TURN_ROLES = new Set([
  "PROFESSIONAL",
  "MEETRO",
]);

function response(
  ok,
  status,
  code,
  message,
  extra = {}
) {
  return {
    ok,
    status,
    code,
    message,
    ...extra,
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value
      .map(canonicalJson)
      .join(",")}]`;
  }

  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(
            value[key]
          )}`
      )
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function fingerprint(value) {
  return createHash("sha256")
    .update(canonicalJson(value))
    .digest("hex");
}

function normalizeActor(actor) {
  const id = Number(actor?.id);

  return Number.isInteger(id) && id > 0
    ? { id }
    : null;
}

function normalizeUuid(value) {
  const normalized =
    typeof value === "string"
      ? value.trim().toLowerCase()
      : "";

  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    normalized
  )
    ? normalized
    : null;
}

function normalizeProfessionalInput(value) {
  if (value == null) return "";

  if (
    typeof value !== "string" ||
    value.length > 4000
  ) {
    return null;
  }

  return value;
}

function normalizeRawPhotos(value) {
  if (value == null) return [];

  if (
    !Array.isArray(value) ||
    value.length > 5
  ) {
    return null;
  }

  return value;
}

function persistedPhotoReference(photo) {
  return {
    type: "QUOTE_DRAFT_PHOTO",
    publicId: photo.public_id,
    secureUrl: photo.secure_url,
    version: photo.version,
    format: photo.format,
    width: photo.width,
    height: photo.height,
    displayOrder: photo.display_order,
  };
}

function fingerprintPhotoReference(photo) {
  return {
    type: photo.type,
    publicId: photo.publicId,
    version: photo.version,
    format: photo.format,
    width: photo.width,
    height: photo.height,
    displayOrder: photo.displayOrder,
  };
}

function evidenceFingerprint({
  professionalInput,
  photoReferences,
}) {
  return fingerprint({
    professionalInput,
    photoReferences:
      photoReferences.map(
        fingerprintPhotoReference
      ),
  });
}

function evidenceProjection(row) {
  if (!row) return null;

  return {
    version: Number(row.version),
    professionalInput:
      row.professional_input,
    photoReferences:
      row.photo_references || [],
    evidenceFingerprint:
      row.evidence_fingerprint,
    createdAt:
      new Date(row.created_at).toISOString(),
  };
}

function turnProjection(row) {
  if (!row) return null;

  return {
    turnId: row.id,
    turnIndex: Number(row.turn_index),
    evidenceVersion:
      Number(row.evidence_version),
    role: row.role,
    authorityClassification:
      row.authority_classification,
    payload: row.turn_payload || {},
    createdAt:
      new Date(row.created_at).toISOString(),
  };
}

async function sessionProjection(
  persistence,
  client,
  sessionRow
) {
  const evidenceRows =
    await persistence.listEvidence(
      client,
      {
        sessionId: sessionRow.id,
        actorUserId:
          Number(sessionRow.actor_user_id),
      }
    );

  const turnRows =
    await persistence.listTurns(
      client,
      {
        sessionId: sessionRow.id,
        actorUserId:
          Number(sessionRow.actor_user_id),
      }
    );

  const evidenceVersions =
    evidenceRows.map(evidenceProjection);

  const turns =
    turnRows.map(turnProjection);

  return {
    sessionId: sessionRow.id,
    authorityClassification:
      sessionRow.authority_classification,
    createdAt:
      new Date(
        sessionRow.created_at
      ).toISOString(),
    latestEvidenceVersion:
      evidenceVersions.length
        ? evidenceVersions[
            evidenceVersions.length - 1
          ].version
        : null,
    latestTurnIndex:
      turns.length
        ? turns[turns.length - 1]
            .turnIndex
        : 0,
    evidenceVersions,
    turns,
  };
}

function commandScope(
  commandName,
  sessionId = null
) {
  if (commandName === COMMANDS.CREATE) {
    return "analysis-session:create";
  }

  if (commandName === COMMANDS.EVIDENCE) {
    return `analysis-session:${sessionId}:evidence`;
  }

  if (commandName === COMMANDS.TURN) {
    return `analysis-session:${sessionId}:turn`;
  }

  if (commandName === COMMANDS.DISCARD) {
    return `analysis-session:${sessionId}:discard`;
  }

  throw new TypeError(
    "Unknown Quick Quote analysis command."
  );
}

function baseValidation(input) {
  const actor =
    normalizeActor(
      input?.authenticatedActor
    );

  if (!actor) {
    return {
      error: response(
        false,
        401,
        "QUICK_QUOTE_ANALYSIS_AUTHENTICATION_REQUIRED",
        "Authentication required."
      ),
    };
  }

  if (
    !input?.pool ||
    typeof input.pool.connect !== "function"
  ) {
    throw new TypeError(
      "A database pool is required."
    );
  }

  return { actor };
}

function commandValidation(input) {
  const base = baseValidation(input);

  if (base.error) return base;

  const idempotencyKey =
    normalizeIdempotencyKey(
      input?.idempotencyKey
    );

  if (!idempotencyKey) {
    return {
      error: response(
        false,
        400,
        "QUICK_QUOTE_ANALYSIS_IDEMPOTENCY_REQUIRED",
        "A valid idempotency key is required."
      ),
    };
  }

  return {
    actor: base.actor,
    idempotencyKey,
  };
}

function evidenceInputValidation(input) {
  const professionalInput =
    normalizeProfessionalInput(
      input?.professionalInput
    );

  const photos =
    normalizeRawPhotos(input?.photos);

  if (
    professionalInput == null ||
    photos == null ||
    (
      professionalInput.trim().length === 0 &&
      photos.length === 0
    )
  ) {
    return {
      error: response(
        false,
        400,
        "QUICK_QUOTE_ANALYSIS_EVIDENCE_INVALID",
        "Job Analysis requires professional details or governed photos."
      ),
    };
  }

  return {
    professionalInput,
    photos,
  };
}

async function normalizeEvidence({
  client,
  actorUserId,
  professionalInput,
  photos,
  env,
  resolveProfessionalProfileId,
  normalizePhotoCollection,
}) {
  const contractorProfileId =
    await resolveProfessionalProfileId(
      client,
      actorUserId
    );

  if (!contractorProfileId) {
    return {
      error: response(
        false,
        404,
        "QUICK_QUOTE_ANALYSIS_AUTHORITY_UNAVAILABLE",
        "Job Analysis authority is unavailable."
      ),
    };
  }

  let normalizedPhotos;

  try {
    normalizedPhotos =
      normalizePhotoCollection(
        photos,
        {
          env,
          contractorProfileId,
        }
      );
  } catch {
    return {
      error: response(
        false,
        400,
        "QUICK_QUOTE_ANALYSIS_EVIDENCE_INVALID",
        "Job Analysis evidence is invalid."
      ),
    };
  }

  const photoReferences =
    normalizedPhotos.map(
      persistedPhotoReference
    );

  return {
    professionalInput,
    photoReferences,
    evidenceFingerprint:
      evidenceFingerprint({
        professionalInput,
        photoReferences,
      }),
  };
}

function commandConflict(record, expected) {
  return (
    !record ||
    record.request_fingerprint !==
      expected
  );
}

function commandIncomplete(record) {
  return (
    !record.result_reference ||
    !record.completed_at
  );
}

function createQuickQuoteAnalysisSessionService({
  persistence = repository,
  env = process.env,
  randomId = randomUUID,
  resolveProfessionalProfileId =
    findOwnedContractorProfileId,
  normalizePhotoCollection =
    normalizeQuoteDraftPhotoCollection,
} = {}) {
  async function createSession(
    input = {}
  ) {
    const command =
      commandValidation(input);

    if (command.error) {
      return command.error;
    }

    const evidenceInput =
      evidenceInputValidation(input);

    if (evidenceInput.error) {
      return evidenceInput.error;
    }

    return persistence.withTransaction(
      input.pool,
      async (client) => {
        const evidence =
          await normalizeEvidence({
            client,
            actorUserId:
              command.actor.id,
            ...evidenceInput,
            env,
            resolveProfessionalProfileId,
            normalizePhotoCollection,
          });

        if (evidence.error) {
          return evidence.error;
        }

        const authorityScope =
          `user:${command.actor.id}`;

        const scope =
          commandScope(COMMANDS.CREATE);

        const requestFingerprint =
          fingerprint({
            command:
              COMMANDS.CREATE,
            authorityClassification:
              AUTHORITY_CLASSIFICATION,
            evidenceFingerprint:
              evidence.evidenceFingerprint,
          });

        const reservation =
          await persistence.reserveCommand(
            client,
            {
              commandId: randomId(),
              actorUserId:
                command.actor.id,
              authorityScope,
              commandName:
                COMMANDS.CREATE,
              commandScope: scope,
              idempotencyKey:
                command.idempotencyKey,
              requestFingerprint,
            }
          );

        if (!reservation.created) {
          if (
            commandConflict(
              reservation.record,
              requestFingerprint
            )
          ) {
            return response(
              false,
              409,
              "QUICK_QUOTE_ANALYSIS_COMMAND_CONFLICT",
              "The idempotency key was already used for different input."
            );
          }

          if (
            commandIncomplete(
              reservation.record
            )
          ) {
            return response(
              false,
              409,
              "QUICK_QUOTE_ANALYSIS_COMMAND_IN_PROGRESS",
              "The Job Analysis command is still in progress."
            );
          }

          const sessionId =
            reservation.record
              .result_reference
              ?.sessionId;

          const existing =
            sessionId
              ? await persistence
                  .loadOwnedSession(
                    client,
                    {
                      sessionId,
                      actorUserId:
                        command.actor.id,
                    }
                  )
              : null;

          if (!existing) {
            return response(
              false,
              404,
              "QUICK_QUOTE_ANALYSIS_SESSION_UNAVAILABLE",
              "The Job Analysis session is unavailable."
            );
          }

          return response(
            true,
            200,
            "QUICK_QUOTE_ANALYSIS_SESSION_REPLAYED",
            "The Job Analysis session was restored.",
            {
              session:
                await sessionProjection(
                  persistence,
                  client,
                  existing
                ),
              replayed: true,
              canonicalMutationPerformed:
                false,
            }
          );
        }

        const sessionId =
          randomId();

        const session =
          await persistence
            .createSessionRecord(
              client,
              {
                sessionId,
                actorUserId:
                  command.actor.id,
                authorityScope,
                commandId:
                  reservation.record.id,
              }
            );

        const evidenceRow =
          await persistence
            .appendEvidenceRecord(
              client,
              {
                sessionId,
                version: 1,
                actorUserId:
                  command.actor.id,
                professionalInput:
                  evidence.professionalInput,
                photoReferences:
                  evidence.photoReferences,
                evidenceFingerprint:
                  evidence.evidenceFingerprint,
                commandId:
                  reservation.record.id,
              }
            );

        await persistence
          .completeCommand(
            client,
            {
              commandId:
                reservation.record.id,
              resultReference: {
                sessionId,
                evidenceVersion: 1,
                evidenceFingerprint:
                  evidenceRow
                    .evidence_fingerprint,
              },
            }
          );

        return response(
          true,
          201,
          "QUICK_QUOTE_ANALYSIS_SESSION_CREATED",
          "A private Job Analysis session was created.",
          {
            session:
              await sessionProjection(
                persistence,
                client,
                session
              ),
            replayed: false,
            canonicalMutationPerformed:
              false,
          }
        );
      }
    );
  }

  async function getSession(
    input = {}
  ) {
    const validated =
      baseValidation(input);

    if (validated.error) {
      return validated.error;
    }

    const sessionId =
      normalizeUuid(input.sessionId);

    if (!sessionId) {
      return response(
        false,
        400,
        "QUICK_QUOTE_ANALYSIS_SESSION_INVALID",
        "A valid Job Analysis session is required."
      );
    }

    return persistence
      .withReadTransaction(
        input.pool,
        async (client) => {
          const session =
            await persistence
              .loadOwnedSession(
                client,
                {
                  sessionId,
                  actorUserId:
                    validated.actor.id,
                }
              );

          if (!session) {
            return response(
              false,
              404,
              "QUICK_QUOTE_ANALYSIS_SESSION_UNAVAILABLE",
              "The Job Analysis session is unavailable."
            );
          }

          return response(
            true,
            200,
            "QUICK_QUOTE_ANALYSIS_SESSION_LOADED",
            "The private Job Analysis session was loaded.",
            {
              session:
                await sessionProjection(
                  persistence,
                  client,
                  session
                ),
              canonicalMutationPerformed:
                false,
            }
          );
        }
      );
  }

  async function appendEvidence(
    input = {}
  ) {
    const command =
      commandValidation(input);

    if (command.error) {
      return command.error;
    }

    const sessionId =
      normalizeUuid(input.sessionId);

    if (!sessionId) {
      return response(
        false,
        400,
        "QUICK_QUOTE_ANALYSIS_SESSION_INVALID",
        "A valid Job Analysis session is required."
      );
    }

    const evidenceInput =
      evidenceInputValidation(input);

    if (evidenceInput.error) {
      return evidenceInput.error;
    }

    return persistence.withTransaction(
      input.pool,
      async (client) => {
        const session =
          await persistence
            .loadOwnedSession(
              client,
              {
                sessionId,
                actorUserId:
                  command.actor.id,
                lock: true,
              }
            );

        if (!session) {
          return response(
            false,
            404,
            "QUICK_QUOTE_ANALYSIS_SESSION_UNAVAILABLE",
            "The Job Analysis session is unavailable."
          );
        }

        const evidence =
          await normalizeEvidence({
            client,
            actorUserId:
              command.actor.id,
            ...evidenceInput,
            env,
            resolveProfessionalProfileId,
            normalizePhotoCollection,
          });

        if (evidence.error) {
          return evidence.error;
        }

        const authorityScope =
          `user:${command.actor.id}`;

        const scope =
          commandScope(
            COMMANDS.EVIDENCE,
            sessionId
          );

        const requestFingerprint =
          fingerprint({
            command:
              COMMANDS.EVIDENCE,
            sessionId,
            evidenceFingerprint:
              evidence.evidenceFingerprint,
          });

        const reservation =
          await persistence.reserveCommand(
            client,
            {
              commandId: randomId(),
              actorUserId:
                command.actor.id,
              authorityScope,
              commandName:
                COMMANDS.EVIDENCE,
              commandScope: scope,
              idempotencyKey:
                command.idempotencyKey,
              requestFingerprint,
            }
          );

        if (!reservation.created) {
          if (
            commandConflict(
              reservation.record,
              requestFingerprint
            )
          ) {
            return response(
              false,
              409,
              "QUICK_QUOTE_ANALYSIS_COMMAND_CONFLICT",
              "The idempotency key was already used for different input."
            );
          }

          if (
            commandIncomplete(
              reservation.record
            )
          ) {
            return response(
              false,
              409,
              "QUICK_QUOTE_ANALYSIS_COMMAND_IN_PROGRESS",
              "The Job Analysis command is still in progress."
            );
          }

          const version =
            Number(
              reservation.record
                .result_reference
                ?.evidenceVersion
            );

          const evidenceRow =
            Number.isInteger(version)
              ? await persistence
                  .loadEvidenceVersion(
                    client,
                    {
                      sessionId,
                      actorUserId:
                        command.actor.id,
                      version,
                    }
                  )
              : null;

          if (!evidenceRow) {
            return response(
              false,
              404,
              "QUICK_QUOTE_ANALYSIS_EVIDENCE_UNAVAILABLE",
              "The Job Analysis evidence is unavailable."
            );
          }

          return response(
            true,
            200,
            "QUICK_QUOTE_ANALYSIS_EVIDENCE_REPLAYED",
            "The Job Analysis evidence was restored.",
            {
              evidence:
                evidenceProjection(
                  evidenceRow
                ),
              changed:
                reservation.record
                  .result_reference
                  ?.changed !== false,
              replayed: true,
              canonicalMutationPerformed:
                false,
            }
          );
        }

        const latest =
          await persistence
            .loadLatestEvidence(
              client,
              {
                sessionId,
                actorUserId:
                  command.actor.id,
              }
            );

        if (
          latest &&
          latest.evidence_fingerprint ===
            evidence.evidenceFingerprint
        ) {
          await persistence
            .completeCommand(
              client,
              {
                commandId:
                  reservation.record.id,
                resultReference: {
                  sessionId,
                  evidenceVersion:
                    Number(
                      latest.version
                    ),
                  evidenceFingerprint:
                    latest
                      .evidence_fingerprint,
                  changed: false,
                },
              }
            );

          return response(
            true,
            200,
            "QUICK_QUOTE_ANALYSIS_EVIDENCE_CURRENT",
            "The current Job Analysis evidence is already up to date.",
            {
              evidence:
                evidenceProjection(
                  latest
                ),
              changed: false,
              replayed: false,
              canonicalMutationPerformed:
                false,
            }
          );
        }

        const version =
          await persistence
            .nextEvidenceVersion(
              client,
              {
                sessionId,
                actorUserId:
                  command.actor.id,
              }
            );

        const row =
          await persistence
            .appendEvidenceRecord(
              client,
              {
                sessionId,
                version,
                actorUserId:
                  command.actor.id,
                professionalInput:
                  evidence.professionalInput,
                photoReferences:
                  evidence.photoReferences,
                evidenceFingerprint:
                  evidence.evidenceFingerprint,
                commandId:
                  reservation.record.id,
              }
            );

        await persistence
          .completeCommand(
            client,
            {
              commandId:
                reservation.record.id,
              resultReference: {
                sessionId,
                evidenceVersion:
                  Number(row.version),
                evidenceFingerprint:
                  row
                    .evidence_fingerprint,
                changed: true,
              },
            }
          );

        return response(
          true,
          201,
          "QUICK_QUOTE_ANALYSIS_EVIDENCE_APPENDED",
          "Updated Job Analysis evidence was recorded.",
          {
            evidence:
              evidenceProjection(row),
            changed: true,
            replayed: false,
            canonicalMutationPerformed:
              false,
          }
        );
      }
    );
  }

  async function appendTurn(
    input = {}
  ) {
    const command =
      commandValidation(input);

    if (command.error) {
      return command.error;
    }

    const sessionId =
      normalizeUuid(input.sessionId);

    const evidenceVersion =
      Number(input.evidenceVersion);

    const role =
      typeof input.role === "string"
        ? input.role
            .trim()
            .toUpperCase()
        : "";

    if (
      !sessionId ||
      !Number.isInteger(
        evidenceVersion
      ) ||
      evidenceVersion < 1 ||
      !TURN_ROLES.has(role)
    ) {
      return response(
        false,
        400,
        "QUICK_QUOTE_ANALYSIS_TURN_INVALID",
        "A valid private Job Analysis turn is required."
      );
    }

    let turnPayload;

    try {
      turnPayload =
        cloneBoundedJson(
          input.turnPayload,
          {
            maxBytes: 65536,
            maxStringLength: 12000,
            maxKeys: 300,
            maxArrayLength: 80,
          }
        );
    } catch {
      return response(
        false,
        400,
        "QUICK_QUOTE_ANALYSIS_TURN_INVALID",
        "A valid private Job Analysis turn is required."
      );
    }

    if (!isPlainObject(turnPayload)) {
      return response(
        false,
        400,
        "QUICK_QUOTE_ANALYSIS_TURN_INVALID",
        "A valid private Job Analysis turn is required."
      );
    }

    return persistence.withTransaction(
      input.pool,
      async (client) => {
        const session =
          await persistence
            .loadOwnedSession(
              client,
              {
                sessionId,
                actorUserId:
                  command.actor.id,
                lock: true,
              }
            );

        if (!session) {
          return response(
            false,
            404,
            "QUICK_QUOTE_ANALYSIS_SESSION_UNAVAILABLE",
            "The Job Analysis session is unavailable."
          );
        }

        // Completed idempotent commands are authoritative even if
        // the session has since advanced to newer evidence. A retry of a
        // successfully recorded turn must replay that exact durable turn
        // rather than being reclassified as stale.
        const authorityScope =
          `user:${command.actor.id}`;

        const scope =
          commandScope(
            COMMANDS.TURN,
            sessionId
          );

        const requestFingerprint =
          fingerprint({
            command: COMMANDS.TURN,
            sessionId,
            evidenceVersion,
            role,
            turnPayload,
          });

        const existingCommand =
          await persistence
            .findCommand(
              client,
              {
                actorUserId:
                  command.actor.id,
                authorityScope,
                commandName:
                  COMMANDS.TURN,
                commandScope: scope,
                idempotencyKey:
                  command.idempotencyKey,
                lock: true,
              }
            );

        if (existingCommand) {
          if (
            commandConflict(
              existingCommand,
              requestFingerprint
            )
          ) {
            return response(
              false,
              409,
              "QUICK_QUOTE_ANALYSIS_COMMAND_CONFLICT",
              "The idempotency key was already used for different input."
            );
          }

          if (
            commandIncomplete(
              existingCommand
            )
          ) {
            return response(
              false,
              409,
              "QUICK_QUOTE_ANALYSIS_COMMAND_IN_PROGRESS",
              "The Job Analysis command is still in progress."
            );
          }

          const turnId =
            existingCommand
              .result_reference
              ?.turnId;

          const turn =
            turnId
              ? await persistence
                  .loadTurn(
                    client,
                    {
                      turnId,
                      sessionId,
                      actorUserId:
                        command.actor.id,
                    }
                  )
              : null;

          if (!turn) {
            return response(
              false,
              404,
              "QUICK_QUOTE_ANALYSIS_TURN_UNAVAILABLE",
              "The Job Analysis turn is unavailable."
            );
          }

          return response(
            true,
            200,
            "QUICK_QUOTE_ANALYSIS_TURN_REPLAYED",
            "The private Job Analysis turn was restored.",
            {
              turn:
                turnProjection(turn),
              replayed: true,
              canonicalMutationPerformed:
                false,
            }
          );
        }

        const latestEvidence =
          await persistence
            .loadLatestEvidence(
              client,
              {
                sessionId,
                actorUserId:
                  command.actor.id,
              }
            );

        if (
          !latestEvidence ||
          Number(
            latestEvidence.version
          ) !== evidenceVersion
        ) {
          return response(
            false,
            409,
            "QUICK_QUOTE_ANALYSIS_EVIDENCE_STALE",
            "Job Analysis evidence changed before this turn was recorded."
          );
        }

        const reservation =
          await persistence.reserveCommand(
            client,
            {
              commandId: randomId(),
              actorUserId:
                command.actor.id,
              authorityScope,
              commandName:
                COMMANDS.TURN,
              commandScope: scope,
              idempotencyKey:
                command.idempotencyKey,
              requestFingerprint,
            }
          );

        // The owned session row is already locked. All service-mediated
        // turn appends for this session serialize behind that lock, so an
        // absent command becoming present here would indicate an unexpected
        // persistence race rather than a normal idempotent replay.
        if (!reservation.created) {
          throw new Error(
            "Quick Quote analysis turn reservation raced unexpectedly."
          );
        }

        const turnIndex =
          await persistence
            .nextTurnIndex(
              client,
              {
                sessionId,
                actorUserId:
                  command.actor.id,
              }
            );

        const row =
          await persistence
            .appendTurnRecord(
              client,
              {
                turnId: randomId(),
                sessionId,
                turnIndex,
                actorUserId:
                  command.actor.id,
                evidenceVersion,
                role,
                turnPayload,
                commandId:
                  reservation.record.id,
              }
            );

        await persistence
          .completeCommand(
            client,
            {
              commandId:
                reservation.record.id,
              resultReference: {
                sessionId,
                turnId: row.id,
                turnIndex:
                  Number(
                    row.turn_index
                  ),
                evidenceVersion,
              },
            }
          );

        return response(
          true,
          201,
          "QUICK_QUOTE_ANALYSIS_TURN_RECORDED",
          "A private Job Analysis turn was recorded.",
          {
            turn:
              turnProjection(row),
            replayed: false,
            canonicalMutationPerformed:
              false,
          }
        );
      }
    );
  }

  async function discardSession(
    input = {}
  ) {
    const command =
      commandValidation(input);

    if (command.error) {
      return command.error;
    }

    const sessionId =
      normalizeUuid(input.sessionId);

    if (!sessionId) {
      return response(
        false,
        400,
        "QUICK_QUOTE_ANALYSIS_SESSION_INVALID",
        "A valid Job Analysis session is required."
      );
    }

    return persistence.withTransaction(
      input.pool,
      async (client) => {
        const authorityScope =
          `user:${command.actor.id}`;

        const scope =
          commandScope(
            COMMANDS.DISCARD,
            sessionId
          );

        const requestFingerprint =
          fingerprint({
            command:
              COMMANDS.DISCARD,
            sessionId,
          });

        const existingCommand =
          await persistence
            .findCommand(
              client,
              {
                actorUserId:
                  command.actor.id,
                authorityScope,
                commandName:
                  COMMANDS.DISCARD,
                commandScope: scope,
                idempotencyKey:
                  command.idempotencyKey,
                lock: true,
              }
            );

        if (existingCommand) {
          if (
            commandConflict(
              existingCommand,
              requestFingerprint
            )
          ) {
            return response(
              false,
              409,
              "QUICK_QUOTE_ANALYSIS_COMMAND_CONFLICT",
              "The idempotency key was already used for different input."
            );
          }

          if (
            commandIncomplete(
              existingCommand
            )
          ) {
            return response(
              false,
              409,
              "QUICK_QUOTE_ANALYSIS_COMMAND_IN_PROGRESS",
              "The Job Analysis command is still in progress."
            );
          }

          return response(
            true,
            200,
            "QUICK_QUOTE_ANALYSIS_SESSION_DISCARD_REPLAYED",
            "The private Job Analysis session was already discarded.",
            {
              sessionId,
              discarded: true,
              replayed: true,
              canonicalMutationPerformed:
                false,
            }
          );
        }

        const session =
          await persistence
            .loadOwnedSession(
              client,
              {
                sessionId,
                actorUserId:
                  command.actor.id,
                lock: true,
              }
            );

        if (!session) {
          return response(
            false,
            404,
            "QUICK_QUOTE_ANALYSIS_SESSION_UNAVAILABLE",
            "The Job Analysis session is unavailable."
          );
        }

        const reservation =
          await persistence.reserveCommand(
            client,
            {
              commandId: randomId(),
              actorUserId:
                command.actor.id,
              authorityScope,
              commandName:
                COMMANDS.DISCARD,
              commandScope: scope,
              idempotencyKey:
                command.idempotencyKey,
              requestFingerprint,
            }
          );

        if (!reservation.created) {
          throw new Error(
            "Quick Quote analysis discard reservation raced unexpectedly."
          );
        }

        const deleted =
          await persistence
            .deleteOwnedSession(
              client,
              {
                sessionId,
                actorUserId:
                  command.actor.id,
              }
            );

        if (!deleted) {
          throw new Error(
            "Quick Quote analysis discard lost session ownership."
          );
        }

        await persistence
          .completeCommand(
            client,
            {
              commandId:
                reservation.record.id,
              resultReference: {
                sessionId,
                discarded: true,
              },
            }
          );

        return response(
          true,
          200,
          "QUICK_QUOTE_ANALYSIS_SESSION_DISCARDED",
          "The private Job Analysis session was discarded.",
          {
            sessionId,
            discarded: true,
            replayed: false,
            canonicalMutationPerformed:
              false,
          }
        );
      }
    );
  }

  return Object.freeze({
    appendEvidence,
    appendTurn,
    createSession,
    discardSession,
    getSession,
  });
}

const canonicalQuickQuoteAnalysisSessionService =
  createQuickQuoteAnalysisSessionService();

module.exports = {
  AUTHORITY_CLASSIFICATION,
  COMMANDS,
  TURN_ROLES,
  canonicalJson,
  canonicalQuickQuoteAnalysisSessionService,
  createQuickQuoteAnalysisSessionService,
  evidenceFingerprint,
  fingerprint,
};
