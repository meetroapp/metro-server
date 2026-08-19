"use strict";

const assert =
  require("node:assert/strict");

const test =
  require("node:test");

const {
  canonicalIntelligenceOperationRegistry,
} = require(
  "../server/intelligence/intelligenceOperationRegistry"
);

const {
  createOpenAiWorkflowProvider,
} = require(
  "../server/intelligence/openAiWorkflowProvider"
);

const {
  OPERATION,
  assembleReviewedContext,
  buildQuickQuoteAnalysisContinueProviderRequest,
  createQuickQuoteAnalysisContinueContextBuilder,
  parseQuickQuoteAnalysisContinueResult,
  quickQuoteAnalysisContinueOperationDefinition,
} = require(
  "../server/intelligence/operations/quickQuoteAnalysisContinue"
);

const SESSION_ID =
  "11111111-1111-4111-8111-111111111111";

const PRIOR_ID =
  "22222222-2222-4222-8222-222222222222";

const OPERATION_ID =
  "33333333-3333-4333-8333-333333333333";

const PHOTO_ID =
  "meetro-test/businesses/9/quote-drafts/photo-a";

function priorProposal() {
  return {
    schemaVersion: 1,
    proposalId:
      PRIOR_ID,
    summary:
      "Prior advisory analysis.",
    observed: [
      {
        id:
          "observed_crack",
        text:
          "Visible crack at the lower wall.",
        classification:
          "OBSERVED",
        sourceReferences: [
          {
            type:
              "QUOTE_DRAFT_PHOTO",
            id:
              PHOTO_ID,
            version: 77,
          },
        ],
      },
    ],
    repairSuggestions: [
      {
        id:
          "repair_rebuild",
        text:
          "Evaluate reconstruction.",
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
        sourceReferences: [],
      },
    ],
  };
}

test(
  "reviewed continuation context trusts only the latest explicit professional decisions",
  () => {
    const reviewed =
      assembleReviewedContext({
        proposal:
          priorProposal(),

        reviewRows: [
          {
            proposal_element_id:
              "observed_crack",
            action:
              "REJECTED",
            edited_value:
              null,
          },
          {
            proposal_element_id:
              "observed_crack",
            action:
              "ACCEPTED",
            edited_value:
              null,
          },
          {
            proposal_element_id:
              "repair_rebuild",
            action:
              "EDITED",
            edited_value: {
              id:
                "repair_rebuild",
              text:
                "Reconstruct only after footing condition is verified.",
              classification:
                "AI_SUGGESTED",
              sourceReferences:
                [],
            },
          },
          {
            proposal_element_id:
              "material_block",
            action:
              "REJECTED",
            edited_value:
              null,
          },
        ],
      });

    assert.equal(
      reviewed.reviewDecisionCount,
      3
    );

    assert.deepEqual(
      reviewed.rejectedElementIds,
      [
        "material_block",
      ]
    );

    assert.equal(
      reviewed.trustedElements.length,
      2
    );

    const accepted =
      reviewed.trustedElements.find(
        (item) =>
          item.elementId ===
          "observed_crack"
      );

    assert.equal(
      accepted.reviewAction,
      "ACCEPTED"
    );

    assert.equal(
      accepted.value.text,
      "Visible crack at the lower wall."
    );

    const edited =
      reviewed.trustedElements.find(
        (item) =>
          item.elementId ===
          "repair_rebuild"
      );

    assert.equal(
      edited.reviewAction,
      "EDITED"
    );

    assert.equal(
      edited.value.text,
      "Reconstruct only after footing condition is verified."
    );
  }
);

