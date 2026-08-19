"use strict";

const assert =
  require("node:assert/strict");

const {
  randomUUID,
} = require("node:crypto");

const test =
  require("node:test");

const {
  Pool,
} = require("pg");

const {
  QUICK_QUOTE_ANALYSIS_ANALYZE_ROUTE,
  QUICK_QUOTE_ANALYSIS_CONTINUE_ROUTE,
  WORKFLOW_REVIEW_ROUTE,
  registerIntelligenceRoutes,
} = require(
  "../server/intelligence/intelligenceRoutes"
);

const {
  assertSafeTestDatabaseUrl,
} = require(
  "./helpers/databaseTargetSafety"
);

const databaseUrl =
  process.env
    .QUICK_QUOTE_ANALYSIS_CONTINUATION_DATABASE_URL;

function response() {
  return {
    statusCode:
      200,

    body:
      null,

    finished:
      false,

    headers:
      new Map(),

    status(value) {
      this.statusCode =
        value;

      return this;
    },

    json(value) {
      this.body =
        value;

      this.finished =
        true;

      return this;
    },

    setHeader(name, value) {
      this.headers.set(
        String(name)
          .toLowerCase(),
        value
      );
    },
  };
}

async function runHandlers(
  handlers,
  req,
  res
) {
  for (const handler of handlers) {
    if (res.finished) {
      break;
    }

    if (handler.length < 3) {
      await handler(
        req,
        res
      );

      continue;
    }

    await new Promise(
      (
        resolve,
        reject
      ) => {
        const next =
          (error) =>
            error
              ? reject(error)
              : resolve();

        Promise.resolve(
          handler(
            req,
            res,
            next
          )
        ).then(
          () => {
            if (
              res.finished
            ) {
              resolve();
            }
          },
          reject
        );
      }
    );
  }
}

function registrations() {
  const rows = [];

  return {
    rows,

    app: {
      post(
        path,
        ...handlers
      ) {
        rows.push({
          method:
            "post",
          path,
          handlers,
        });
      },

      get(
        path,
        ...handlers
      ) {
        rows.push({
          method:
            "get",
          path,
          handlers,
        });
      },

      delete(
        path,
        ...handlers
      ) {
        rows.push({
          method:
            "delete",
          path,
          handlers,
        });
      },
    },
  };
}

function route(
  rows,
  method,
  path
) {
  const found =
    rows.filter(
      (item) =>
        item.method === method &&
        item.path === path
    );

  assert.equal(
    found.length,
    1,
    `${method.toUpperCase()} ${path} must be registered exactly once`
  );

  return found[0];
}

