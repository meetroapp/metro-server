"use strict";

const assert =
  require("node:assert/strict");

const test =
  require("node:test");

const {
  createQuickQuoteAnalysisReviewedResultService,
} = require(
  "../server/intelligence/quickQuoteAnalysisReviewedResultService"
);

const SESSION_ID =
  "10000000-0000-4000-8000-000000000501";

const PROPOSAL_ID =
  "20000000-0000-4000-8000-000000000501";

const ACTOR = {
  id: 73,
  role: "professional",
};

const OTHER_ACTOR = {
  id: 91,
  role: "professional",
};

function proposal() {
  return {
    schemaVersion: 1,
    proposalId:
      PROPOSAL_ID,
    analysisSessionId:
      SESSION_ID,
    evidenceVersion: 3,
    priorProposalId: null,
    authorityClassification:
      "ADVISORY_NON_CANONICAL",
    sourceContextFingerprint:
      "a".repeat(64),
    assistantMessage:
      "Review these findings.",
    summary:
      "Private advisory analysis.",
    questionsForProfessional: [
      {
        id:
          "question_hidden_damage",
        text:
          "Is hidden damage visible after opening the wall?",
      },
    ],
    observed: [
      {
        id:
          "observed_crack",
        text:
          "Visible crack at lower wall.",
        classification:
          "OBSERVED",
        sourceReferences: [
          {
            type:
              "QUOTE_DRAFT_PHOTO",
            id:
              "photo_1",
            version: 1,
          },
        ],
      },
    ],
    needsVerification: [
      {
        id:
          "verify_footing",
        text:
          "Verify footing condition.",
        classification:
          "NEEDS_VERIFICATION",
        sourceReferences: [],
      },
    ],
    repairSuggestions: [
      {
        id:
          "repair_rebuild",
        text:
          "Rebuild the damaged wall section.",
        classification:
          "AI_SUGGESTED",
        sourceReferences: [],
      },
    ],
    materialSuggestions: [
      {
        id:
          "material_block",
        text:
          "Concrete masonry units.",
        classification:
          "AI_SUGGESTED",
        sourceReferences: [
          {
            type:
              "QUOTE_DRAFT_PHOTO",
            id:
              "photo_1",
            version: 1,
          },
        ],
      },
      {
        id:
          "material_extra",
        text:
          "Additional finish material.",
        classification:
          "AI_SUGGESTED",
        sourceReferences: [],
      },
    ],
    photoAnalysis: {
      supported: true,
      analyzedReferenceIds: [
        "photo_1",
      ],
      limitations: [],
      imageMeasurementsAreEstimates:
        true,
    },
    warnings: [],
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
      directMutationAllowed: false,
      workingDraftApplicationRequiresReview:
        true,
      prohibitedCanonicalCommands: [
        "quote.create",
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

function persistenceFixture({
  currentTurn = true,
  malformedProposal = false,
} = {}) {
  return {
    async withReadTransaction(
      _pool,
      work
    ) {
      return work({});
    },

    async loadOwnedSession(
      _client,
      {
        sessionId,
        actorUserId,
      }
    ) {
      if (
        sessionId !== SESSION_ID ||
        Number(actorUserId) !==
          ACTOR.id
      ) {
        return null;
      }

      return {
        id:
          SESSION_ID,
        actor_user_id:
          ACTOR.id,
        authority_classification:
          "PRIVATE_NON_CANONICAL",
      };
    },

    async loadLatestEvidence() {
      return {
        version: 3,
      };
    },

    async listTurns() {
      const old = {
        id:
          "30000000-0000-4000-8000-000000000500",
        turn_index: 1,
        evidence_version: 2,
        role: "MEETRO",
        authority_classification:
          "PRIVATE_NON_CANONICAL",
        turn_payload:
          proposal(),
      };

      if (!currentTurn) {
        return [old];
      }

      const currentProposal =
        proposal();

      if (malformedProposal) {
        currentProposal
          .canonicalMutationPerformed =
          true;
      }

      return [
        old,
        {
          id:
            "30000000-0000-4000-8000-000000000501",
          turn_index: 2,
          evidence_version: 3,
          role: "MEETRO",
          authority_classification:
            "PRIVATE_NON_CANONICAL",
          turn_payload:
            currentProposal,
        },
      ];
    },
  };
}

const pool = {
  async connect() {
    throw new Error(
      "Injected persistence owns transactions."
    );
  },
};

test(
  "reviewed result projects only durable accepted or edited current-proposal content",
  async () => {
    const service =
      createQuickQuoteAnalysisReviewedResultService({
        persistence:
          persistenceFixture(),

        async reviewLoader() {
          return [
            {
              id: "review-1",
              proposal_element_id:
                "observed_crack",
              action: "REJECTED",
              edited_value: null,
            },
            {
              id: "review-2",
              proposal_element_id:
                "observed_crack",
              action: "ACCEPTED",
              edited_value: null,
            },
            {
              id: "review-3",
              proposal_element_id:
                "verify_footing",
              action: "ACCEPTED",
              edited_value: null,
            },
            {
              id: "review-4",
              proposal_element_id:
                "repair_rebuild",
              action: "ACCEPTED",
              edited_value: null,
            },
            {
              id: "review-5",
              proposal_element_id:
                "material_block",
              action: "EDITED",
              edited_value: {
                id:
                  "forged_id",
                text:
                  "8-inch concrete masonry units.",
                classification:
                  "OBSERVED",
                sourceReferences: [
                  {
                    type:
                      "FORGED",
                    id:
                      "forged",
                    version: 999,
                  },
                ],
              },
            },
            {
              id: "review-6",
              proposal_element_id:
                "material_extra",
              action: "REJECTED",
              edited_value: null,
            },
            {
              id: "review-7",
              proposal_element_id:
                "question_hidden_damage",
              action: "ACCEPTED",
              edited_value: null,
            },
          ];
        },
      });

    const result =
      await service
        .getReviewedResult({
          pool,
          authenticatedActor:
            ACTOR,
          sessionId:
            SESSION_ID,
        });

    assert.equal(
      result.status,
      200
    );

    assert.equal(
      result.code,
      "QUICK_QUOTE_ANALYSIS_REVIEWED_RESULT_LOADED"
    );

    assert.equal(
      result
        .canonicalMutationPerformed,
      false
    );

    const reviewed =
      result.reviewedResult;

    assert.equal(
      reviewed
        .authorityClassification,
      "PRIVATE_NON_CANONICAL"
    );

    assert.equal(
      reviewed
        .sourceProposalAuthorityClassification,
      "ADVISORY_NON_CANONICAL"
    );

    assert.equal(
      reviewed
        .evidenceVersion,
      3
    );

    assert.equal(
      reviewed
        .reviewedObservations
        .length,
      1
    );

    assert.equal(
      reviewed
        .needsVerification
        .length,
      1
    );

    assert.equal(
      reviewed
        .reviewedSolution
        .length,
      1
    );

    assert.equal(
      reviewed
        .reviewedSolution[0]
        .text,
      "Rebuild the damaged wall section."
    );

    assert.equal(
      reviewed
        .materialsList
        .length,
      1
    );

    const material =
      reviewed
        .materialsList[0];

    assert.equal(
      material.text,
      "8-inch concrete masonry units."
    );

    assert.equal(
      material.elementId,
      "material_block"
    );

    assert.equal(
      material.classification,
      "AI_SUGGESTED"
    );

    assert.deepEqual(
      material.sourceReferences,
      [
        {
          type:
            "QUOTE_DRAFT_PHOTO",
          id:
            "photo_1",
          version: 1,
        },
      ]
    );

    assert.equal(
      reviewed
        .rejectedElementIds
        .includes(
          "material_extra"
        ),
      true
    );

    assert.equal(
      reviewed
        .reviewedElementIds
        .includes(
          "question_hidden_damage"
        ),
      true
    );

    assert.equal(
      reviewed
        .reviewedSolution
        .some(
          (item) =>
            item.elementId ===
            "question_hidden_damage"
        ),
      false
    );

    assert.equal(
      reviewed
        .materialsList
        .some(
          (item) =>
            item.elementId ===
            "material_extra"
        ),
      false
    );

    assert.equal(
      Object.hasOwn(
        reviewed,
        "pricing"
      ),
      false
    );

    assert.equal(
      Object.hasOwn(
        reviewed,
        "labor"
      ),
      false
    );

    assert.equal(
      Object.hasOwn(
        reviewed,
        "quote"
      ),
      false
    );
  }
);

test(
  "reviewed result never revives a prior-evidence proposal",
  async () => {
    const service =
      createQuickQuoteAnalysisReviewedResultService({
        persistence:
          persistenceFixture({
            currentTurn: false,
          }),

        async reviewLoader() {
          throw new Error(
            "reviews must not load for stale evidence"
          );
        },
      });

    const result =
      await service
        .getReviewedResult({
          pool,
          authenticatedActor:
            ACTOR,
          sessionId:
            SESSION_ID,
        });

    assert.equal(
      result.status,
      404
    );

    assert.equal(
      result.code,
      "QUICK_QUOTE_ANALYSIS_REVIEWED_RESULT_UNAVAILABLE"
    );
  }
);

test(
  "reviewed result is owner scoped and malformed proposal truth fails closed",
  async () => {
    const ownerScoped =
      createQuickQuoteAnalysisReviewedResultService({
        persistence:
          persistenceFixture(),

        async reviewLoader() {
          return [];
        },
      });

    const denied =
      await ownerScoped
        .getReviewedResult({
          pool,
          authenticatedActor:
            OTHER_ACTOR,
          sessionId:
            SESSION_ID,
        });

    assert.equal(
      denied.status,
      404
    );

    const malformed =
      createQuickQuoteAnalysisReviewedResultService({
        persistence:
          persistenceFixture({
            malformedProposal:
              true,
          }),

        async reviewLoader() {
          return [];
        },
      });

    const unsafe =
      await malformed
        .getReviewedResult({
          pool,
          authenticatedActor:
            ACTOR,
          sessionId:
            SESSION_ID,
        });

    assert.equal(
      unsafe.status,
      502
    );

    assert.equal(
      unsafe.code,
      "QUICK_QUOTE_ANALYSIS_REVIEWED_RESULT_INVALID"
    );
  }
);