test(
  "context builder derives the owned current session evidence and linked prior proposal server-side",
  async () => {
    const persistence = {
      async withReadTransaction(
        _pool,
        callback
      ) {
        return callback({
          query() {
            throw new Error(
              "Injected proposal/review loaders own direct SQL in this test."
            );
          },
        });
      },

      async loadOwnedSession(
        _client,
        values
      ) {
        assert.equal(
          values.sessionId,
          SESSION_ID
        );

        assert.equal(
          values.actorUserId,
          41
        );

        return {
          id:
            SESSION_ID,
          actor_user_id:
            41,
          authority_classification:
            "PRIVATE_NON_CANONICAL",
        };
      },

      async loadLatestEvidence() {
        return {
          version: 3,
          professional_input:
            "Customer reports movement after heavy rain.",
          photo_references: [
            {
              type:
                "QUOTE_DRAFT_PHOTO",
              publicId:
                PHOTO_ID,
              secureUrl:
                `https://res.cloudinary.com/test/image/upload/v77/${PHOTO_ID}.jpg`,
              version:
                77,
              format:
                "jpg",
              width:
                1200,
              height:
                900,
              displayOrder:
                0,
            },
          ],
          evidence_fingerprint:
            "a".repeat(64),
        };
      },

      async listTurns() {
        return [
          {
            turn_index:
              1,
            evidence_version:
              3,
            role:
              "MEETRO",
            turn_payload: {
              proposalId:
                PRIOR_ID,
              assistantMessage:
                "I found visible cracking.",
            },
          },
          {
            turn_index:
              2,
            evidence_version:
              3,
            role:
              "PROFESSIONAL",
            turn_payload: {
              message:
                "The homeowner says it moved after rain.",
              priorProposalId:
                PRIOR_ID,
            },
          },
        ];
      },
    };

    const builder =
      createQuickQuoteAnalysisContinueContextBuilder({
        persistence,

        async proposalLoader(
          _client,
          values
        ) {
          assert.equal(
            values.proposalId,
            PRIOR_ID
          );

          assert.equal(
            values.actorUserId,
            41
          );

          return {
            id:
              PRIOR_ID,
            operation:
              "quick_quote.photo_assist",
            actor_user_id:
              41,
            status:
              "completed",
            result_payload:
              priorProposal(),
          };
        },

        async reviewLoader() {
          return [
            {
              proposal_element_id:
                "observed_crack",
              action:
                "ACCEPTED",
              edited_value:
                null,
            },
          ];
        },
      });

    const context =
      await builder({
        context: {},

        input: {
          analysisSessionId:
            SESSION_ID,
          evidenceVersion:
            3,
          priorProposalId:
            PRIOR_ID,
          message:
            "Could movement after rain change the repair approach?",
        },

        runtimeContext: {
          pool: {},
          authenticatedActor: {
            id: 41,
            role:
              "professional",
          },
        },
      });

    assert.equal(
      context.analysisSessionId,
      SESSION_ID
    );

    assert.equal(
      context.evidenceVersion,
      3
    );

    assert.equal(
      context.priorProposalId,
      PRIOR_ID
    );

    assert.equal(
      context.reviewedContext
        .trustedElements
        .length,
      1
    );

    assert.equal(
      context.conversationHistory
        .length,
      1
    );

    assert.equal(
      context.conversationHistory[0]
        .message,
      "I found visible cracking."
    );

    assert.equal(
      context.photos.length,
      1
    );

    assert.equal(
      context.photos[0].id,
      PHOTO_ID
    );

    assert.match(
      context.sourceContextFingerprint,
      /^[0-9a-f]{64}$/
    );
  }
);

test(
  "conversation history contains only turns from the current evidence version",
  () => {
    const {
      normalizeConversationHistory,
    } = require(
      "../server/intelligence/operations/quickQuoteAnalysisContinue"
    );

    const history =
      normalizeConversationHistory(
        [
          {
            turn_index:
              1,
            evidence_version:
              2,
            role:
              "MEETRO",
            turn_payload: {
              assistantMessage:
                "Old analysis",
            },
          },
          {
            turn_index:
              2,
            evidence_version:
              2,
            role:
              "PROFESSIONAL",
            turn_payload: {
              message:
                "Old follow-up",
            },
          },
          {
            turn_index:
              3,
            evidence_version:
              3,
            role:
              "MEETRO",
            turn_payload: {
              assistantMessage:
                "Current analysis",
            },
          },
          {
            turn_index:
              4,
            evidence_version:
              3,
            role:
              "PROFESSIONAL",
            turn_payload: {
              message:
                "Current follow-up",
            },
          },
        ],
        3,
        3
      );

    assert.deepEqual(
      history,
      [
        {
          role:
            "MEETRO",
          message:
            "Current analysis",
          turnIndex:
            3,
        },
      ]
    );
  }
);