function providerResult(
  request
) {
  const continued =
    Boolean(
      request
        ?.quickQuoteAnalysisContext
        ?.priorProposalId
    );

  if (continued) {
    const trusted =
      request
        .quickQuoteAnalysisContext
        .reviewedContext
        .trustedElements;

    assert.equal(
      trusted.length,
      1
    );

    assert.equal(
      trusted[0].elementId,
      "repair_verify_footing"
    );

    assert.equal(
      trusted[0].reviewAction,
      "ACCEPTED"
    );

    assert.equal(
      request
        .quickQuoteAnalysisContext
        .currentProfessionalMessage,
      "The footing appears intact."
    );
  }

  return {
    schemaVersion:
      1,

    assistantMessage:
      continued
        ? "With the footing appearing intact, verify anchorage and concealed movement before finalizing reconstruction."
        : "Inspect the footing and concealed anchorage before choosing the final reconstruction method.",

    summary:
      continued
        ? "The footing appears intact, but concealed anchorage still requires verification."
        : "Visible conditions support further structural verification before the repair method is finalized.",

    questionsForProfessional:
      continued
        ? []
        : [
            {
              id:
                "question_footing",
              text:
                "Can you inspect the footing condition?",
            },
          ],

    observed:
      [],

    needsVerification: [
      {
        id:
          continued
            ? "verify_anchorage"
            : "verify_footing",

        text:
          continued
            ? "Concealed anchorage and movement remain unverified."
            : "The footing condition requires professional verification.",

        classification:
          "NEEDS_VERIFICATION",

        sourceReferences:
          [],
      },
    ],

    repairSuggestions: [
      {
        id:
          continued
            ? "repair_verify_anchorage"
            : "repair_verify_footing",

        text:
          continued
            ? "Select the reconstruction method after concealed anchorage is verified."
            : "Determine the reconstruction method after footing verification.",

        classification:
          "AI_SUGGESTED",

        sourceReferences:
          [],
      },
    ],

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
}

test(
  "PostgreSQL certifies private analyze review continue replay and durable evidence lineage",
  {
    skip:
      !databaseUrl,
  },
  async () => {
    assertSafeTestDatabaseUrl(
      databaseUrl,
      {
        nodeEnv:
          process.env.NODE_ENV,
      }
    );

    const pool =
      new Pool({
        connectionString:
          databaseUrl,
        max:
          6,
      });

    let actorUserId =
      null;

    const sessionId =
      randomUUID();

    let providerCalls =
      0;

    try {
      const user =
        await pool.query(
          `
          INSERT INTO users (
            username,
            email,
            password_hash,
            role,
            account_type
          )
          VALUES (
            $1,
            $2,
            $3,
            'professional',
            'professional'
          )
          RETURNING id
          `,
          [
            "r103-postgres-professional",
            `r103-${randomUUID()}@example.test`,
            "test-only-hash",
          ]
        );

      actorUserId =
        Number(
          user.rows[0].id
        );

      const createCommandId =
        randomUUID();

      const createKey =
        randomUUID();

      const evidenceFingerprint =
        "a".repeat(64);

      await pool.query(
        `
        INSERT INTO quick_quote_analysis_command_idempotency (
          id,
          actor_user_id,
          authority_scope,
          command_name,
          command_scope,
          idempotency_key,
          request_fingerprint,
          result_reference,
          completed_at
        )
        VALUES (
          $1,
          $2,
          $3,
          'quick_quote.analysis_session.create',
          'analysis-session:create',
          $4,
          $5,
          $6::jsonb,
          CURRENT_TIMESTAMP
        )
        `,
        [
          createCommandId,
          actorUserId,
          `user:${actorUserId}`,
          createKey,
          "b".repeat(64),
          JSON.stringify({
            sessionId,
            evidenceVersion:
              1,
            evidenceFingerprint,
          }),
        ]
      );

      await pool.query(
        `
        INSERT INTO quick_quote_analysis_sessions (
          id,
          actor_user_id,
          authority_scope,
          created_command_idempotency_id
        )
        VALUES (
          $1,
          $2,
          $3,
          $4
        )
        `,
        [
          sessionId,
          actorUserId,
          `user:${actorUserId}`,
          createCommandId,
        ]
      );

      await pool.query(
        `
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
          1,
          $2,
          $3,
          '[]'::jsonb,
          $4,
          $5
        )
        `,
        [
          sessionId,
          actorUserId,
          "Customer reports movement after heavy rain.",
          evidenceFingerprint,
          createCommandId,
        ]
      );

      const providers = {
        workflow_assistance: {
          name:
            "workflow_assistance",

          async complete(
            request
          ) {
            providerCalls +=
              1;

            return providerResult(
              request
            );
          },
        },
      };

      const {
        app,
        rows,
      } =
        registrations();

      registerIntelligenceRoutes({
        app,

        authMiddleware(
          req,
          _res,
          next
        ) {
          req.user = {
            id:
              actorUserId,
            role:
              "professional",
          };

          next();
        },

        getPool() {
          return pool;
        },

        providers,
      });

      const analyze =
        route(
          rows,
          "post",
          QUICK_QUOTE_ANALYSIS_ANALYZE_ROUTE
        );

      const review =
        route(
          rows,
          "post",
          WORKFLOW_REVIEW_ROUTE
        );

      const continuation =
        route(
          rows,
          "post",
          QUICK_QUOTE_ANALYSIS_CONTINUE_ROUTE
        );

      const analyzeKey =
        randomUUID();

      const analyzeReq = {
        app: {
          locals: {
            intelligenceProviders:
              providers,
          },
        },

        headers: {
          "idempotency-key":
            analyzeKey,
        },

        params: {
          sessionId,
        },

        body: {
          locale:
            "en",
        },
      };

      const analyzeRes =
        response();

      await runHandlers(
        analyze.handlers,
        analyzeReq,
        analyzeRes
      );

      assert.equal(
        analyzeRes.statusCode,
        201
      );

      assert.equal(
        analyzeRes.body.success,
        true
      );

      assert.equal(
        analyzeRes.body.code,
        "QUICK_QUOTE_ANALYSIS_COMPLETED"
      );

      assert.equal(
        analyzeRes.body
          .canonicalMutationPerformed,
        false
      );

      const firstProposal =
        analyzeRes.body.proposal;

      assert.equal(
        firstProposal
          .analysisSessionId,
        sessionId
      );

      assert.equal(
        firstProposal
          .evidenceVersion,
        1
      );

      assert.equal(
        firstProposal
          .authorityClassification,
        "ADVISORY_NON_CANONICAL"
      );

      const reviewReq = {
        app: {
          locals: {},
        },

        headers: {
          "idempotency-key":
            randomUUID(),
        },

        params: {
          proposalId:
            firstProposal
              .proposalId,
        },

        body: {
          elementId:
            "repair_verify_footing",

          action:
            "ACCEPTED",
        },
      };

      const reviewRes =
        response();

      await runHandlers(
        review.handlers,
        reviewReq,
        reviewRes
      );

      assert.equal(
        reviewRes.statusCode,
        201
      );

      assert.equal(
        reviewRes.body.success,
        true
      );

      assert.equal(
        reviewRes.body
          .canonicalMutationPerformed,
        false
      );

      assert.equal(
        reviewRes.body.review
          .operation,
        "quick_quote.analysis.continue"
      );

      const continueKey =
        randomUUID();

      const continueReq = {
        app: {
          locals: {
            intelligenceProviders:
              providers,
          },
        },

        headers: {
          "idempotency-key":
            continueKey,
        },

        params: {
          sessionId,
        },

        body: {
          priorProposalId:
            firstProposal
              .proposalId,

          message:
            "The footing appears intact.",

          locale:
            "en",
        },
      };

      const continueRes =
        response();

      await runHandlers(
        continuation.handlers,
        continueReq,
        continueRes
      );

      assert.equal(
        continueRes.statusCode,
        201
      );

      assert.equal(
        continueRes.body.success,
        true
      );

      assert.equal(
        continueRes.body.code,
        "QUICK_QUOTE_ANALYSIS_CONTINUED"
      );

      assert.equal(
        continueRes.body
          .canonicalMutationPerformed,
        false
      );

      const secondProposal =
        continueRes.body
          .proposal;

      assert.equal(
        secondProposal
          .analysisSessionId,
        sessionId
      );

      assert.equal(
        secondProposal
          .evidenceVersion,
        1
      );

      assert.equal(
        secondProposal
          .priorProposalId,
        firstProposal
          .proposalId
      );

      const replayRes =
        response();

      await runHandlers(
        continuation.handlers,
        continueReq,
        replayRes
      );

      assert.equal(
        replayRes.statusCode,
        200
      );

      assert.equal(
        replayRes.body.success,
        true
      );

      assert.equal(
        replayRes.body.code,
        "QUICK_QUOTE_ANALYSIS_EXECUTION_REPLAYED"
      );

      assert.equal(
        replayRes.body.replayed,
        true
      );

      assert.equal(
        providerCalls,
        2
      );

      const operations =
        await pool.query(
          `
          SELECT
            id,
            operation,
            actor_user_id,
            status,
            provider_execution_state,
            result_payload
          FROM intelligence_operation_idempotency
          WHERE actor_user_id = $1
            AND operation = 'quick_quote.analysis.continue'
          ORDER BY created_at ASC, id ASC
          `,
          [
            actorUserId,
          ]
        );

      assert.equal(
        operations.rows.length,
        2
      );

      assert.ok(
        operations.rows.every(
          (row) =>
            row.status ===
              "completed" &&
            row.provider_execution_state ===
              "succeeded"
        )
      );

      assert.deepEqual(
        operations.rows.map(
          (row) =>
            row.result_payload
              .analysisSessionId
        ),
        [
          sessionId,
          sessionId,
        ]
      );

      assert.deepEqual(
        operations.rows.map(
          (row) =>
            Number(
              row.result_payload
                .evidenceVersion
            )
        ),
        [
          1,
          1,
        ]
      );

      const turns =
        await pool.query(
          `
          SELECT
            turn_index,
            evidence_version,
            role,
            turn_payload
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

      assert.equal(
        turns.rows.length,
        3
      );

      assert.deepEqual(
        turns.rows.map(
          (row) =>
            row.role
        ),
        [
          "MEETRO",
          "PROFESSIONAL",
          "MEETRO",
        ]
      );

      assert.deepEqual(
        turns.rows.map(
          (row) =>
            Number(
              row.evidence_version
            )
        ),
        [
          1,
          1,
          1,
        ]
      );

      assert.equal(
        turns.rows[0]
          .turn_payload
          .proposalId,
        firstProposal
          .proposalId
      );

      assert.equal(
        turns.rows[1]
          .turn_payload
          .message,
        "The footing appears intact."
      );

      assert.equal(
        turns.rows[2]
          .turn_payload
          .proposalId,
        secondProposal
          .proposalId
      );

      const reviews =
        await pool.query(
          `
          SELECT
            operation_type,
            proposal_element_id,
            action
          FROM intelligence_workflow_review_events
          WHERE actor_user_id = $1
          ORDER BY created_at ASC, id ASC
          `,
          [
            actorUserId,
          ]
        );

      assert.equal(
        reviews.rows.length,
        1
      );

      assert.deepEqual(
        reviews.rows[0],
        {
          operation_type:
            "quick_quote.analysis.continue",

          proposal_element_id:
            "repair_verify_footing",

          action:
            "ACCEPTED",
        }
      );

      const turnCommands =
        await pool.query(
          `
          SELECT
            command_name,
            COUNT(*)::integer AS count
          FROM quick_quote_analysis_command_idempotency
          WHERE actor_user_id = $1
          GROUP BY command_name
          ORDER BY command_name
          `,
          [
            actorUserId,
          ]
        );

      const counts =
        Object.fromEntries(
          turnCommands.rows.map(
            (row) => [
              row.command_name,
              Number(
                row.count
              ),
            ]
          )
        );

      assert.equal(
        counts[
          "quick_quote.analysis_session.create"
        ],
        1
      );

      assert.equal(
        counts[
          "quick_quote.analysis_turn.append"
        ],
        3
      );
    } finally {
      await pool.end();
    }
  }
);
