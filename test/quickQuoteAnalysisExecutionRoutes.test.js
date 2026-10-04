"use strict";

const assert =
  require("node:assert/strict");

const test =
  require("node:test");

process.env.NODE_ENV =
  "test";

process.env.JWT_SECRET =
  "explicit-test-jwt-secret-quick-quote-analysis-execution-routes";

const {
  app,
  authMiddleware,
} = require("../index");

const {
  QUICK_QUOTE_ANALYSIS_ANALYZE_ROUTE,
  QUICK_QUOTE_ANALYSIS_CONTINUE_ROUTE,
  registerIntelligenceRoutes,
  setIntelligenceNoStore,
} = require(
  "../server/intelligence/intelligenceRoutes"
);

const SESSION_ID =
  "11111111-1111-4111-8111-111111111111";

const PRIOR_ID =
  "22222222-2222-4222-8222-222222222222";

const PROPOSAL_ID =
  "33333333-3333-4333-8333-333333333333";

const IDEMPOTENCY_KEY =
  "44444444-4444-4444-8444-444444444444";

function response() {
  const headers = new Map();

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

    setHeader(name, value) {
      headers.set(
        String(name).toLowerCase(),
        value
      );
    },

    getHeader(name) {
      return headers.get(
        String(name).toLowerCase()
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
    if (res.finished) break;

    if (handler.length < 3) {
      await handler(req, res);
      continue;
    }

    await new Promise(
      (resolve, reject) => {
        const next = (error) =>
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
      layer.route?.path === path &&
      layer.route.methods?.[
        method
      ]
  );
}

function createRegistrations() {
  const registrations = [];

  const fakeApp = {
    post(path, ...handlers) {
      registrations.push({
        method: "post",
        path,
        handlers,
      });
    },

    get(path, ...handlers) {
      registrations.push({
        method: "get",
        path,
        handlers,
      });
    },

    delete(path, ...handlers) {
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

function findRegistration(
  registrations,
  method,
  path
) {
  const found =
    registrations.filter(
      (item) =>
        item.method === method &&
        item.path === path
    );

  assert.equal(
    found.length,
    1
  );

  return found[0];
}

function registerFakeRoutes(calls) {
  const {
    fakeApp,
    registrations,
  } =
    createRegistrations();

  const pool = {
    name:
      "analysis-execution-pool",
  };

  const providers = {
    workflow_assistance: {
      name:
        "workflow_assistance",
    },
  };

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
      return pool;
    },

    analysisContinuationService: {
      async analyzeSession(input) {
        calls.push({
          type: "analyze",
          input,
        });

        return {
          ok: true,
          status: 201,
          code:
            "QUICK_QUOTE_ANALYSIS_COMPLETED",
          message:
            "Completed.",
          proposal: {
            proposalId:
              PROPOSAL_ID,
          },
          turns: [],
          replayed: false,
          canonicalMutationPerformed:
            false,
        };
      },

      async continueSession(input) {
        calls.push({
          type: "continue",
          input,
        });

        return {
          ok: true,
          status: 201,
          code:
            "QUICK_QUOTE_ANALYSIS_CONTINUED",
          message:
            "Continued.",
          proposal: {
            proposalId:
              PROPOSAL_ID,
          },
          turns: [],
          replayed: false,
          canonicalMutationPerformed:
            false,
        };
      },
    },

    providers,

    repository: {
      name:
        "intelligence-repository",
    },

    providerTimeoutMs:
      9000,
  });

  return {
    registrations,
    pool,
    providers,
  };
}

test(
  "actual app mounts authenticated no-store analyze and continue routes and no arbitrary turn route",
  () => {
    for (
      const path of [
        QUICK_QUOTE_ANALYSIS_ANALYZE_ROUTE,
        QUICK_QUOTE_ANALYSIS_CONTINUE_ROUTE,
      ]
    ) {
      const route =
        actualRoute(
          path,
          "post"
        );

      assert.ok(route);

      assert.equal(
        route.route.stack.length,
        3
      );

      assert.equal(
        route.route.stack[0].handle,
        setIntelligenceNoStore
      );

      assert.equal(
        route.route.stack[1].handle,
        authMiddleware
      );
    }

    assert.equal(
      actualRoute(
        "/api/intelligence/quick-quote-analysis/sessions/:sessionId/turns",
        "post"
      ),
      undefined
    );
  }
);

test(
  "actual analyze route rejects unauthenticated execution before database access",
  async () => {
    const route =
      actualRoute(
        QUICK_QUOTE_ANALYSIS_ANALYZE_ROUTE,
        "post"
      );

    assert.ok(route);

    const req = {
      app: {
        locals: {
          pool: {
            connect() {
              throw new Error(
                "database must not be reached"
              );
            },
          },
        },
      },

      headers: {
        "idempotency-key":
          IDEMPOTENCY_KEY,
      },

      params: {
        sessionId:
          SESSION_ID,
      },

      body: {},
    };

    const res = response();

    await runHandlers(
      route.route.stack.map(
        ({ handle }) =>
          handle
      ),
      req,
      res
    );

    assert.equal(
      res.statusCode,
      401
    );

    assert.equal(
      res.getHeader(
        "Cache-Control"
      ),
      "no-store"
    );
  }
);

test(
  "analyze derives actor and session from server authority and rejects browser execution metadata",
  async () => {
    const calls = [];

    const {
      registrations,
      pool,
      providers,
    } =
      registerFakeRoutes(calls);

    const route =
      findRegistration(
        registrations,
        "post",
        QUICK_QUOTE_ANALYSIS_ANALYZE_ROUTE
      );

    const invalidReq = {
      app: {
        locals: {
          intelligenceProviders:
            providers,
        },
      },

      headers: {
        "idempotency-key":
          IDEMPOTENCY_KEY,
      },

      params: {
        sessionId:
          SESSION_ID,
      },

      body: {
        locale: "en",
        evidenceVersion: 99,
      },
    };

    const invalidRes =
      response();

    await runHandlers(
      route.handlers,
      invalidReq,
      invalidRes
    );

    assert.equal(
      invalidRes.statusCode,
      400
    );

    assert.equal(
      calls.length,
      0
    );

    const validReq = {
      app: {
        locals: {
          intelligenceProviders:
            providers,
        },
      },

      headers: {
        "idempotency-key":
          IDEMPOTENCY_KEY,
      },

      params: {
        sessionId:
          SESSION_ID,
      },

      body: {
        locale: "en",
      },
    };

    const validRes =
      response();

    await runHandlers(
      route.handlers,
      validReq,
      validRes
    );

    assert.equal(
      validRes.statusCode,
      201
    );

    assert.equal(
      calls.length,
      1
    );

    const input =
      calls[0].input;

    assert.equal(
      calls[0].type,
      "analyze"
    );

    assert.equal(
      input.pool,
      pool
    );

    assert.deepEqual(
      input.authenticatedActor,
      {
        id: 73,
        role:
          "professional",
      }
    );

    assert.equal(
      input.sessionId,
      SESSION_ID
    );

    assert.equal(
      input.idempotencyKey,
      IDEMPOTENCY_KEY
    );

    assert.equal(
      input.locale,
      "en"
    );

    assert.equal(
      input.providers,
      providers
    );

    assert.equal(
      validRes.body
        .canonicalMutationPerformed,
      false
    );
  }
);

test(
  "continue accepts only prior proposal message and locale while server owns execution authority",
  async () => {
    const calls = [];

    const {
      registrations,
      providers,
    } =
      registerFakeRoutes(calls);

    const route =
      findRegistration(
        registrations,
        "post",
        QUICK_QUOTE_ANALYSIS_CONTINUE_ROUTE
      );

    const rejectedBodies = [
      {
        priorProposalId:
          PRIOR_ID,
      },
      {
        message:
          "Continue",
      },
      {
        priorProposalId:
          PRIOR_ID,
        message:
          "Continue",
        role:
          "MEETRO",
      },
      {
        priorProposalId:
          PRIOR_ID,
        message:
          "Continue",
        evidenceVersion:
          3,
      },
      {
        priorProposalId:
          PRIOR_ID,
        message:
          "Continue",
        operation:
          "quick_quote.analysis.continue",
      },
      {
        priorProposalId:
          PRIOR_ID,
        message:
          "Continue",
        provider:
          "openai",
      },
      {
        priorProposalId:
          PRIOR_ID,
        message:
          "Continue",
        actorUserId:
          999,
      },
    ];

    for (const body of rejectedBodies) {
      const req = {
        app: {
          locals: {
            intelligenceProviders:
              providers,
          },
        },

        headers: {
          "idempotency-key":
            IDEMPOTENCY_KEY,
        },

        params: {
          sessionId:
            SESSION_ID,
        },

        body,
      };

      const res =
        response();

      await runHandlers(
        route.handlers,
        req,
        res
      );

      assert.equal(
        res.statusCode,
        400
      );
    }

    assert.equal(
      calls.length,
      0
    );

    const req = {
      app: {
        locals: {
          intelligenceProviders:
            providers,
        },
      },

      headers: {
        "idempotency-key":
          IDEMPOTENCY_KEY,
      },

      params: {
        sessionId:
          SESSION_ID,
      },

      body: {
        priorProposalId:
          PRIOR_ID,

        message:
          "The footing appears intact.",

        locale:
          "en",
      },
    };

    const res = response();

    await runHandlers(
      route.handlers,
      req,
      res
    );

    assert.equal(
      res.statusCode,
      201
    );

    assert.equal(
      calls.length,
      1
    );

    const input =
      calls[0].input;

    assert.equal(
      calls[0].type,
      "continue"
    );

    assert.deepEqual(
      input.authenticatedActor,
      {
        id: 73,
        role:
          "professional",
      }
    );

    assert.equal(
      input.sessionId,
      SESSION_ID
    );

    assert.equal(
      input.priorProposalId,
      PRIOR_ID
    );

    assert.equal(
      input.message,
      "The footing appears intact."
    );

    assert.equal(
      input.idempotencyKey,
      IDEMPOTENCY_KEY
    );

    assert.equal(
      res.body
        .canonicalMutationPerformed,
      false
    );
  }
);