test(
  "initial analysis context stays replay-stable by excluding session turns when there is no prior proposal",
  async () => {
    const persistence = {
      async withReadTransaction(
        _pool,
        callback
      ) {
        return callback({});
      },

      async loadOwnedSession() {
        return {
          id:
            SESSION_ID,
          actor_user_id:
            41,
        };
      },

      async loadLatestEvidence() {
        return {
          version:
            3,
          professional_input:
            "Current evidence",
          photo_references:
            [],
          evidence_fingerprint:
            "e".repeat(64),
        };
      },

      async listTurns() {
        return [
          {
            turn_index:
              1,
            evidence_version:
              3,
            role:
              "MEETRO",
            turn_payload: {
              proposalId:
                PRIOR_ID,
              assistantMessage:
                "A previously completed analysis turn.",
            },
          },
        ];
      },
    };

    const builder =
      createQuickQuoteAnalysisContinueContextBuilder({
        persistence,

        async proposalLoader() {
          throw new Error(
            "initial analysis must not load a prior proposal"
          );
        },

        async reviewLoader() {
          throw new Error(
            "initial analysis must not load reviews"
          );
        },
      });

    const context =
      await builder({
        context: {},

        input: {
          analysisSessionId:
            SESSION_ID,
          evidenceVersion:
            3,
          priorProposalId:
            null,
          message:
            null,
        },

        runtimeContext: {
          pool: {},
          authenticatedActor: {
            id:
              41,
            role:
              "professional",
          },
        },
      });

    assert.deepEqual(
      context.conversationHistory,
      []
    );

    assert.equal(
      context.priorProposal,
      null
    );
  }
);

test(
  "context builder rejects a prior proposal linked to an older evidence version",
  async () => {
    const persistence = {
      async withReadTransaction(
        _pool,
        callback
      ) {
        return callback({});
      },

      async loadOwnedSession() {
        return {
          id:
            SESSION_ID,
          actor_user_id:
            41,
        };
      },

      async loadLatestEvidence() {
        return {
          version:
            3,
          professional_input:
            "Current evidence",
          photo_references:
            [],
          evidence_fingerprint:
            "d".repeat(64),
        };
      },

      async listTurns() {
        return [
          {
            turn_index:
              1,
            evidence_version:
              2,
            role:
              "MEETRO",
            turn_payload: {
              proposalId:
                PRIOR_ID,
              assistantMessage:
                "Older analysis",
            },
          },
        ];
      },
    };

    const builder =
      createQuickQuoteAnalysisContinueContextBuilder({
        persistence,

        async proposalLoader() {
          throw new Error(
            "stale lineage must fail before proposal load"
          );
        },

        async reviewLoader() {
          throw new Error(
            "stale lineage must fail before review load"
          );
        },
      });

    await assert.rejects(
      () =>
        builder({
          context: {},

          input: {
            analysisSessionId:
              SESSION_ID,
            evidenceVersion:
              3,
            priorProposalId:
              PRIOR_ID,
            message:
              "Continue",
          },

          runtimeContext: {
            pool: {},
            authenticatedActor: {
              id: 41,
              role:
                "professional",
            },
          },
        }),
      (error) =>
        error?.code ===
        "intelligence_quick_quote_analysis_evidence_stale"
    );
  }
);

