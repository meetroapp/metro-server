"use strict";

const assert =
  require("node:assert/strict");

const test =
  require("node:test");

const {
  QUICK_QUOTE_ANALYSIS_PROVIDER_TIMEOUT_MS,
  createQuickQuoteAnalysisContinuationService,
  internalOperationRegistry,
} = require(
  "../server/intelligence/quickQuoteAnalysisContinuationService"
);

const {
  canonicalIntelligenceOperationRegistry,
} = require(
  "../server/intelligence/intelligenceOperationRegistry"
);

const SESSION_ID =
  "11111111-1111-4111-8111-111111111111";

const PRIOR_ID =
  "22222222-2222-4222-8222-222222222222";

const PROPOSAL_ID =
  "33333333-3333-4333-8333-333333333333";

const KEY =
  "44444444-4444-4444-8444-444444444444";

const KEY_2 =
  "55555555-5555-4555-8555-555555555555";

const POOL = {
  connect() {
    throw new Error(
      "fake persistence owns transactions"
    );
  },
};

function proposal({
  priorProposalId =
    null,
  evidenceVersion =
    3,
} = {}) {
  return {
    schemaVersion:
      1,

    proposalId:
      PROPOSAL_ID,

    analysisSessionId:
      SESSION_ID,

    evidenceVersion,

    priorProposalId,

    authorityClassification:
      "ADVISORY_NON_CANONICAL",

    assistantMessage:
      "Verify the concealed condition before finalizing the repair.",

    summary:
      "Further verification is required.",

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
      supported:
        false,
      analyzedReferenceIds:
        [],
      limitations:
        [],
      imageMeasurementsAreEstimates:
        true,
    },

    warnings:
      [],

    reviewContract: {
      explicitHumanDecisionRequired:
        true,
    },

    humanToCanonicalBoundary: {
      directMutationAllowed:
        false,
    },

    learningContext: {
      learnedPatternIsCanonicalRule:
        false,
    },

    canonicalMutationPerformed:
      false,
  };
}

function fakePersistence() {
  const state = {
    evidenceVersion:
      3,
    turns:
      [],
    commands:
      new Map(),
  };

  function commandKey(values) {
    return [
      values.actorUserId,
      values.commandName,
      values.commandScope,
      values.idempotencyKey,
    ].join("|");
  }

  return {
    state,

    async withReadTransaction(
      _pool,
      work
    ) {
      return work({});
    },

    async withTransaction(
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
        sessionId !==
          SESSION_ID ||
        actorUserId !== 41
      ) {
        return null;
      }

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
          state.evidenceVersion,
      };
    },

    async findCommand(
      _client,
      values
    ) {
      return (
        state.commands.get(
          commandKey(values)
        ) ||
        null
      );
    },

    async reserveCommand(
      _client,
      values
    ) {
      const key =
        commandKey(values);

      const existing =
        state.commands.get(key);

      if (existing) {
        return {
          created:
            false,
          record:
            existing,
        };
      }

      const row = {
        id:
          values.commandId,
        actor_user_id:
          values.actorUserId,
        command_name:
          values.commandName,
        command_scope:
          values.commandScope,
        idempotency_key:
          values.idempotencyKey,
        request_fingerprint:
          values.requestFingerprint,
        result_reference:
          null,
        completed_at:
          null,
      };

      state.commands.set(
        key,
        row
      );

      return {
        created:
          true,
        record:
          row,
      };
    },

    async nextTurnIndex() {
      return (
        state.turns.length +
        1
      );
    },

    async appendTurnRecord(
      _client,
      values
    ) {
      const row = {
        id:
          values.turnId,
        session_id:
          values.sessionId,
        turn_index:
          values.turnIndex,
        actor_user_id:
          values.actorUserId,
        evidence_version:
          values.evidenceVersion,
        role:
          values.role,
        authority_classification:
          "PRIVATE_NON_CANONICAL",
        turn_payload:
          values.turnPayload,
        command_idempotency_id:
          values.commandId,
        created_at:
          new Date(
            "2026-08-19T18:00:00.000Z"
          ),
      };

      state.turns.push(
        row
      );

      return row;
    },

    async completeCommand(
      _client,
      {
        commandId,
        resultReference,
      }
    ) {
      const row =
        [...state.commands.values()]
          .find(
            (item) =>
              item.id ===
              commandId
          );

      assert.ok(row);

      row.result_reference =
        resultReference;

      row.completed_at =
        new Date(
          "2026-08-19T18:00:01.000Z"
        );

      return row;
    },

    async loadTurn(
      _client,
      {
        turnId,
      }
    ) {
      return (
        state.turns.find(
          (item) =>
            item.id ===
            turnId
        ) ||
        null
      );
    },
  };
}

