"use strict";

const {
  createHash,
  randomUUID,
} = require("node:crypto");

const {
  executeIntelligenceGateway,
} = require("./intelligenceGateway");

const {
  createIntelligenceOperationRegistry,
} = require("./intelligenceOperationRegistry");

const {
  createIntelligenceEngineRegistry,
} = require("./intelligenceEngineRegistry");

const {
  cloneBoundedJson,
  isPlainObject,
  normalizeIdempotencyKey,
  normalizeLocale,
} = require("./intelligenceGatewayContracts");

const persistenceDefault =
  require("./quickQuoteAnalysisSessionRepository");

const {
  COMMANDS,
  fingerprint,
} = require("./quickQuoteAnalysisSessionService");

const {
  AUTHORITY_CLASSIFICATION,
  CAPABILITY,
  OPERATION,
  quickQuoteAnalysisContinueEngines,
  quickQuoteAnalysisContinueOperationDefinition,
} = require(
  "./operations/quickQuoteAnalysisContinue"
);

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const internalOperationRegistry =
  createIntelligenceOperationRegistry([
    quickQuoteAnalysisContinueOperationDefinition,
  ]);

const internalEngineRegistry =
  createIntelligenceEngineRegistry([
    ...quickQuoteAnalysisContinueEngines,
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

function normalizeUuid(value) {
  const normalized =
    typeof value === "string"
      ? value.trim().toLowerCase()
      : "";

  return UUID_PATTERN.test(normalized)
    ? normalized
    : null;
}

function normalizeActor(actor) {
  const id =
    Number(actor?.id);

  return Number.isInteger(id) &&
    id > 0
    ? {
        actor,
        actorUserId: id,
      }
    : null;
}

function normalizeMessage(
  value,
  required
) {
  if (
    value == null ||
    value === ""
  ) {
    return required
      ? null
      : "";
  }

  if (
    typeof value !== "string"
  ) {
    return null;
  }

  const normalized =
    value.trim();

  if (
    normalized.length > 4000 ||
    (
      required &&
      normalized.length === 0
    )
  ) {
    return null;
  }

  return normalized;
}

function deriveTurnIdempotencyKey(
  baseKey,
  label
) {
  const hex =
    createHash("sha256")
      .update(
        `quick-quote-analysis:${baseKey}:${label}`
      )
      .digest("hex")
      .slice(0, 32)
      .split("");

  hex[12] = "5";

  const variant =
    (
      parseInt(
        hex[16],
        16
      ) & 0x3
    ) | 0x8;

  hex[16] =
    variant.toString(16);

  const compact =
    hex.join("");

  return [
    compact.slice(0, 8),
    compact.slice(8, 12),
    compact.slice(12, 16),
    compact.slice(16, 20),
    compact.slice(20, 32),
  ].join("-");
}

function turnProjection(row) {
  return {
    turnId:
      row.id,

    turnIndex:
      Number(
        row.turn_index
      ),

    evidenceVersion:
      Number(
        row.evidence_version
      ),

    role:
      row.role,

    authorityClassification:
      row.authority_classification,

    payload:
      row.turn_payload || {},

    createdAt:
      new Date(
        row.created_at
      ).toISOString(),
  };
}

function validateExecutionInput(
  input,
  {
    continuation,
  }
) {
  const actor =
    normalizeActor(
      input?.authenticatedActor
    );

  if (!actor) {
    return {
      error:
        response(
          false,
          401,
          "QUICK_QUOTE_ANALYSIS_AUTHENTICATION_REQUIRED",
          "Authentication required."
        ),
    };
  }

  if (
    !input?.pool ||
    typeof input.pool.connect !==
      "function"
  ) {
    throw new TypeError(
      "A database pool is required."
    );
  }

  const sessionId =
    normalizeUuid(
      input.sessionId
    );

  const idempotencyKey =
    normalizeIdempotencyKey(
      input.idempotencyKey
    );

  const locale =
    normalizeLocale(
      input.locale
    );

  const message =
    normalizeMessage(
      input.message,
      continuation
    );

  const priorProposalId =
    continuation
      ? normalizeUuid(
          input.priorProposalId
        )
      : null;

  if (
    !sessionId ||
    !idempotencyKey ||
    !locale ||
    message == null ||
    (
      continuation &&
      !priorProposalId
    )
  ) {
    return {
      error:
        response(
          false,
          400,
          "QUICK_QUOTE_ANALYSIS_EXECUTION_INVALID",
          "A valid private Job Analysis execution request is required."
        ),
    };
  }

  return {
    ...actor,
    sessionId,
    idempotencyKey,
    locale,
    message,
    priorProposalId,
  };
}

async function loadCurrentEvidenceVersion(
  persistence,
  pool,
  {
    sessionId,
    actorUserId,
  }
) {
  return persistence
    .withReadTransaction(
      pool,
      async (client) => {
        const session =
          await persistence
            .loadOwnedSession(
              client,
              {
                sessionId,
                actorUserId,
              }
            );

        if (!session) {
          return response(
            false,
            404,
            "QUICK_QUOTE_ANALYSIS_SESSION_UNAVAILABLE",
            "The private Job Analysis session is unavailable."
          );
        }

        const evidence =
          await persistence
            .loadLatestEvidence(
              client,
              {
                sessionId,
                actorUserId,
              }
            );

        if (!evidence) {
          return response(
            false,
            404,
            "QUICK_QUOTE_ANALYSIS_EVIDENCE_UNAVAILABLE",
            "The Job Analysis evidence is unavailable."
          );
        }

        return {
          ok: true,
          evidenceVersion:
            Number(
              evidence.version
            ),
        };
      }
    );
}

function commandConflict(
  row,
  requestFingerprint
) {
  return (
    row.request_fingerprint !==
    requestFingerprint
  );
}

function commandIncomplete(row) {
  return (
    !row.result_reference ||
    !row.completed_at
  );
}

async function persistExchange({
  persistence,
  pool,
  actorUserId,
  sessionId,
  evidenceVersion,
  baseIdempotencyKey,
  professionalMessage,
  priorProposalId,
  proposal,
}) {
  const descriptors = [];

  if (professionalMessage) {
    descriptors.push({
      role:
        "PROFESSIONAL",

      idempotencyKey:
        deriveTurnIdempotencyKey(
          baseIdempotencyKey,
          "professional"
        ),

      turnPayload: {
        message:
          professionalMessage,

        priorProposalId:
          priorProposalId ||
          null,
      },
    });
  }

  descriptors.push({
    role:
      "MEETRO",

    idempotencyKey:
      deriveTurnIdempotencyKey(
        baseIdempotencyKey,
        "meetro"
      ),

    turnPayload:
      cloneBoundedJson(
        proposal,
        {
          maxBytes: 65536,
          maxStringLength:
            12000,
          maxKeys: 1800,
          maxArrayLength:
            250,
        }
      ),
  });

  return persistence
    .withTransaction(
      pool,
      async (client) => {
        const session =
          await persistence
            .loadOwnedSession(
              client,
              {
                sessionId,
                actorUserId,
                lock: true,
              }
            );

        if (!session) {
          return response(
            false,
            404,
            "QUICK_QUOTE_ANALYSIS_SESSION_UNAVAILABLE",
            "The private Job Analysis session is unavailable."
          );
        }

        const latestEvidence =
          await persistence
            .loadLatestEvidence(
              client,
              {
                sessionId,
                actorUserId,
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
            "Job Analysis evidence changed before the conversation exchange was recorded."
          );
        }

        const authorityScope =
          `user:${actorUserId}`;

        const commandScope =
          `analysis-session:${sessionId}:turn`;

        for (
          const descriptor of
            descriptors
        ) {
          descriptor.requestFingerprint =
            fingerprint({
              command:
                COMMANDS.TURN,
              sessionId,
              evidenceVersion,
              role:
                descriptor.role,
              turnPayload:
                descriptor.turnPayload,
            });

          const existing =
            await persistence
              .findCommand(
                client,
                {
                  actorUserId,
                  authorityScope,
                  commandName:
                    COMMANDS.TURN,
                  commandScope,
                  idempotencyKey:
                    descriptor
                      .idempotencyKey,
                  lock: true,
                }
              );

          if (!existing) {
            continue;
          }

          if (
            commandConflict(
              existing,
              descriptor
                .requestFingerprint
            )
          ) {
            return response(
              false,
              409,
              "QUICK_QUOTE_ANALYSIS_COMMAND_CONFLICT",
              "The derived conversation command was already used for different input."
            );
          }

          if (
            commandIncomplete(
              existing
            )
          ) {
            return response(
              false,
              409,
              "QUICK_QUOTE_ANALYSIS_COMMAND_IN_PROGRESS",
              "The Job Analysis conversation command is still in progress."
            );
          }

          const turnId =
            existing
              .result_reference
              ?.turnId;

          const existingTurn =
            turnId
              ? await persistence
                  .loadTurn(
                    client,
                    {
                      turnId,
                      sessionId,
                      actorUserId,
                    }
                  )
              : null;

          if (!existingTurn) {
            return response(
              false,
              404,
              "QUICK_QUOTE_ANALYSIS_TURN_UNAVAILABLE",
              "The Job Analysis conversation turn is unavailable."
            );
          }

          descriptor
            .existingTurn =
            existingTurn;
        }

        const rows = [];

        for (
          const descriptor of
            descriptors
        ) {
          if (
            descriptor
              .existingTurn
          ) {
            rows.push(
              descriptor
                .existingTurn
            );
            continue;
          }

          const reservation =
            await persistence
              .reserveCommand(
                client,
                {
                  commandId:
                    randomUUID(),
                  actorUserId,
                  authorityScope,
                  commandName:
                    COMMANDS.TURN,
                  commandScope,
                  idempotencyKey:
                    descriptor
                      .idempotencyKey,
                  requestFingerprint:
                    descriptor
                      .requestFingerprint,
                }
              );

          if (
            !reservation.created
          ) {
            throw new Error(
              "Quick Quote analysis exchange reservation raced unexpectedly."
            );
          }

          const turnIndex =
            await persistence
              .nextTurnIndex(
                client,
                {
                  sessionId,
                  actorUserId,
                }
              );

          const row =
            await persistence
              .appendTurnRecord(
                client,
                {
                  turnId:
                    randomUUID(),
                  sessionId,
                  turnIndex,
                  actorUserId,
                  evidenceVersion,
                  role:
                    descriptor.role,
                  turnPayload:
                    descriptor
                      .turnPayload,
                  commandId:
                    reservation
                      .record.id,
                }
              );

          await persistence
            .completeCommand(
              client,
              {
                commandId:
                  reservation
                    .record.id,

                resultReference: {
                  sessionId,
                  turnId:
                    row.id,
                  turnIndex:
                    Number(
                      row
                        .turn_index
                    ),
                  evidenceVersion,
                },
              }
            );

          rows.push(row);
        }

        return {
          ok: true,

          turns:
            rows.map(
              turnProjection
            ),

          replayed:
            descriptors.every(
              (descriptor) =>
                Boolean(
                  descriptor
                    .existingTurn
                )
            ),
        };
      }
    );
}

function validateProposal(
  proposal,
  {
    sessionId,
    evidenceVersion,
    priorProposalId,
  }
) {
  if (
    !isPlainObject(proposal)
  ) {
    return null;
  }

  const normalized =
    cloneBoundedJson(
      proposal,
      {
        maxBytes: 65536,
        maxStringLength:
          12000,
        maxKeys: 1800,
        maxArrayLength:
          250,
      }
    );

  if (
    !normalizeUuid(
      normalized.proposalId
    ) ||
    normalized
      .analysisSessionId !==
      sessionId ||
    Number(
      normalized
        .evidenceVersion
    ) !== evidenceVersion ||
    (
      normalized
        .priorProposalId ||
      null
    ) !==
      (
        priorProposalId ||
        null
      ) ||
    normalized
      .authorityClassification !==
      AUTHORITY_CLASSIFICATION ||
    normalized
      .canonicalMutationPerformed !==
      false
  ) {
    return null;
  }

  return normalized;
}

function createQuickQuoteAnalysisContinuationService({
  gateway =
    executeIntelligenceGateway,

  persistence =
    persistenceDefault,

  operationRegistry =
    internalOperationRegistry,

  engineRegistry =
    internalEngineRegistry,
} = {}) {
  async function execute(
    input,
    {
      continuation,
    }
  ) {
    const validated =
      validateExecutionInput(
        input,
        {
          continuation,
        }
      );

    if (validated.error) {
      return validated.error;
    }

    const snapshot =
      await loadCurrentEvidenceVersion(
        persistence,
        input.pool,
        validated
      );

    if (!snapshot.ok) {
      return snapshot;
    }

    const gatewayResult =
      await gateway({
        pool:
          input.pool,

        authenticatedActor:
          validated.actor,

        idempotencyKey:
          validated
            .idempotencyKey,

        body: {
          operation:
            OPERATION,

          capability:
            CAPABILITY,

          locale:
            validated.locale,

          context: {},

          input: {
            analysisSessionId:
              validated
                .sessionId,

            evidenceVersion:
              snapshot
                .evidenceVersion,

            priorProposalId:
              validated
                .priorProposalId,

            message:
              validated
                .message ||
              null,
          },
        },

        operationRegistry,
        engineRegistry,

        providers:
          input.providers || {},

        repository:
          input
            .intelligenceRepository,

        usageFinalizer:
          input
            .usageFinalizer,

        providerTimeoutMs:
          input
            .providerTimeoutMs,

        logger:
          input.logger,

        onDiagnostics:
          input
            .onDiagnostics,
      });

    if (!gatewayResult.ok) {
      return gatewayResult;
    }

    const proposal =
      validateProposal(
        gatewayResult.result,
        {
          sessionId:
            validated
              .sessionId,

          evidenceVersion:
            snapshot
              .evidenceVersion,

          priorProposalId:
            validated
              .priorProposalId,
        }
      );

    if (!proposal) {
      return response(
        false,
        502,
        "QUICK_QUOTE_ANALYSIS_RESULT_INVALID",
        "The governed Job Analysis provider result could not be linked to the private session."
      );
    }

    const exchange =
      await persistExchange({
        persistence,
        pool:
          input.pool,
        actorUserId:
          validated
            .actorUserId,
        sessionId:
          validated
            .sessionId,
        evidenceVersion:
          snapshot
            .evidenceVersion,
        baseIdempotencyKey:
          validated
            .idempotencyKey,
        professionalMessage:
          continuation
            ? validated.message
            : "",
        priorProposalId:
          validated
            .priorProposalId,
        proposal,
      });

    if (!exchange.ok) {
      return exchange;
    }

    const fullyReplayed =
      gatewayResult
        .replayed === true &&
      exchange
        .replayed === true;

    return response(
      true,
      fullyReplayed
        ? 200
        : 201,
      fullyReplayed
        ? "QUICK_QUOTE_ANALYSIS_EXECUTION_REPLAYED"
        : continuation
          ? "QUICK_QUOTE_ANALYSIS_CONTINUED"
          : "QUICK_QUOTE_ANALYSIS_COMPLETED",
      fullyReplayed
        ? "The private Job Analysis exchange was restored."
        : continuation
          ? "The private Job Analysis conversation continued."
          : "The private Job Analysis was completed.",
      {
        proposal,
        turns:
          exchange.turns,
        replayed:
          fullyReplayed,
        canonicalMutationPerformed:
          false,
      }
    );
  }

  return Object.freeze({
    analyzeSession(input = {}) {
      return execute(
        input,
        {
          continuation:
            false,
        }
      );
    },

    continueSession(input = {}) {
      return execute(
        input,
        {
          continuation:
            true,
        }
      );
    },
  });
}

const canonicalQuickQuoteAnalysisContinuationService =
  createQuickQuoteAnalysisContinuationService();

module.exports = {
  canonicalQuickQuoteAnalysisContinuationService,
  createQuickQuoteAnalysisContinuationService,
  deriveTurnIdempotencyKey,
  internalEngineRegistry,
  internalOperationRegistry,
  persistExchange,
};