test(
  "provider request keeps secure media out of text context and transports only authorized images",
  () => {
    const semanticInput = {
      locale:
        "en",

      capability:
        OPERATION,

      input: {},

      context: {
        authorityClassification:
          "PRIVATE_NON_CANONICAL",

        analysisSessionId:
          SESSION_ID,

        evidenceVersion:
          3,

        evidenceFingerprint:
          "a".repeat(64),

        professionalInput:
          "Inspect the wall.",

        currentProfessionalMessage:
          "What should I verify next?",

        priorProposalId:
          PRIOR_ID,

        reviewedContext: {
          trustedElements: [],
          rejectedElementIds: [],
          reviewDecisionCount:
            0,
        },

        conversationHistory: [],

        photos: [
          {
            id:
              PHOTO_ID,

            secureUrl:
              `https://res.cloudinary.com/test/image/upload/v77/${PHOTO_ID}.jpg`,

            mediaType:
              "IMAGE",

            format:
              "jpg",

            width:
              1200,

            height:
              900,

            version:
              77,

            displayOrder:
              0,

            sourceReferences: [
              {
                type:
                  "QUOTE_DRAFT_PHOTO",
                id:
                  PHOTO_ID,
                version:
                  77,
              },
            ],
          },
        ],

        sourceContextFingerprint:
          "b".repeat(64),
      },
    };

    const request =
      buildQuickQuoteAnalysisContinueProviderRequest({
        semanticInput,

        engineContext: {
          quick_quote_analysis_continuation_boundary: {
            mutationAllowed:
              false,
          },
        },
      });

    assert.equal(
      request.operation,
      OPERATION
    );

    assert.equal(
      request.authorizedImageInputs
        .length,
      1
    );

    assert.equal(
      request.authorizedImageInputs[0]
        .mediaId,
      PHOTO_ID
    );

    assert.equal(
      Object.hasOwn(
        request.quickQuoteAnalysisContext
          .photos[0],
        "secureUrl"
      ),
      false
    );

    assert.equal(
      JSON.stringify(
        request.quickQuoteAnalysisContext
      ).includes(
        "res.cloudinary.com"
      ),
      false
    );
  }
);

test(
  "continuation parser returns private advisory conversation output and refuses unauthorized evidence",
  () => {
    const semanticInput = {
      context: {
        analysisSessionId:
          SESSION_ID,

        evidenceVersion:
          3,

        priorProposalId:
          PRIOR_ID,

        sourceContextFingerprint:
          "c".repeat(64),

        photos: [
          {
            id:
              PHOTO_ID,
            sourceReferences: [
              {
                type:
                  "QUOTE_DRAFT_PHOTO",
                id:
                  PHOTO_ID,
                version:
                  77,
              },
            ],
          },
        ],
      },
    };

    const valid = {
      schemaVersion: 1,

      assistantMessage:
        "Yes. Verify whether the footing moved before choosing the final repair.",

      summary:
        "Rain-related movement remains possible but unverified.",

      questionsForProfessional: [
        {
          id:
            "question_footing",
          text:
            "Can you expose and inspect the footing?",
        },
      ],

      observed: [
        {
          id:
            "observed_crack",
          text:
            "Visible cracking is present.",
          classification:
            "OBSERVED",
          sourceReferences: [
            {
              type:
                "QUOTE_DRAFT_PHOTO",
              id:
                PHOTO_ID,
              version:
                77,
            },
          ],
        },
      ],

      needsVerification: [
        {
          id:
            "verify_footing",
          text:
            "Footing movement requires verification.",
          classification:
            "NEEDS_VERIFICATION",
          sourceReferences:
            [],
        },
      ],

      repairSuggestions: [
        {
          id:
            "repair_after_verification",
          text:
            "Select the reconstruction method after footing verification.",
          classification:
            "AI_SUGGESTED",
          sourceReferences:
            [],
        },
      ],

      materialSuggestions: [
        {
          id:
            "material_after_scope",
          text:
            "Finalize masonry materials after repair scope is confirmed.",
          classification:
            "AI_SUGGESTED",
          sourceReferences:
            [],
        },
      ],

      photoAnalysis: {
        analyzedReferenceIds: [
          PHOTO_ID,
        ],
        limitations: [
          "The footing is not visible.",
        ],
      },

      warnings: [],
    };

    const parsed =
      parseQuickQuoteAnalysisContinueResult(
        valid,
        {
          semanticInput,
          operationId:
            OPERATION_ID,
        }
      );

    assert.equal(
      parsed.proposalId,
      OPERATION_ID
    );

    assert.equal(
      parsed.analysisSessionId,
      SESSION_ID
    );

    assert.equal(
      parsed.authorityClassification,
      "ADVISORY_NON_CANONICAL"
    );

    assert.equal(
      parsed.canonicalMutationPerformed,
      false
    );

    assert.equal(
      parsed.reviewContract
        .explicitHumanDecisionRequired,
      true
    );

    assert.equal(
      parsed.humanToCanonicalBoundary
        .directMutationAllowed,
      false
    );

    const invalid =
      structuredClone(
        valid
      );

    invalid.observed[0]
      .sourceReferences[0]
      .id =
      "foreign-photo";

    assert.throws(
      () =>
        parseQuickQuoteAnalysisContinueResult(
          invalid,
          {
            semanticInput,
            operationId:
              OPERATION_ID,
          }
        ),
      /outside the authorized Job Analysis evidence/
    );
  }
);