test(
  "initial analysis executes only the internal continuation operation and records one Meetro turn",
  async () => {
    const persistence =
      fakePersistence();

    const calls = [];

    const service =
      createQuickQuoteAnalysisContinuationService({
        persistence,

        async gateway(input) {
          calls.push(input);

          return {
            ok:
              true,
            status:
              201,
            code:
              "INTELLIGENCE_OPERATION_COMPLETED",
            replayed:
              false,
            result:
              proposal(),
          };
        },
      });

    const result =
      await service
        .analyzeSession({
          pool:
            POOL,

          authenticatedActor: {
            id:
              41,
            role:
              "professional",
          },

          sessionId:
            SESSION_ID,

          idempotencyKey:
            KEY,

          locale:
            "en",
        });

    assert.equal(
      result.ok,
      true
    );

    assert.equal(
      result.status,
      201
    );

    assert.equal(
      calls.length,
      1
    );

    assert.equal(
      calls[0].body.operation,
      "quick_quote.analysis.continue"
    );

    assert.equal(
      calls[0].operationRegistry,
      internalOperationRegistry
    );

    assert.equal(
      calls[0].body.input
        .evidenceVersion,
      3
    );

    assert.equal(
      calls[0].body.input
        .priorProposalId,
      null
    );

    assert.equal(
      calls[0].body.input
        .message,
      null
    );

    assert.equal(
      calls[0].providerTimeoutMs,
      QUICK_QUOTE_ANALYSIS_PROVIDER_TIMEOUT_MS
    );

    assert.equal(
      persistence
        .state
        .turns
        .length,
      1
    );

    assert.equal(
      persistence
        .state
        .turns[0]
        .role,
      "MEETRO"
    );

    assert.equal(
      persistence
        .state
        .turns[0]
        .turn_payload
        .proposalId,
      PROPOSAL_ID
    );
  }
);

test(
  "continuation records professional then Meetro turns against one evidence version",
  async () => {
    const persistence =
      fakePersistence();

    const service =
      createQuickQuoteAnalysisContinuationService({
        persistence,

        async gateway(input) {
          assert.equal(
            input.body.input
              .priorProposalId,
            PRIOR_ID
          );

          assert.equal(
            input.body.input
              .message,
            "The footing looks intact."
          );

          return {
            ok:
              true,
            status:
              201,
            replayed:
              false,
            result:
              proposal({
                priorProposalId:
                  PRIOR_ID,
              }),
          };
        },
      });

    const result =
      await service
        .continueSession({
          pool:
            POOL,

          authenticatedActor: {
            id:
              41,
            role:
              "professional",
          },

          sessionId:
            SESSION_ID,

          priorProposalId:
            PRIOR_ID,

          message:
            "The footing looks intact.",

          idempotencyKey:
            KEY,

          locale:
            "en",
        });

    assert.equal(
      result.ok,
      true
    );

    assert.deepEqual(
      persistence
        .state
        .turns
        .map(
          (row) =>
            row.role
        ),
      [
        "PROFESSIONAL",
        "MEETRO",
      ]
    );

    assert.deepEqual(
      persistence
        .state
        .turns
        .map(
          (row) =>
            row.evidence_version
        ),
      [
        3,
        3,
      ]
    );

    assert.equal(
      persistence
        .state
        .turns[0]
        .turn_payload
        .message,
      "The footing looks intact."
    );

    assert.equal(
      persistence
        .state
        .turns[1]
        .turn_payload
        .proposalId,
      PROPOSAL_ID
    );
  }
);

test(
  "completed provider replay restores the exact durable exchange without duplicate turns",
  async () => {
    const persistence =
      fakePersistence();

    let executions = 0;

    const service =
      createQuickQuoteAnalysisContinuationService({
        persistence,

        async gateway() {
          executions += 1;

          return {
            ok:
              true,
            status:
              executions === 1
                ? 201
                : 200,
            replayed:
              executions > 1,
            result:
              proposal({
                priorProposalId:
                  PRIOR_ID,
              }),
          };
        },
      });

    const input = {
      pool:
        POOL,

      authenticatedActor: {
        id:
          41,
        role:
          "professional",
      },

      sessionId:
        SESSION_ID,

      priorProposalId:
        PRIOR_ID,

      message:
        "Continue from here.",

      idempotencyKey:
        KEY,

      locale:
        "en",
    };

    const first =
      await service
        .continueSession(
          input
        );

    const second =
      await service
        .continueSession(
          input
        );

    assert.equal(
      first.status,
      201
    );

    assert.equal(
      second.status,
      200
    );

    assert.equal(
      second.replayed,
      true
    );

    assert.equal(
      persistence
        .state
        .turns
        .length,
      2
    );

    assert.equal(
      persistence
        .state
        .commands
        .size,
      2
    );
  }
);

