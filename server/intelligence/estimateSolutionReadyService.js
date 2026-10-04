"use strict";

const {
  cloneBoundedJson,
  isPlainObject,
} = require("./intelligenceGatewayContracts");

const {
  loadAuthorizedJob: loadAuthorizedJobDefault,
} = require("./quoteCompositionContext");

const SOURCE_AUTHORITY =
  "INTERNAL_ESTIMATE_DRAFT_NON_CANONICAL";

const REVIEWED_AUTHORITY =
  "REVIEWED_INTERNAL_ESTIMATE_NON_CANONICAL";

const REVIEW_ACTIONS =
  new Set([
    "ACCEPTED",
    "EDITED",
    "REJECTED",
  ]);

const ELEMENT_ID =
  /^[a-z][a-z0-9_.:-]{0,159}$/;

function safeElementId(value) {
  const normalized =
    typeof value === "string"
      ? value.trim().toLowerCase()
      : "";

  return ELEMENT_ID.test(normalized)
    ? normalized
    : "";
}

function safeClone(value) {
  try {
    return cloneBoundedJson(value, {
      maxBytes: 65536,
      maxStringLength: 8000,
      maxKeys: 500,
      maxArrayLength: 100,
    });
  } catch {
    return null;
  }
}

function normalizeProfessionalCategoryCosts(value) {
  if (!isPlainObject(value)) {
    return null;
  }
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "labor" ||
    keys[1] !== "materials"
  ) {
    return null;
  }

  const normalize = (entry, classification) => {
    if (entry == null) return null;
    if (
      !isPlainObject(entry) ||
      Object.keys(entry).sort().join(",") !==
        "amountMinor,basis,classification,customerVisibleByDefault,provenance" ||
      entry.classification !== classification ||
      !Number.isSafeInteger(entry.amountMinor) ||
      entry.amountMinor < 0 ||
      entry.provenance !== "PROFESSIONAL_INPUT" ||
      entry.basis !== "FLAT_TOTAL" ||
      entry.customerVisibleByDefault !== false
    ) {
      return undefined;
    }
    return safeClone(entry);
  };

  const materials = normalize(value.materials, "MATERIAL");
  const labor = normalize(value.labor, "LABOR");
  if (materials === undefined || labor === undefined) {
    return null;
  }
  return { materials, labor };
}

function validProposal(proposal) {
  return Boolean(
    isPlainObject(proposal) &&
    proposal.schemaVersion === 1 &&
    proposal.authorityClassification ===
      SOURCE_AUTHORITY &&
    typeof proposal.proposalId === "string" &&
    proposal.proposalId &&
    typeof proposal.jobId === "string" &&
    proposal.jobId &&
    proposal.humanToCanonicalBoundary
      ?.directMutationAllowed === false &&
    proposal.internalCost
      ?.customerVisible === false &&
    proposal.suggestedSellingRange
      ?.authorityClassification ===
        "ADVISORY" &&
    proposal.reviewContract
      ?.explicitProfessionalDecisionRequired ===
        true
  );
}

function createElementRegistry(proposal) {
  const registry =
    new Map();

  const addCollection = (
    category,
    values
  ) => {
    if (!Array.isArray(values)) {
      return false;
    }

    for (const item of values) {
      if (!isPlainObject(item)) {
        return false;
      }

      const id =
        safeElementId(item.id);

      if (
        !id ||
        registry.has(id)
      ) {
        return false;
      }

      registry.set(id, {
        category,
        item,
      });
    }

    return true;
  };

  if (
    !addCollection(
      "materials",
      proposal.materials
    ) ||
    !addCollection(
      "labor",
      proposal.labor
    ) ||
    !addCollection(
      "equipment",
      proposal.equipment
    ) ||
    !addCollection(
      "assumptions",
      proposal.assumptions
    )
  ) {
    return null;
  }

  if (
    !isPlainObject(
      proposal.customerQuoteDraft
    )
  ) {
    return null;
  }

  const quoteDraftId =
    safeElementId(
      proposal.customerQuoteDraft.id
    );

  if (
    !quoteDraftId ||
    registry.has(quoteDraftId)
  ) {
    return null;
  }

  registry.set(
    quoteDraftId,
    {
      category:
        "customerQuoteDraft",
      item:
        proposal.customerQuoteDraft,
    }
  );

  return registry;
}

function normalizeReviewRows(
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

    /*
     * R1-06 fails closed on EDITED Estimate reviews
     * until explicit field-level edit allowlists exist.
     *
     * Never treat an edited professional decision as
     * acceptance of the original AI proposal value.
     */
    if (action === "EDITED") {
      return null;
    }

    latest.set(
      elementId,
      {
        action,
        editedValue: null,
      }
    );
  }

  return latest;
}

