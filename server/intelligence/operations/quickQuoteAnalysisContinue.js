"use strict";

const {
  createHash,
} = require("node:crypto");

const sessionRepository =
  require("../quickQuoteAnalysisSessionRepository");

const {
  cloneBoundedJson,
  isPlainObject,
} = require("../intelligenceGatewayContracts");

const OPERATION =
  "quick_quote.analysis.continue";

const CAPABILITY =
  "quick_quote.analysis.continue";

const AUTHORITY_CLASSIFICATION =
  "ADVISORY_NON_CANONICAL";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ELEMENT_ID =
  /^[a-z][a-z0-9_.:-]{0,159}$/;

const CLASSIFICATIONS = new Set([
  "OBSERVED",
  "NEEDS_VERIFICATION",
  "AI_SUGGESTED",
]);

const ALLOWED_PRIOR_OPERATIONS = new Set([
  "quick_quote.photo_assist",
  OPERATION,
]);

function operationError(code, message) {
  return Object.assign(
    new Error(message),
    { code }
  );
}

function contextError(message) {
  return operationError(
    "intelligence_context_invalid",
    message
  );
}

function resultError(message) {
  return operationError(
    "malformed_operation_result",
    message
  );
}

function exactObject(
  value,
  required,
  optional = [],
  errorFactory = resultError
) {
  if (!isPlainObject(value)) {
    throw errorFactory(
      "Expected a plain object."
    );
  }

  const allowed =
    new Set([
      ...required,
      ...optional,
    ]);

  if (
    required.some(
      (key) =>
        !Object.hasOwn(value, key)
    ) ||
    Object.keys(value).some(
      (key) =>
        !allowed.has(key)
    )
  ) {
    throw errorFactory(
      "Object fields do not match the continuation contract."
    );
  }

  return value;
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

function text(
  value,
  maximum,
  {
    required = true,
    errorFactory = resultError,
  } = {}
) {
  if (
    value == null &&
    !required
  ) {
    return null;
  }

  if (
    typeof value !== "string"
  ) {
    throw errorFactory(
      "Text does not match the continuation bounds."
    );
  }

  const normalized =
    value.trim();

  if (
    normalized.length > maximum ||
    (
      required &&
      normalized.length === 0
    )
  ) {
    throw errorFactory(
      "Text does not match the continuation bounds."
    );
  }

  return normalized;
}

function normalizeOptionalMessage(value) {
  if (
    value == null ||
    value === ""
  ) {
    return null;
  }

  return text(
    value,
    4000,
    {
      errorFactory:
        contextError,
    }
  );
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

function elementId(value) {
  const normalized =
    typeof value === "string"
      ? value.trim().toLowerCase()
      : "";

  if (!ELEMENT_ID.test(normalized)) {
    throw resultError(
      "Proposal element identity is invalid."
    );
  }

  return normalized;
}

function normalizePhotoReference(
  value
) {
  if (!isPlainObject(value)) {
    throw contextError(
      "Stored Job Analysis photo evidence is invalid."
    );
  }

  const publicId =
    typeof value.publicId === "string"
      ? value.publicId.trim()
      : "";

  const secureUrl =
    typeof value.secureUrl === "string"
      ? value.secureUrl.trim()
      : "";

  const format =
    typeof value.format === "string"
      ? value.format.trim().toLowerCase()
      : "";

  const version =
    Number(value.version);

  const width =
    Number(value.width);

  const height =
    Number(value.height);

  const displayOrder =
    Number(value.displayOrder);

  if (
    value.type !==
      "QUOTE_DRAFT_PHOTO" ||
    !publicId ||
    !secureUrl ||
    !Number.isInteger(version) ||
    version < 1 ||
    !Number.isInteger(width) ||
    width < 1 ||
    !Number.isInteger(height) ||
    height < 1 ||
    !Number.isInteger(displayOrder) ||
    displayOrder < 0 ||
    ![
      "jpg",
      "jpeg",
      "png",
      "webp",
    ].includes(format)
  ) {
    throw contextError(
      "Stored Job Analysis photo evidence is invalid."
    );
  }

  return {
    id: publicId,
    secureUrl,
    mediaType: "IMAGE",
    format,
    width,
    height,
    version,
    displayOrder,
    sourceReferences: [
      {
        type:
          "QUOTE_DRAFT_PHOTO",
        id: publicId,
        version,
      },
    ],
  };
}

function findProposalElement(
  proposal,
  targetId
) {
  if (
    !proposal ||
    typeof proposal !== "object"
  ) {
    return null;
  }

  const normalizedTarget =
    String(targetId || "")
      .trim()
      .toLowerCase();

  if (!normalizedTarget) {
    return null;
  }

  const pending = [proposal];
  const visited = new Set();

  while (pending.length) {
    const value =
      pending.shift();

    if (
      !value ||
      typeof value !== "object" ||
      visited.has(value)
    ) {
      continue;
    }

    visited.add(value);

    if (
      !Array.isArray(value) &&
      String(value.id || "")
        .trim()
        .toLowerCase() ===
        normalizedTarget
    ) {
      return value;
    }

    const children =
      Array.isArray(value)
        ? value
        : Object.values(value);

    for (const child of children) {
      if (
        child &&
        typeof child === "object"
      ) {
        pending.push(child);
      }
    }
  }

  return null;
}

function assembleReviewedContext({
  proposal,
  reviewRows = [],
} = {}) {
  const latest =
    new Map();

  for (
    const row of
      Array.isArray(reviewRows)
        ? reviewRows
        : []
  ) {
    const id =
      typeof row
        ?.proposal_element_id ===
        "string"
        ? row
            .proposal_element_id
            .trim()
            .toLowerCase()
        : "";

    const action =
      typeof row?.action === "string"
        ? row.action
            .trim()
            .toUpperCase()
        : "";

    if (
      !ELEMENT_ID.test(id) ||
      ![
        "ACCEPTED",
        "EDITED",
        "REJECTED",
      ].includes(action)
    ) {
      continue;
    }

    latest.set(
      id,
      {
        elementId: id,
        action,
        editedValue:
          row.edited_value ??
          null,
      }
    );
  }

  const trustedElements = [];
  const rejectedElementIds = [];

  for (
    const decision of
      latest.values()
  ) {
    if (
      decision.action ===
      "REJECTED"
    ) {
      rejectedElementIds.push(
        decision.elementId
      );
      continue;
    }

    let value;

    if (
      decision.action ===
      "EDITED"
    ) {
      value =
        decision.editedValue;
    } else {
      value =
        findProposalElement(
          proposal,
          decision.elementId
        );
    }

    if (value == null) {
      continue;
    }

    trustedElements.push({
      elementId:
        decision.elementId,
      reviewAction:
        decision.action,
      value:
        cloneBoundedJson(
          value,
          {
            maxBytes: 16384,
            maxStringLength: 8000,
            maxKeys: 200,
            maxArrayLength: 50,
          }
        ),
    });
  }

  return {
    trustedElements,
    rejectedElementIds:
      [...rejectedElementIds]
        .sort(),
    reviewDecisionCount:
      latest.size,
  };
}

function normalizeConversationHistory(
  rows,
  evidenceVersion = null,
  maximumTurnIndex = null
) {
  const history = [];

  for (
    const row of
      Array.isArray(rows)
        ? rows
        : []
  ) {
    if (
      evidenceVersion != null &&
      Number(
        row?.evidence_version
      ) !==
        Number(
          evidenceVersion
        )
    ) {
      continue;
    }

    if (
      maximumTurnIndex != null &&
      Number(
        row?.turn_index
      ) >
        Number(
          maximumTurnIndex
        )
    ) {
      continue;
    }

    const role =
      String(row?.role || "")
        .trim()
        .toUpperCase();

    const payload =
      isPlainObject(
        row?.turn_payload
      )
        ? row.turn_payload
        : {};

    let message = null;

    if (
      role ===
      "PROFESSIONAL"
    ) {
      if (
        typeof payload.message ===
        "string"
      ) {
        const normalized =
          payload.message.trim();

        if (
          normalized &&
          normalized.length <= 4000
        ) {
          message =
            normalized;
        }
      }
    } else if (
      role === "MEETRO"
    ) {
      if (
        typeof payload
          .assistantMessage ===
        "string"
      ) {
        const normalized =
          payload
            .assistantMessage
            .trim();

        if (
          normalized &&
          normalized.length <= 4000
        ) {
          message =
            normalized;
        }
      }
    }

    if (!message) {
      continue;
    }

    history.push({
      role,
      message,
      turnIndex:
        Number(row.turn_index),
    });
  }

  return history
    .filter(
      (item) =>
        Number.isInteger(
          item.turnIndex
        ) &&
        item.turnIndex > 0
    )
    .sort(
      (a, b) =>
        a.turnIndex -
        b.turnIndex
    )
    .slice(-30);
}

async function loadCompletedProposal(
  client,
  {
    proposalId,
    actorUserId,
  }
) {
  const result =
    await client.query(
      `
      SELECT
        id,
        operation,
        actor_user_id,
        status,
        result_payload
      FROM intelligence_operation_idempotency
      WHERE id = $1
        AND actor_user_id = $2
        AND status = 'completed'
      LIMIT 1
      `,
      [
        proposalId,
        actorUserId,
      ]
    );

  return result.rows[0] || null;
}

async function loadWorkflowReviews(
  client,
  {
    proposalId,
    actorUserId,
  }
) {
  const result =
    await client.query(
      `
      SELECT
        id,
        proposal_element_id,
        action,
        edited_value,
        created_at
      FROM intelligence_workflow_review_events
      WHERE operation_id = $1
        AND actor_user_id = $2
      ORDER BY
        created_at ASC,
        id ASC
      `,
      [
        proposalId,
        actorUserId,
      ]
    );

  return result.rows;
}

function createQuickQuoteAnalysisContinueContextBuilder({
  persistence =
    sessionRepository,
  proposalLoader =
    loadCompletedProposal,
  reviewLoader =
    loadWorkflowReviews,
} = {}) {
  return async function buildContext({
    context,
    input,
    runtimeContext,
  }) {
    exactObject(
      context,
      [],
      [],
      contextError
    );

    exactObject(
      input,
      [
        "analysisSessionId",
        "evidenceVersion",
        "priorProposalId",
        "message",
      ],
      [],
      contextError
    );

    const actorUserId =
      Number(
        runtimeContext
          ?.authenticatedActor
          ?.id
      );

    const analysisSessionId =
      normalizeUuid(
        input.analysisSessionId
      );

    const evidenceVersion =
      Number(
        input.evidenceVersion
      );

    const priorProposalId =
      input.priorProposalId ==
      null
        ? null
        : normalizeUuid(
            input.priorProposalId
          );

    const message =
      normalizeOptionalMessage(
        input.message
      );

    if (
      !Number.isInteger(
        actorUserId
      ) ||
      actorUserId < 1
    ) {
      throw operationError(
        "intelligence_quick_quote_analysis_authority_required",
        "Professional Job Analysis authority is required."
      );
    }

    if (
      !analysisSessionId ||
      !Number.isInteger(
        evidenceVersion
      ) ||
      evidenceVersion < 1 ||
      (
        input.priorProposalId !=
          null &&
        !priorProposalId
      )
    ) {
      throw contextError(
        "A valid private Job Analysis continuation context is required."
      );
    }

    return persistence
      .withReadTransaction(
        runtimeContext?.pool,
        async (client) => {
          const session =
            await persistence
              .loadOwnedSession(
                client,
                {
                  sessionId:
                    analysisSessionId,
                  actorUserId,
                  lock: false,
                }
              );

          if (!session) {
            throw operationError(
              "intelligence_quick_quote_analysis_session_unavailable",
              "The private Job Analysis session is unavailable."
            );
          }

          const evidence =
            await persistence
              .loadLatestEvidence(
                client,
                {
                  sessionId:
                    analysisSessionId,
                  actorUserId,
                }
              );

          if (
            !evidence ||
            Number(
              evidence.version
            ) !==
              evidenceVersion
          ) {
            throw operationError(
              "intelligence_quick_quote_analysis_evidence_stale",
              "Job Analysis evidence changed before continuation."
            );
          }

          const turnRows =
            await persistence
              .listTurns(
                client,
                {
                  sessionId:
                    analysisSessionId,
                  actorUserId,
                }
              );

          let conversationHistory =
            [];

          let priorProposal =
            null;

          let reviewedContext = {
            trustedElements: [],
            rejectedElementIds: [],
            reviewDecisionCount: 0,
          };

          if (priorProposalId) {
            const linkedTurn =
              turnRows.find(
                (row) =>
                  String(
                    row?.role ||
                      ""
                  ).toUpperCase() ===
                    "MEETRO" &&
                  isPlainObject(
                    row?.turn_payload
                  ) &&
                  String(
                    row
                      .turn_payload
                      .proposalId ||
                      ""
                  )
                    .trim()
                    .toLowerCase() ===
                    priorProposalId
              );

            if (!linkedTurn) {
              throw operationError(
                "intelligence_quick_quote_analysis_prior_proposal_unavailable",
                "The prior Job Analysis proposal is not linked to this session."
              );
            }

            if (
              Number(
                linkedTurn.evidence_version
              ) !== evidenceVersion
            ) {
              throw operationError(
                "intelligence_quick_quote_analysis_evidence_stale",
                "The prior Job Analysis proposal belongs to an older evidence version."
              );
            }

            conversationHistory =
              normalizeConversationHistory(
                turnRows,
                evidenceVersion,
                Number(
                  linkedTurn.turn_index
                )
              );

            const proposalRow =
              await proposalLoader(
                client,
                {
                  proposalId:
                    priorProposalId,
                  actorUserId,
                }
              );

            if (
              !proposalRow ||
              !ALLOWED_PRIOR_OPERATIONS.has(
                proposalRow
                  .operation
              ) ||
              !isPlainObject(
                proposalRow
                  .result_payload
              )
            ) {
              throw operationError(
                "intelligence_quick_quote_analysis_prior_proposal_unavailable",
                "The prior Job Analysis proposal is unavailable."
              );
            }

            priorProposal =
              cloneBoundedJson(
                proposalRow
                  .result_payload,
                {
                  maxBytes: 65536,
                  maxStringLength:
                    12000,
                  maxKeys: 1800,
                  maxArrayLength:
                    250,
                }
              );

            const reviews =
              await reviewLoader(
                client,
                {
                  proposalId:
                    priorProposalId,
                  actorUserId,
                }
              );

            reviewedContext =
              assembleReviewedContext({
                proposal:
                  priorProposal,
                reviewRows:
                  reviews,
              });
          }

          const photos =
            (
              Array.isArray(
                evidence
                  .photo_references
              )
                ? evidence
                    .photo_references
                : []
            ).map(
              normalizePhotoReference
            );

          const safePhotos =
            photos.map(
              ({
                secureUrl,
                ...photo
              }) => photo
            );

          const safeContext = {
            authorityClassification:
              "PRIVATE_NON_CANONICAL",
            analysisSessionId,
            evidenceVersion,
            evidenceFingerprint:
              evidence
                .evidence_fingerprint,
            professionalInput:
              evidence
                .professional_input,
            photos:
              safePhotos,
            currentProfessionalMessage:
              message,
            priorProposalId,
            reviewedContext,
            conversationHistory,
          };

          return {
            ...safeContext,

            photos,

            priorProposal,

            sourceContextFingerprint:
              fingerprint(
                safeContext
              ),
          };
        }
      );
  };
}

const buildQuickQuoteAnalysisContinueContext =
  createQuickQuoteAnalysisContinueContextBuilder();

function normalizeSourceReferences(
  values,
  context
) {
  if (
    !Array.isArray(values) ||
    values.length > 12
  ) {
    throw resultError(
      "Source references are invalid."
    );
  }

  const allowed =
    new Set(
      context.photos
        .flatMap(
          (photo) =>
            photo
              .sourceReferences
        )
        .map(
          (item) =>
            `${item.type}:${item.id}:${item.version}`
        )
    );

  return values.map(
    (value) => {
      exactObject(
        value,
        [
          "type",
          "id",
          "version",
        ]
      );

      const normalized = {
        type:
          text(
            value.type,
            40
          ),
        id:
          text(
            value.id,
            500
          ),
        version:
          Number(
            value.version
          ),
      };

      if (
        !Number.isInteger(
          normalized.version
        ) ||
        normalized.version < 1 ||
        !allowed.has(
          `${normalized.type}:${normalized.id}:${normalized.version}`
        )
      ) {
        throw resultError(
          "A source reference is outside the authorized Job Analysis evidence."
        );
      }

      return normalized;
    }
  );
}

function normalizeAssistanceItem(
  value,
  context,
  expectedClassification
) {
  exactObject(
    value,
    [
      "id",
      "text",
      "classification",
      "sourceReferences",
    ]
  );

  const classification =
    String(
      value.classification ||
        ""
    )
      .trim()
      .toUpperCase();

  if (
    !CLASSIFICATIONS.has(
      classification
    ) ||
    classification !==
      expectedClassification
  ) {
    throw resultError(
      "Job Analysis assistance classification is invalid."
    );
  }

  const sourceReferences =
    normalizeSourceReferences(
      value.sourceReferences,
      context
    );

  if (
    classification ===
      "OBSERVED" &&
    sourceReferences.length ===
      0
  ) {
    throw resultError(
      "Observed Job Analysis content requires exact photo evidence."
    );
  }

  return {
    id:
      elementId(
        value.id
      ),
    text:
      text(
        value.text,
        3000
      ),
    classification,
    sourceReferences,
  };
}

function normalizeQuestion(
  value
) {
  exactObject(
    value,
    [
      "id",
      "text",
    ]
  );

  return {
    id:
      elementId(
        value.id
      ),
    text:
      text(
        value.text,
        1200
      ),
  };
}

function parseQuickQuoteAnalysisContinueResult(
  providerResult,
  {
    semanticInput,
    operationId,
  }
) {
  const payload =
    typeof providerResult ===
      "string"
      ? (() => {
          try {
            return JSON.parse(
              providerResult
            );
          } catch {
            throw resultError(
              "Provider output is not valid JSON."
            );
          }
        })()
      : providerResult;

  exactObject(
    payload,
    [
      "schemaVersion",
      "assistantMessage",
      "summary",
      "questionsForProfessional",
      "observed",
      "needsVerification",
      "repairSuggestions",
      "materialSuggestions",
      "photoAnalysis",
      "warnings",
    ]
  );

  if (
    payload.schemaVersion !== 1
  ) {
    throw resultError(
      "Unsupported Job Analysis continuation version."
    );
  }

  for (
    const key of [
      "questionsForProfessional",
      "observed",
      "needsVerification",
      "repairSuggestions",
      "materialSuggestions",
      "warnings",
    ]
  ) {
    if (
      !Array.isArray(
        payload[key]
      ) ||
      payload[key].length > 40
    ) {
      throw resultError(
        "Job Analysis continuation exceeds collection bounds."
      );
    }
  }

  exactObject(
    payload.photoAnalysis,
    [
      "analyzedReferenceIds",
      "limitations",
    ]
  );

  if (
    !Array.isArray(
      payload
        .photoAnalysis
        .analyzedReferenceIds
    ) ||
    !Array.isArray(
      payload
        .photoAnalysis
        .limitations
    ) ||
    payload
      .photoAnalysis
      .analyzedReferenceIds
      .length > 5 ||
    payload
      .photoAnalysis
      .limitations
      .length > 20
  ) {
    throw resultError(
      "Job Analysis photo metadata is invalid."
    );
  }

  const context =
    semanticInput.context;

  const photoIds =
    new Set(
      context.photos.map(
        (photo) =>
          photo.id
      )
    );

  const analyzedReferenceIds =
    payload
      .photoAnalysis
      .analyzedReferenceIds
      .map(
        (value) => {
          const id =
            text(
              value,
              500
            );

          if (
            !photoIds.has(id)
          ) {
            throw resultError(
              "Job Analysis referenced unauthorized photo evidence."
            );
          }

          return id;
        }
      );

  if (
    new Set(
      analyzedReferenceIds
    ).size !==
      analyzedReferenceIds.length
  ) {
    throw resultError(
      "Job Analysis photo references must be unique."
    );
  }

  return {
    schemaVersion: 1,

    proposalId:
      operationId,

    analysisSessionId:
      context
        .analysisSessionId,

    evidenceVersion:
      context
        .evidenceVersion,

    priorProposalId:
      context
        .priorProposalId,

    authorityClassification:
      AUTHORITY_CLASSIFICATION,

    sourceContextFingerprint:
      context
        .sourceContextFingerprint,

    assistantMessage:
      text(
        payload.assistantMessage,
        4000
      ),

    summary:
      text(
        payload.summary,
        1200
      ),

    questionsForProfessional:
      payload
        .questionsForProfessional
        .map(
          normalizeQuestion
        ),

    observed:
      payload.observed.map(
        (item) =>
          normalizeAssistanceItem(
            item,
            context,
            "OBSERVED"
          )
      ),

    needsVerification:
      payload
        .needsVerification
        .map(
          (item) =>
            normalizeAssistanceItem(
              item,
              context,
              "NEEDS_VERIFICATION"
            )
        ),

    repairSuggestions:
      payload
        .repairSuggestions
        .map(
          (item) =>
            normalizeAssistanceItem(
              item,
              context,
              "AI_SUGGESTED"
            )
        ),

    materialSuggestions:
      payload
        .materialSuggestions
        .map(
          (item) =>
            normalizeAssistanceItem(
              item,
              context,
              "AI_SUGGESTED"
            )
        ),

    photoAnalysis: {
      supported:
        context.photos.length >
        0,

      analyzedReferenceIds,

      limitations:
        payload
          .photoAnalysis
          .limitations
          .map(
            (item) =>
              text(
                item,
                500
              )
          ),

      imageMeasurementsAreEstimates:
        true,
    },

    warnings:
      payload.warnings.map(
        (item) =>
          text(
            item,
            500
          )
      ),

    reviewContract: {
      actions: [
        "ACCEPTED",
        "EDITED",
        "REJECTED",
      ],

      reviewableElementCollections: [
        "questionsForProfessional",
        "observed",
        "needsVerification",
        "repairSuggestions",
        "materialSuggestions",
      ],

      explicitHumanDecisionRequired:
        true,
    },

    humanToCanonicalBoundary: {
      directMutationAllowed:
        false,

      workingDraftApplicationRequiresReview:
        true,

      prohibitedCanonicalCommands: [
        "quote.create",
        "quote.issue",
        "quote.send",
        "request.create",
        "job.create",
        "invoice.issue",
        "payment.record",
        "visit.schedule",
      ],
    },

    learningContext: {
      context:
        "quick_quote_analysis_continuation",

      learnedPatternIsCanonicalRule:
        false,
    },

    canonicalMutationPerformed:
      false,
  };
}

function buildQuickQuoteAnalysisContinueProviderRequest({
  semanticInput,
  engineContext,
}) {
  const context =
    semanticInput.context;

  const photos =
    context.photos.map(
      ({
        secureUrl,
        ...photo
      }) => photo
    );

  return {
    schemaVersion: 1,

    operation:
      OPERATION,

    capability:
      CAPABILITY,

    locale:
      semanticInput.locale,

    quickQuoteAnalysisContext: {
      authorityClassification:
        context
          .authorityClassification,

      analysisSessionId:
        context
          .analysisSessionId,

      evidenceVersion:
        context
          .evidenceVersion,

      evidenceFingerprint:
        context
          .evidenceFingerprint,

      professionalInput:
        context
          .professionalInput,

      currentProfessionalMessage:
        context
          .currentProfessionalMessage,

      priorProposalId:
        context
          .priorProposalId,

      reviewedContext:
        context
          .reviewedContext,

      conversationHistory:
        context
          .conversationHistory,

      photos,

      sourceContextFingerprint:
        context
          .sourceContextFingerprint,
    },

    authorizedImageInputs:
      context.photos.map(
        (photo) => ({
          mediaId:
            photo.id,
          imageUrl:
            photo.secureUrl,
        })
      ),

    operationContext:
      engineContext,

    instructions: {
      authority:
        "proposal_only",

      output:
        "strict_structured_json",

      requirements: [
        "respond_conversationally_to_the_professional",
        "use_only_current_session_evidence",
        "use_only_explicitly_reviewed_prior_proposal_elements_as_trusted_context",
        "never_treat_unreviewed_prior_proposal_elements_as_accepted_truth",
        "never_reintroduce_rejected_content_as_trusted_context",
        "separate_observed_conditions_from_needs_verification",
        "preserve_uncertainty_for_hidden_conditions",
        "preserve_exact_photo_source_references",
        "ask_bounded_professional_questions_when_information_is_missing",
      ],

      prohibitedActions: [
        "create_or_issue_quote",
        "create_job_or_request",
        "schedule_work",
        "issue_invoice",
        "record_payment",
        "publish_customer_visible_content",
        "assert_hidden_condition_as_fact",
        "set_price_or_markup",
      ],
    },
  };
}

const quickQuoteAnalysisContinueEngines =
  Object.freeze([
    Object.freeze({
      id:
        "quick_quote_analysis_continuation_boundary",

      async collectContext() {
        return {
          mutationAllowed:
            false,

          commercialMutationAllowed:
            false,

          lifecycleMutationAllowed:
            false,

          customerVisibleByDefault:
            false,

          reviewedContextRequiredForPriorProposalTrust:
            true,

          sessionAuthority:
            "PRIVATE_NON_CANONICAL",
        };
      },
    }),
  ]);

const quickQuoteAnalysisContinueOperationDefinition =
  Object.freeze({
    operation:
      OPERATION,

    capability:
      CAPABILITY,

    supportedRoles:
      Object.freeze([
        "professional",
      ]),

    roleAuthorization:
      "context_builder",

    engineIds:
      Object.freeze([
        "quick_quote_analysis_continuation_boundary",
      ]),

    providerName:
      "workflow_assistance",

    buildContext:
      buildQuickQuoteAnalysisContinueContext,

    buildProviderRequest:
      buildQuickQuoteAnalysisContinueProviderRequest,

    parseResult:
      parseQuickQuoteAnalysisContinueResult,
  });

module.exports = {
  ALLOWED_PRIOR_OPERATIONS,
  AUTHORITY_CLASSIFICATION,
  CAPABILITY,
  OPERATION,
  assembleReviewedContext,
  buildQuickQuoteAnalysisContinueContext,
  buildQuickQuoteAnalysisContinueProviderRequest,
  createQuickQuoteAnalysisContinueContextBuilder,
  findProposalElement,
  normalizeConversationHistory,
  parseQuickQuoteAnalysisContinueResult,
  quickQuoteAnalysisContinueEngines,
  quickQuoteAnalysisContinueOperationDefinition,
};