test(
  "provider failure records no private conversation turns",
  async () => {
    const persistence =
      fakePersistence();

    const service =
      createQuickQuoteAnalysisContinuationService({
        persistence,

        async gateway() {
          return {
            ok:
              false,
            status:
              503,
            code:
              "INTELLIGENCE_PROVIDER_UNAVAILABLE",
            message:
              "Unavailable.",
          };
        },
      });

    const result =
      await service
        .analyzeSession({
          pool:
            POOL,

          authenticatedActor: {
            id:
              41,
            role:
              "professional",
          },

          sessionId:
            SESSION_ID,

          idempotencyKey:
            KEY,

          locale:
            "en",
        });

    assert.equal(
      result.ok,
      false
    );

    assert.equal(
      persistence
        .state
        .turns
        .length,
      0
    );

    assert.equal(
      persistence
        .state
        .commands
        .size,
      0
    );
  }
);

test(
  "timed-out initial analysis retries against the same durable evidence without duplicate turns",
  async () => {
    const persistence =
      fakePersistence();

    let executions = 0;

    const service =
      createQuickQuoteAnalysisContinuationService({
        persistence,

        async gateway(input) {
          executions += 1;

          assert.equal(
            input.providerTimeoutMs,
            QUICK_QUOTE_ANALYSIS_PROVIDER_TIMEOUT_MS
          );

          if (executions === 1) {
            return {
              ok: false,
              status: 504,
              code:
                "INTELLIGENCE_PROVIDER_TIMEOUT",
              message:
                "The Intelligence provider timed out.",
            };
          }

          return {
            ok: true,
            status: 201,
            replayed: false,
            result: proposal(),
          };
        },
      });

    const baseInput = {
      pool: POOL,
      authenticatedActor: {
        id: 41,
        role: "professional",
      },
      sessionId: SESSION_ID,
      locale: "en",
    };

    const timedOut =
      await service.analyzeSession({
        ...baseInput,
        idempotencyKey: KEY,
      });

    assert.equal(
      timedOut.code,
      "INTELLIGENCE_PROVIDER_TIMEOUT"
    );
    assert.equal(
      persistence.state.evidenceVersion,
      3
    );
    assert.equal(
      persistence.state.turns.length,
      0
    );

    const retried =
      await service.analyzeSession({
        ...baseInput,
        idempotencyKey: KEY_2,
      });

    assert.equal(retried.ok, true);
    assert.equal(executions, 2);
    assert.equal(
      persistence.state.evidenceVersion,
      3
    );
    assert.deepEqual(
      persistence.state.turns.map(
        (turn) => turn.role
      ),
      ["MEETRO"]
    );
  }
);

test(
  "evidence change during provider execution prevents stale provider output from becoming session history",
  async () => {
    const persistence =
      fakePersistence();

    const service =
      createQuickQuoteAnalysisContinuationService({
        persistence,

        async gateway() {
          persistence
            .state
            .evidenceVersion =
            4;

          return {
            ok:
              true,
            status:
              201,
            replayed:
              false,
            result:
              proposal({
                evidenceVersion:
                  3,
              }),
          };
        },
      });

    const result =
      await service
        .analyzeSession({
          pool:
            POOL,

          authenticatedActor: {
            id:
              41,
            role:
              "professional",
          },

          sessionId:
            SESSION_ID,

          idempotencyKey:
            KEY_2,

          locale:
            "en",
        });

    assert.equal(
      result.ok,
      false
    );

    assert.equal(
      result.status,
      409
    );

    assert.equal(
      result.code,
      "QUICK_QUOTE_ANALYSIS_EVIDENCE_STALE"
    );

    assert.equal(
      persistence
        .state
        .turns
        .length,
      0
    );

    assert.equal(
      persistence
        .state
        .commands
        .size,
      0
    );
  }
);

test(
  "continuation remains unavailable through the canonical browser Gateway registry",
  () => {
    assert.equal(
      canonicalIntelligenceOperationRegistry.get(
        "quick_quote.analysis.continue"
      ),
      null
    );

    assert.ok(
      internalOperationRegistry.get(
        "quick_quote.analysis.continue"
      )
    );
  }
);
