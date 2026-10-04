"use strict";

const repository =
  require(
    "./quickQuoteAnalysisSessionRepository"
  );

const {
  cloneBoundedJson,
  isPlainObject,
} = require(
  "./intelligenceGatewayContracts"
);

const SESSION_AUTHORITY_CLASSIFICATION =
  "PRIVATE_NON_CANONICAL";

const PROPOSAL_AUTHORITY_CLASSIFICATION =
  "ADVISORY_NON_CANONICAL";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ELEMENT_ID =
  /^[a-z][a-z0-9_.:-]{0,159}$/;

const REVIEW_ACTIONS =
  new Set([
    "ACCEPTED",
    "EDITED",
    "REJECTED",
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

function normalizeActor(actor) {
  const id =
    Number(actor?.id);

  return (
    Number.isInteger(id) &&
    id > 0
  )
    ? { id }
    : null;
}

function normalizeUuid(value) {
  const normalized =
    typeof value === "string"
      ? value.trim().toLowerCase()
      : "";

  return UUID_PATTERN.test(
    normalized
  )
    ? normalized
    : null;
}

function safeElementId(value) {
  const normalized =
    typeof value === "string"
      ? value.trim().toLowerCase()
      : "";

  return ELEMENT_ID.test(
    normalized
  )
    ? normalized
    : null;
}

function safeText(
  value,
  maximum
) {
  if (
    typeof value !== "string" ||
    value.length > maximum ||
    !value.trim()
  ) {
    return null;
  }

  return value;
}

function validQuestion(value) {
  return (
    isPlainObject(value) &&
    safeElementId(value.id) &&
    safeText(
      value.text,
      1200
    )
  );
}

function validAssistanceItem(
  value,
  classification
) {
  return (
    isPlainObject(value) &&
    safeElementId(value.id) &&
    safeText(
      value.text,
      3000
    ) &&
    value.classification ===
      classification &&
    Array.isArray(
      value.sourceReferences
    ) &&
    value.sourceReferences.length <=
      12
  );
}

function validateCurrentProposal(
  proposal,
  {
    sessionId,
    evidenceVersion,
  }
) {
  if (
    !isPlainObject(proposal) ||
    !normalizeUuid(
      proposal.proposalId
    ) ||
    proposal.analysisSessionId !==
      sessionId ||
    Number(
      proposal.evidenceVersion
    ) !== evidenceVersion ||
    proposal.authorityClassification !==
      PROPOSAL_AUTHORITY_CLASSIFICATION ||
    proposal.canonicalMutationPerformed !==
      false ||
    !Array.isArray(
      proposal.questionsForProfessional
    ) ||
    !Array.isArray(
      proposal.observed
    ) ||
    !Array.isArray(
      proposal.needsVerification
    ) ||
    !Array.isArray(
      proposal.repairSuggestions
    ) ||
    !Array.isArray(
      proposal.materialSuggestions
    ) ||
    proposal.questionsForProfessional
      .length > 40 ||
    proposal.observed.length > 40 ||
    proposal.needsVerification
      .length > 40 ||
    proposal.repairSuggestions
      .length > 40 ||
    proposal.materialSuggestions
      .length > 40 ||
    !proposal
      .questionsForProfessional
      .every(validQuestion) ||
    !proposal.observed.every(
      (item) =>
        validAssistanceItem(
          item,
          "OBSERVED"
        )
    ) ||
    !proposal.needsVerification
      .every(
        (item) =>
          validAssistanceItem(
            item,
            "NEEDS_VERIFICATION"
          )
      ) ||
    !proposal.repairSuggestions
      .every(
        (item) =>
          validAssistanceItem(
            item,
            "AI_SUGGESTED"
          )
      ) ||
    !proposal.materialSuggestions
      .every(
        (item) =>
          validAssistanceItem(
            item,
            "AI_SUGGESTED"
          )
      ) ||
    !isPlainObject(
      proposal.reviewContract
    ) ||
    proposal.reviewContract
      .explicitHumanDecisionRequired !==
      true
  ) {
    return null;
  }

  const ids =
    new Set();

  for (
    const collection of [
      proposal.questionsForProfessional,
      proposal.observed,
      proposal.needsVerification,
      proposal.repairSuggestions,
      proposal.materialSuggestions,
    ]
  ) {
    for (const item of collection) {
      const id =
        safeElementId(item.id);

      if (
        !id ||
        ids.has(id)
      ) {
        return null;
      }

      ids.add(id);
    }
  }

  return proposal;
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
      /* quick_quote_reviewed_result:reviews */
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

function createElementRegistry(
  proposal
) {
  const registry =
    new Map();

  const add = (
    category,
    items,
    maximumTextLength
  ) => {
    for (const item of items) {
      registry.set(
        safeElementId(item.id),
        {
          category,
          item,
          maximumTextLength,
        }
      );
    }
  };

  add(
    "question",
    proposal.questionsForProfessional,
    1200
  );

  add(
    "reviewedObservations",
    proposal.observed,
    3000
  );

  add(
    "needsVerification",
    proposal.needsVerification,
    3000
  );

  add(
    "reviewedSolution",
    proposal.repairSuggestions,
    3000
  );

  add(
    "materialsList",
    proposal.materialSuggestions,
    3000
  );

  return registry;
}

function latestReviewDecisions(
  reviewRows,
  registry
) {
  if (!Array.isArray(reviewRows)) {
    return null;
  }

  const latest =
    new Map();

  for (const row of reviewRows) {
    const elementId =
      safeElementId(
        row?.proposal_element_id
      );

    const action =
      typeof row?.action === "string"
        ? row.action
            .trim()
            .toUpperCase()
        : "";

    if (
      !elementId ||
      !registry.has(elementId) ||
      !REVIEW_ACTIONS.has(action)
    ) {
      continue;
    }

    const definition =
      registry.get(elementId);

    let editedValue = null;

    if (action === "EDITED") {
      if (
        !isPlainObject(
          row.edited_value
        )
      ) {
        return null;
      }

      const editedText =
        safeText(
          row.edited_value.text,
          definition
            .maximumTextLength
        );

      if (!editedText) {
        return null;
      }

      /*
       * Only professional-edited wording is trusted.
       * Identity, classification, category, and source
       * references always remain server-proposal owned.
       */
      editedValue = {
        text: editedText,
      };
    }

    latest.set(
      elementId,
      {
        elementId,
        action,
        editedValue,
      }
    );
  }

  return latest;
}

function projectReviewedItem(
  definition,
  decision
) {
  if (
    !decision ||
    decision.action === "REJECTED"
  ) {
    return null;
  }

  const original =
    definition.item;

  const text =
    decision.action === "EDITED"
      ? decision.editedValue.text
      : original.text;

  return {
    elementId:
      safeElementId(original.id),
    text,
    reviewAction:
      decision.action,
    classification:
      original.classification,
    sourceReferences:
      cloneBoundedJson(
        original.sourceReferences,
        {
          maxBytes: 16384,
          maxStringLength: 2000,
          maxKeys: 120,
          maxArrayLength: 12,
        }
      ),
  };
}

function buildReviewedResult({
  proposal,
  reviewRows,
  sessionId,
  evidenceVersion,
}) {
  const registry =
    createElementRegistry(
      proposal
    );

  const latest =
    latestReviewDecisions(
      reviewRows,
      registry
    );

  if (!latest) {
    return null;
  }

  const projected = {
    reviewedObservations: [],
    needsVerification: [],
    reviewedSolution: [],
    materialsList: [],
  };

  for (
    const [
      elementId,
      definition,
    ] of registry
  ) {
    if (
      definition.category ===
      "question"
    ) {
      continue;
    }

    const decision =
      latest.get(elementId);

    const item =
      projectReviewedItem(
        definition,
        decision
      );

    if (!item) {
      continue;
    }

    projected[
      definition.category
    ].push(item);
  }

  const reviewedElementIds =
    [];

  const rejectedElementIds =
    [];

  for (
    const [
      elementId,
      decision,
    ] of latest
  ) {
    if (
      decision.action ===
      "REJECTED"
    ) {
      rejectedElementIds.push(
        elementId
      );
    } else {
      reviewedElementIds.push(
        elementId
      );
    }
  }

  reviewedElementIds.sort();
  rejectedElementIds.sort();

  return {
    schemaVersion: 1,
    analysisSessionId:
      sessionId,
    evidenceVersion,
    proposalId:
      normalizeUuid(
        proposal.proposalId
      ),
    authorityClassification:
      SESSION_AUTHORITY_CLASSIFICATION,
    sourceProposalAuthorityClassification:
      PROPOSAL_AUTHORITY_CLASSIFICATION,
    reviewedObservations:
      projected.reviewedObservations,
    needsVerification:
      projected.needsVerification,
    reviewedSolution:
      projected.reviewedSolution,
    materialsList:
      projected.materialsList,
    reviewedElementIds,
    rejectedElementIds,
    reviewDecisionCount:
      latest.size,
    canonicalMutationPerformed:
      false,
  };
}

function createQuickQuoteAnalysisReviewedResultService({
  persistence = repository,
  reviewLoader =
    loadWorkflowReviews,
} = {}) {
  async function getReviewedResult(
    input = {}
  ) {
    const actor =
      normalizeActor(
        input.authenticatedActor
      );

    if (!actor) {
      return response(
        false,
        401,
        "QUICK_QUOTE_ANALYSIS_AUTHENTICATION_REQUIRED",
        "Authentication required."
      );
    }

    if (
      !input.pool ||
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
                    actor.id,
                }
              );

          if (
            !session ||
            session
              .authority_classification !==
              SESSION_AUTHORITY_CLASSIFICATION
          ) {
            return response(
              false,
              404,
              "QUICK_QUOTE_ANALYSIS_SESSION_UNAVAILABLE",
              "The Job Analysis session is unavailable."
            );
          }

          const evidence =
            await persistence
              .loadLatestEvidence(
                client,
                {
                  sessionId,
                  actorUserId:
                    actor.id,
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

          const evidenceVersion =
            Number(
              evidence.version
            );

          if (
            !Number.isInteger(
              evidenceVersion
            ) ||
            evidenceVersion < 1
          ) {
            return response(
              false,
              502,
              "QUICK_QUOTE_ANALYSIS_REVIEWED_RESULT_INVALID",
              "The reviewed Job Analysis result is invalid."
            );
          }

          const turns =
            await persistence
              .listTurns(
                client,
                {
                  sessionId,
                  actorUserId:
                    actor.id,
                }
              );

          const meetroTurn =
            [...turns]
              .reverse()
              .find(
                (turn) =>
                  turn.role ===
                    "MEETRO" &&
                  turn
                    .authority_classification ===
                    SESSION_AUTHORITY_CLASSIFICATION &&
                  Number(
                    turn
                      .evidence_version
                  ) ===
                    evidenceVersion
              );

          if (!meetroTurn) {
            return response(
              false,
              404,
              "QUICK_QUOTE_ANALYSIS_REVIEWED_RESULT_UNAVAILABLE",
              "The current Job Analysis has no reviewed result yet."
            );
          }

          const proposal =
            validateCurrentProposal(
              meetroTurn
                .turn_payload,
              {
                sessionId,
                evidenceVersion,
              }
            );

          if (!proposal) {
            return response(
              false,
              502,
              "QUICK_QUOTE_ANALYSIS_REVIEWED_RESULT_INVALID",
              "The reviewed Job Analysis result is invalid."
            );
          }

          const reviewRows =
            await reviewLoader(
              client,
              {
                proposalId:
                  proposal.proposalId,
                actorUserId:
                  actor.id,
              }
            );

          let reviewedResult;

          try {
            reviewedResult =
              buildReviewedResult({
                proposal,
                reviewRows,
                sessionId,
                evidenceVersion,
              });
          } catch {
            reviewedResult =
              null;
          }

          if (!reviewedResult) {
            return response(
              false,
              502,
              "QUICK_QUOTE_ANALYSIS_REVIEWED_RESULT_INVALID",
              "The reviewed Job Analysis result is invalid."
            );
          }

          return response(
            true,
            200,
            "QUICK_QUOTE_ANALYSIS_REVIEWED_RESULT_LOADED",
            "The professional-reviewed Job Analysis result was loaded.",
            {
              reviewedResult,
              canonicalMutationPerformed:
                false,
            }
          );
        }
      );
  }

  return Object.freeze({
    getReviewedResult,
  });
}

const canonicalQuickQuoteAnalysisReviewedResultService =
  createQuickQuoteAnalysisReviewedResultService();

module.exports = {
  PROPOSAL_AUTHORITY_CLASSIFICATION,
  SESSION_AUTHORITY_CLASSIFICATION,
  buildReviewedResult,
  canonicalQuickQuoteAnalysisReviewedResultService,
  createQuickQuoteAnalysisReviewedResultService,
  loadWorkflowReviews,
  validateCurrentProposal,
};
