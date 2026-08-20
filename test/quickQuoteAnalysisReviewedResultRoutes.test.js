"use strict";

const assert =
  require("node:assert/strict");

const test =
  require("node:test");

process.env.NODE_ENV =
  "test";

process.env.JWT_SECRET =
  "explicit-test-jwt-secret-reviewed-result-routes";

const {
  app,
  authMiddleware,
} = require("../index");

const {
  QUICK_QUOTE_ANALYSIS_REVIEWED_RESULT_ROUTE,
  registerIntelligenceRoutes,
  setIntelligenceNoStore,
} = require(
  "../server/intelligence/intelligenceRoutes"
);

const SESSION_ID =
  "10000000-0000-4000-8000-000000000501";

function response() {
  const headers =
    new Map();

  return {
    statusCode: 200,
    body: null,
    finished: false,

    status(value) {
      this.statusCode = value;
      return this;
    },

    json(value) {
      this.body = value;
      this.finished = true;
      return this;
    },

    setHeader(
      name,
      value
    ) {
      headers.set(
        String(name)
          .toLowerCase(),
        value
      );
    },

    getHeader(name) {
      return headers.get(
        String(name)
          .toLowerCase()
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
      (resolve, reject) => {
        const next =
          (error) =>
            error
              ? reject(error)
              : resolve();

        Promise
          .resolve(
            handler(
              req,
              res,
              next
            )
          )
          .then(
            () => {
              if (res.finished) {
                resolve();
              }
            },
            reject
          );
      }
    );
  }
}

function actualRoute(
  path,
  method
) {
  return app.router.stack.find(
    (layer) =>
      layer.route?.path ===
        path &&
      layer.route.methods?.[
        method
      ]
  );
}

function registrationsFixture() {
  const registrations =
    [];

  const fakeApp = {
    post(
      path,
      ...handlers
    ) {
      registrations.push({
        method: "post",
        path,
        handlers,
      });
    },

    get(
      path,
      ...handlers
    ) {
      registrations.push({
        method: "get",
        path,
        handlers,
      });
    },

    delete(
      path,
      ...handlers
    ) {
      registrations.push({
        method: "delete",
        path,
        handlers,
      });
    },
  };

  return {
    fakeApp,
    registrations,
  };
}

test(
  "actual app mounts reviewed result as authenticated no-store read authority",
  () => {
    const route =
      actualRoute(
        QUICK_QUOTE_ANALYSIS_REVIEWED_RESULT_ROUTE,
        "get"
      );

    assert.ok(route);

    assert.equal(
      route.route.stack.length,
      3
    );

    assert.equal(
      route.route.stack[0]
        .handle,
      setIntelligenceNoStore
    );

    assert.equal(
      route.route.stack[1]
        .handle,
      authMiddleware
    );

    assert.equal(
      QUICK_QUOTE_ANALYSIS_REVIEWED_RESULT_ROUTE,
      "/api/intelligence/quick-quote-analysis/sessions/:sessionId/reviewed-result"
    );
  }
);

test(
  "reviewed result read derives actor and session authority server-side",
  async () => {
    const {
      fakeApp,
      registrations,
    } =
      registrationsFixture();

    const calls =
      [];

    registerIntelligenceRoutes({
      app:
        fakeApp,

      authMiddleware(
        req,
        _res,
        next
      ) {
        req.user = {
          id: 73,
          role:
            "professional",
        };

        next();
      },

      getPool() {
        return {
          name:
            "reviewed-result-pool",
        };
      },

      analysisReviewedResultService: {
        async getReviewedResult(
          input
        ) {
          calls.push(input);

          return {
            ok: true,
            status: 200,
            code:
              "QUICK_QUOTE_ANALYSIS_REVIEWED_RESULT_LOADED",
            message:
              "Loaded.",
            reviewedResult: {
              schemaVersion: 1,
              analysisSessionId:
                input.sessionId,
              evidenceVersion: 3,
              proposalId:
                "20000000-0000-4000-8000-000000000501",
              authorityClassification:
                "PRIVATE_NON_CANONICAL",
              sourceProposalAuthorityClassification:
                "ADVISORY_NON_CANONICAL",
              reviewedObservations:
                [],
              needsVerification:
                [],
              reviewedSolution:
                [],
              materialsList:
                [],
              reviewedElementIds:
                [],
              rejectedElementIds:
                [],
              reviewDecisionCount:
                0,
              canonicalMutationPerformed:
                false,
            },
            canonicalMutationPerformed:
              false,
          };
        },
      },
    });

    const matches =
      registrations.filter(
        (item) =>
          item.method ===
            "get" &&
          item.path ===
            QUICK_QUOTE_ANALYSIS_REVIEWED_RESULT_ROUTE
      );

    assert.equal(
      matches.length,
      1
    );

    const req = {
      params: {
        sessionId:
          SESSION_ID,
      },

      headers: {},

      body: {
        actorUserId: 999,
        proposalId:
          "forged",
        authorityScope:
          "user:999",
      },
    };

    const res =
      response();

    await runHandlers(
      matches[0].handlers,
      req,
      res
    );

    assert.equal(
      res.statusCode,
      200
    );

    assert.equal(
      res.getHeader(
        "Cache-Control"
      ),
      "no-store"
    );

    assert.equal(
      calls.length,
      1
    );

    assert.equal(
      calls[0]
        .authenticatedActor.id,
      73
    );

    assert.equal(
      calls[0].sessionId,
      SESSION_ID
    );

    assert.deepEqual(
      Object.keys(
        calls[0]
      ).sort(),
      [
        "authenticatedActor",
        "pool",
        "sessionId",
      ]
    );

    assert.equal(
      res.body
        .canonicalMutationPerformed,
      false
    );
  }
);