test(
  "OpenAI workflow provider transports continuation images with store false and the governed contract",
  async () => {
    let sentBody = null;

    const output = {
      schemaVersion: 1,
      assistantMessage:
        "Verify the footing before finalizing the repair.",
      summary:
        "Additional verification is required.",
      questionsForProfessional:
        [],
      observed:
        [],
      needsVerification:
        [],
      repairSuggestions:
        [],
      materialSuggestions:
        [],
      photoAnalysis: {
        analyzedReferenceIds:
          [],
        limitations:
          [],
      },
      warnings:
        [],
    };

    const provider =
      createOpenAiWorkflowProvider({
        apiKey:
          "test-key",

        model:
          "test-model",

        async fetchImpl(
          _url,
          options
        ) {
          sentBody =
            JSON.parse(
              options.body
            );

          return {
            ok: true,
            status: 200,

            headers: {
              get() {
                return "request-test";
              },
            },

            async json() {
              return {
                output_text:
                  JSON.stringify(
                    output
                  ),
              };
            },
          };
        },
      });

    const result =
      await provider.complete({
        schemaVersion: 1,

        operation:
          OPERATION,

        capability:
          OPERATION,

        quickQuoteAnalysisContext: {
          photos: [
            {
              id:
                PHOTO_ID,
            },
          ],
        },

        authorizedImageInputs: [
          {
            mediaId:
              PHOTO_ID,

            imageUrl:
              `https://res.cloudinary.com/test/image/upload/v77/${PHOTO_ID}.jpg`,
          },
        ],
      });

    assert.deepEqual(
      result,
      output
    );

    assert.equal(
      sentBody.store,
      false
    );

    assert.match(
      sentBody.instructions,
      /reviewedContext\.trustedElements/
    );

    assert.ok(
      Array.isArray(
        sentBody.input
      )
    );

    assert.equal(
      sentBody.input[0]
        .content
        .filter(
          (item) =>
            item.type ===
            "input_image"
        )
        .length,
      1
    );
  }
);

test(
  "R1-03A keeps continuation outside the browser-reachable canonical operation registry",
  () => {
    assert.equal(
      canonicalIntelligenceOperationRegistry.get(
        OPERATION
      ),
      null
    );

    assert.equal(
      quickQuoteAnalysisContinueOperationDefinition
        .operation,
      OPERATION
    );

    assert.equal(
      quickQuoteAnalysisContinueOperationDefinition
        .providerName,
      "workflow_assistance"
    );
  }
);