function projectAcceptedElement(
  definition,
  decision
) {
  if (
    !decision ||
    decision.action === "REJECTED"
  ) {
    return null;
  }

  /*
   * ACCEPTED content stays server-proposal owned.
   *
   * EDITED rows are deliberately not merged into the
   * proposal object here. This prevents edited_value
   * from laundering arbitrary commercial, pricing,
   * provenance, or canonical authority into the
   * reviewed Estimate. A later bounded contract may
   * allow specific professional-edited fields.
   */
  return safeClone(
    definition.item
  );
}

function buildReviewedEstimateProjection({
  proposal,
  reviewRows,
} = {}) {
  if (!validProposal(proposal)) {
    return null;
  }

  const registry =
    createElementRegistry(
      proposal
    );

  if (!registry) {
    return null;
  }

  const latest =
    normalizeReviewRows(
      reviewRows,
      registry
    );

  if (!latest) {
    return null;
  }

  const reviewed = {
    materials: [],
    labor: [],
    equipment: [],
    assumptions: [],
    customerQuoteDraft: null,
  };

  const reviewedElementIds = [];
  const rejectedElementIds = [];
  const unreviewedElementIds = [];

  for (
    const [
      elementId,
      definition,
    ] of registry
  ) {
    const decision =
      latest.get(elementId);

    if (!decision) {
      unreviewedElementIds.push(
        elementId
      );
      continue;
    }

    if (
      decision.action ===
        "REJECTED"
    ) {
      rejectedElementIds.push(
        elementId
      );
      continue;
    }

    const projected =
      projectAcceptedElement(
        definition,
        decision
      );

    if (!projected) {
      return null;
    }

    reviewedElementIds.push(
      elementId
    );

    if (
      definition.category ===
        "customerQuoteDraft"
    ) {
      reviewed.customerQuoteDraft =
        projected;
    } else {
      reviewed[
        definition.category
      ].push(projected);
    }
  }

  reviewedElementIds.sort();
  rejectedElementIds.sort();
  unreviewedElementIds.sort();

  const internalCost =
    safeClone(
      proposal.internalCost
    );

  const suggestedSellingRange =
    safeClone(
      proposal.suggestedSellingRange
    );

  const professionalCategoryCosts =
    proposal.professionalCategoryCosts == null
      ? null
      : normalizeProfessionalCategoryCosts(
          proposal.professionalCategoryCosts
        );

  if (
    !internalCost ||
    !suggestedSellingRange ||
    (
      proposal.professionalCategoryCosts != null &&
      !professionalCategoryCosts
    )
  ) {
    return null;
  }

  return {
    schemaVersion: 1,
    proposalId:
      proposal.proposalId,
    jobId:
      proposal.jobId,
    sourceContextFingerprint:
      proposal.sourceContextFingerprint,
    authorityClassification:
      REVIEWED_AUTHORITY,
    sourceProposalAuthorityClassification:
      SOURCE_AUTHORITY,
    reviewed,
    reviewedElementIds,
    rejectedElementIds,
    unreviewedElementIds,
    reviewDecisionCount:
      latest.size,
    internalCost,
    professionalCategoryCosts,
    suggestedSellingRange,
    professionalSellingPriceMinor:
      proposal.professionalSellingPriceMinor ??
      null,
    humanToCanonicalBoundary: {
      directMutationAllowed: false,
      quoteCompositionRequiresExplicitProfessionalAction:
        true,
    },
    canonicalMutationPerformed:
      false,
  };
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  return Number.isInteger(id) &&
    id > 0
    ? { id }
    : null;
}

function normalizeProposalId(value) {
  const normalized =
    typeof value === "string"
      ? value.trim().toLowerCase()
      : "";

  return UUID.test(normalized)
    ? normalized
    : "";
}

const canonicalEstimateSolutionReadyPersistence = {
  async withReadTransaction(
    pool,
    work
  ) {
    if (
      !pool ||
      typeof pool.connect !== "function"
    ) {
      throw new TypeError(
        "A database pool is required."
      );
    }

    const client =
      await pool.connect();

    let started = false;

    try {
      await client.query(
        "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"
      );

      started = true;

      const result =
        await work(client);

      await client.query("COMMIT");
      started = false;

      return result;
    } catch (error) {
      if (started) {
        try {
          await client.query(
            "ROLLBACK"
          );
        } catch {
          /* preserve original */
        }
      }

      throw error;
    } finally {
      client.release();
    }
  },

  async loadCompletedEstimateProposal(
    client,
    {
      proposalId,
      actorUserId,
    }
  ) {
    const result =
      await client.query(
        `
        /* estimate_solution_ready:proposal */
        SELECT result_payload
        FROM intelligence_operation_idempotency
        WHERE id = $1
          AND actor_user_id = $2
          AND operation = 'estimate.compose'
          AND status = 'completed'
        LIMIT 1
        `,
        [
          proposalId,
          actorUserId,
        ]
      );

    return result.rows[0]
      ?.result_payload || null;
  },

  async loadEstimateReviews(
    client,
    {
      proposalId,
      actorUserId,
    }
  ) {
    const result =
      await client.query(
        `
        /* estimate_solution_ready:reviews */
        SELECT
          id,
          proposal_element_id,
          action,
          edited_value,
          created_at
        FROM intelligence_workflow_review_events
        WHERE operation_id = $1
          AND actor_user_id = $2
          AND operation_type = 'estimate.compose'
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
  },
};

function createEstimateSolutionReadyService({
  persistence =
    canonicalEstimateSolutionReadyPersistence,
  loadAuthorizedJob =
    loadAuthorizedJobDefault,
} = {}) {
  if (
    !persistence ||
    typeof persistence
      .withReadTransaction !==
      "function" ||
    typeof persistence
      .loadCompletedEstimateProposal !==
      "function" ||
    typeof persistence
      .loadEstimateReviews !==
      "function" ||
    typeof loadAuthorizedJob !==
      "function"
  ) {
    throw new TypeError(
      "Estimate Solution Ready dependencies are required."
    );
  }

  async function prepareReviewedEstimate(
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
        "ESTIMATE_SOLUTION_READY_AUTHENTICATION_REQUIRED",
        "Authentication required."
      );
    }

    const proposalId =
      normalizeProposalId(
        input.proposalId
      );

    if (!proposalId) {
      return response(
        false,
        400,
        "ESTIMATE_SOLUTION_READY_REQUEST_INVALID",
        "A valid Internal Estimate proposal is required."
      );
    }

    return persistence
      .withReadTransaction(
        input.pool,
        async (client) => {
          const proposal =
            await persistence
              .loadCompletedEstimateProposal(
                client,
                {
                  proposalId,
                  actorUserId:
                    actor.id,
                }
              );

          if (!proposal) {
            return response(
              false,
              404,
              "ESTIMATE_SOLUTION_READY_PROPOSAL_UNAVAILABLE",
              "The Internal Estimate proposal is unavailable."
            );
          }

          if (
            !validProposal(proposal) ||
            String(
              proposal.proposalId
            )
              .trim()
              .toLowerCase() !==
              proposalId
          ) {
            return response(
              false,
              409,
              "ESTIMATE_SOLUTION_READY_CONTEXT_INVALID",
              "The Internal Estimate context is invalid."
            );
          }

          let authorizedJob;

          try {
            authorizedJob =
              await loadAuthorizedJob(
                client,
                proposal.jobId,
                actor.id
              );
          } catch (error) {
            if (
              error?.code ===
                "intelligence_quote_authority_required" ||
              error?.code ===
                "intelligence_lifecycle_v2_required"
            ) {
              return response(
                false,
                403,
                "ESTIMATE_SOLUTION_READY_AUTHORITY_REQUIRED",
                "Professional Quote authority is required."
              );
            }

            if (
              error?.code ===
              "intelligence_job_unavailable"
            ) {
              return response(
                false,
                404,
                "ESTIMATE_SOLUTION_READY_PROPOSAL_UNAVAILABLE",
                "The Internal Estimate proposal is unavailable."
              );
            }

            throw error;
          }

          if (
            String(
              authorizedJob?.job_id ||
                ""
            ) !==
            String(proposal.jobId)
          ) {
            return response(
              false,
              409,
              "ESTIMATE_SOLUTION_READY_CONTEXT_INVALID",
              "The Internal Estimate context is invalid."
            );
          }

          const reviewRows =
            await persistence
              .loadEstimateReviews(
                client,
                {
                  proposalId,
                  actorUserId:
                    actor.id,
                }
              );

          const reviewedEstimate =
            buildReviewedEstimateProjection({
              proposal,
              reviewRows,
            });

          if (!reviewedEstimate) {
            return response(
              false,
              409,
              "ESTIMATE_SOLUTION_READY_CONTEXT_INVALID",
              "The reviewed Internal Estimate context is invalid."
            );
          }

          return response(
            true,
            200,
            "ESTIMATE_SOLUTION_READY_CONTEXT_PREPARED",
            "The reviewed Internal Estimate context was prepared.",
            {
              reviewedEstimate,
              canonicalMutationPerformed:
                false,
            }
          );
        }
      );
  }

  return {
    prepareReviewedEstimate,
  };
}

const canonicalEstimateSolutionReadyService =
  createEstimateSolutionReadyService();

module.exports = {
  REVIEWED_AUTHORITY,
  SOURCE_AUTHORITY,
  buildReviewedEstimateProjection,
  canonicalEstimateSolutionReadyPersistence,
  canonicalEstimateSolutionReadyService,
  createEstimateSolutionReadyService,
};
