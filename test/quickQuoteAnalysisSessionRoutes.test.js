"use strict";

const assert =
  require("node:assert/strict");

const {
  readFileSync,
} = require("node:fs");

const {
  join,
} = require("node:path");

const test =
  require("node:test");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET =
  "explicit-test-jwt-secret-quick-quote-analysis-routes";

const {
  app,
  authMiddleware,
} = require("../index");

const {
  QUICK_QUOTE_ANALYSIS_EVIDENCE_ROUTE,
  QUICK_QUOTE_ANALYSIS_SESSION_COLLECTION_ROUTE,
  QUICK_QUOTE_ANALYSIS_SESSION_ROUTE,
  registerIntelligenceRoutes,
  setIntelligenceNoStore,
} = require(
  "../server/intelligence/intelligenceRoutes"
);

const SESSION_ID =
  "20000000-0000-4000-8000-000000000201";

const IDEMPOTENCY_KEY =
  "40000000-0000-4000-8000-000000000201";

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
      layer.route?.path === path &&
      layer.route.methods?.[method]
  );
}

function createRegistrations() {
  const registrations = [];

  const app = {
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
    app,
    registrations,
  };
}

function findRegistration(
  registrations,
  method,
  path
) {
  const result =
    registrations.filter(
      (item) =>
        item.method === method &&
        item.path === path
    );

  assert.equal(
    result.length,
    1
  );

  return result[0];
}

test(
  "actual app mounts only the bounded private Job Analysis HTTP authority",
  () => {
    const expected = [
      [
        "post",
        QUICK_QUOTE_ANALYSIS_SESSION_COLLECTION_ROUTE,
      ],
      [
        "get",
        QUICK_QUOTE_ANALYSIS_SESSION_ROUTE,
      ],
      [
        "post",
        QUICK_QUOTE_ANALYSIS_EVIDENCE_ROUTE,
      ],
      [
        "delete",
        QUICK_QUOTE_ANALYSIS_SESSION_ROUTE,
      ],
    ];

    for (const [method, path] of expected) {
      const route =
        actualRoute(
          path,
          method
        );

      assert.ok(
        route,
        `${method.toUpperCase()} ${path} must be mounted`
      );

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

    const privateRoutes =
      app.router.stack.filter(
        (layer) =>
          typeof layer.route?.path ===
            "string" &&
          layer.route.path.startsWith(
            "/api/intelligence/quick-quote-analysis/"
          )
      );

    assert.equal(
      privateRoutes.some(
        (layer) =>
          layer.route.path.includes(
            "/turn"
          )
      ),
      false
    );
  }
);

test(
  "actual create route rejects unauthenticated browser access before database use",
  async () => {
    const route =
      actualRoute(
        QUICK_QUOTE_ANALYSIS_SESSION_COLLECTION_ROUTE,
        "post"
      );

    const databaseCalls = [];

    const req = {
      app: {
        locals: {
          pool: {
            query() {
              databaseCalls.push(
                "query"
              );
            },
          },
        },
      },

      headers: {
        "idempotency-key":
          IDEMPOTENCY_KEY,
      },

      body: {
        professionalInput:
          "Private evidence",
        photos: [],
      },
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
      res.body.code,
      "AUTHENTICATION_REQUIRED"
    );

    assert.equal(
      res.getHeader(
        "Cache-Control"
      ),
      "no-store"
    );

    assert.equal(
      databaseCalls.length,
      0
    );
  }
);

test(
  "create derives actor from authenticated middleware and rejects browser authority fields",
  async () => {
    const {
      app: fakeApp,
      registrations,
    } = createRegistrations();

    const calls = [];

    registerIntelligenceRoutes({
      app: fakeApp,

      authMiddleware(
        req,
        _res,
        next
      ) {
        req.user = {
          id: 73,
          role: "professional",
        };

        next();
      },

      getPool() {
        return {
          name:
            "analysis-route-pool",
        };
      },

      analysisSessionService: {
        async createSession(input) {
          calls.push(input);

          return {
            ok: true,
            status: 201,
            code:
              "QUICK_QUOTE_ANALYSIS_SESSION_CREATED",
            message: "Created.",
            session: {
              sessionId:
                SESSION_ID,
            },
            canonicalMutationPerformed:
              false,
          };
        },

        async appendEvidence() {
          throw new Error(
            "not used"
          );
        },

        async getSession() {
          throw new Error(
            "not used"
          );
        },

        async discardSession() {
          throw new Error(
            "not used"
          );
        },
      },
    });

    const route =
      findRegistration(
        registrations,
        "post",
        QUICK_QUOTE_ANALYSIS_SESSION_COLLECTION_ROUTE
      );

    const invalidReq = {
      headers: {
        "idempotency-key":
          IDEMPOTENCY_KEY,
      },

      body: {
        professionalInput:
          "Private evidence",
        photos: [],
        actorUserId: 999,
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
      invalidRes.body.code,
      "QUICK_QUOTE_ANALYSIS_REQUEST_INVALID"
    );

    assert.equal(
      calls.length,
      0
    );

    const validReq = {
      headers: {
        "idempotency-key":
          IDEMPOTENCY_KEY,
      },

      body: {
        professionalInput:
          "Private evidence",
        photos: [],
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
      validRes.body
        .canonicalMutationPerformed,
      false
    );

    assert.equal(
      validRes.getHeader(
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
      calls[0]
        .idempotencyKey,
      IDEMPOTENCY_KEY
    );

    assert.equal(
      calls[0]
        .professionalInput,
      "Private evidence"
    );

    assert.deepEqual(
      calls[0].photos,
      []
    );

    assert.equal(
      Object.hasOwn(
        calls[0],
        "actorUserId"
      ),
      false
    );

    assert.equal(
      Object.hasOwn(
        calls[0],
        "authorityScope"
      ),
      false
    );
  }
);

test(
  "read route is owner-authenticated and receives session identity only from the path",
  async () => {
    const {
      app: fakeApp,
      registrations,
    } = createRegistrations();

    const calls = [];

    registerIntelligenceRoutes({
      app: fakeApp,

      authMiddleware(
        req,
        _res,
        next
      ) {
        req.user = {
          id: 73,
          role: "professional",
        };

        next();
      },

      getPool() {
        return {
          name:
            "analysis-read-pool",
        };
      },

      analysisSessionService: {
        async createSession() {
          throw new Error(
            "not used"
          );
        },

        async appendEvidence() {
          throw new Error(
            "not used"
          );
        },

        async getSession(input) {
          calls.push(input);

          return {
            ok: true,
            status: 200,
            code:
              "QUICK_QUOTE_ANALYSIS_SESSION_LOADED",
            message: "Loaded.",
            session: {
              sessionId:
                input.sessionId,
            },
            canonicalMutationPerformed:
              false,
          };
        },

        async discardSession() {
          throw new Error(
            "not used"
          );
        },
      },
    });

    const route =
      findRegistration(
        registrations,
        "get",
        QUICK_QUOTE_ANALYSIS_SESSION_ROUTE
      );

    const req = {
      params: {
        sessionId:
          SESSION_ID,
      },

      headers: {},

      body: undefined,
    };

    const res = response();

    await runHandlers(
      route.handlers,
      req,
      res
    );

    assert.equal(
      res.statusCode,
      200
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

    assert.equal(
      Object.hasOwn(
        calls[0],
        "idempotencyKey"
      ),
      false
    );
  }
);

test(
  "evidence route preserves header idempotency and rejects browser turn or authority fields",
  async () => {
    const {
      app: fakeApp,
      registrations,
    } = createRegistrations();

    const calls = [];

    registerIntelligenceRoutes({
      app: fakeApp,

      authMiddleware(
        req,
        _res,
        next
      ) {
        req.user = {
          id: 73,
          role: "professional",
        };

        next();
      },

      getPool() {
        return {
          name:
            "analysis-evidence-pool",
        };
      },

      analysisSessionService: {
        async createSession() {
          throw new Error(
            "not used"
          );
        },

        async appendEvidence(input) {
          calls.push(input);

          return {
            ok: true,
            status: 201,
            code:
              "QUICK_QUOTE_ANALYSIS_EVIDENCE_APPENDED",
            message: "Recorded.",
            evidence: {
              version: 2,
            },
            canonicalMutationPerformed:
              false,
          };
        },

        async getSession() {
          throw new Error(
            "not used"
          );
        },

        async discardSession() {
          throw new Error(
            "not used"
          );
        },
      },
    });

    const route =
      findRegistration(
        registrations,
        "post",
        QUICK_QUOTE_ANALYSIS_EVIDENCE_ROUTE
      );

    for (const forbidden of [
      {
        authorityScope:
          "user:999",
      },
      {
        role: "MEETRO",
      },
      {
        turnPayload: {
          summary:
            "browser-authored AI turn",
        },
      },
      {
        evidenceVersion: 99,
      },
    ]) {
      const req = {
        params: {
          sessionId:
            SESSION_ID,
        },

        headers: {
          "idempotency-key":
            IDEMPOTENCY_KEY,
        },

        body: {
          professionalInput:
            "Updated evidence",
          photos: [],
          ...forbidden,
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
        400
      );

      assert.equal(
        res.body.code,
        "QUICK_QUOTE_ANALYSIS_REQUEST_INVALID"
      );
    }

    assert.equal(
      calls.length,
      0
    );

    const req = {
      params: {
        sessionId:
          SESSION_ID,
      },

      headers: {
        "idempotency-key":
          IDEMPOTENCY_KEY,
      },

      body: {
        professionalInput:
          "Updated evidence",
        photos: [],
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

    assert.equal(
      calls[0].sessionId,
      SESSION_ID
    );

    assert.equal(
      calls[0]
        .authenticatedActor.id,
      73
    );

    assert.equal(
      calls[0]
        .idempotencyKey,
      IDEMPOTENCY_KEY
    );
  }
);

test(
  "discard is bodyless, owner-authenticated, idempotent at the header boundary",
  async () => {
    const {
      app: fakeApp,
      registrations,
    } = createRegistrations();

    const calls = [];

    registerIntelligenceRoutes({
      app: fakeApp,

      authMiddleware(
        req,
        _res,
        next
      ) {
        req.user = {
          id: 73,
          role: "professional",
        };

        next();
      },

      getPool() {
        return {
          name:
            "analysis-discard-pool",
        };
      },

      analysisSessionService: {
        async createSession() {
          throw new Error(
            "not used"
          );
        },

        async appendEvidence() {
          throw new Error(
            "not used"
          );
        },

        async getSession() {
          throw new Error(
            "not used"
          );
        },

        async discardSession(input) {
          calls.push(input);

          return {
            ok: true,
            status: 200,
            code:
              "QUICK_QUOTE_ANALYSIS_SESSION_DISCARDED",
            message: "Discarded.",
            sessionId:
              input.sessionId,
            discarded: true,
            canonicalMutationPerformed:
              false,
          };
        },
      },
    });

    const route =
      findRegistration(
        registrations,
        "delete",
        QUICK_QUOTE_ANALYSIS_SESSION_ROUTE
      );

    const invalidReq = {
      params: {
        sessionId:
          SESSION_ID,
      },

      headers: {
        "idempotency-key":
          IDEMPOTENCY_KEY,
      },

      body: {
        role: "MEETRO",
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

    const req = {
      params: {
        sessionId:
          SESSION_ID,
      },

      headers: {
        "idempotency-key":
          IDEMPOTENCY_KEY,
      },

      body: {},
    };

    const res = response();

    await runHandlers(
      route.handlers,
      req,
      res
    );

    assert.equal(
      res.statusCode,
      200
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

    assert.equal(
      calls[0]
        .idempotencyKey,
      IDEMPOTENCY_KEY
    );

    assert.equal(
      res.body
        .canonicalMutationPerformed,
      false
    );
  }
);

test(
  "HTTP boundary exposes no arbitrary turn-writing route or appendTurn service call",
  () => {
    const source =
      readFileSync(
        join(
          __dirname,
          "..",
          "server",
          "intelligence",
          "intelligenceRoutes.js"
        ),
        "utf8"
      );

    assert.doesNotMatch(
      source,
      /analysisSessionService\s*\.\s*appendTurn\s*\(/
    );

    assert.doesNotMatch(
      source,
      /QUICK_QUOTE_ANALYSIS_(?:TURN|TURNS)_ROUTE/
    );

    const quickQuoteRoutePaths =
      app.router.stack
        .map(
          (layer) =>
            layer.route?.path
        )
        .filter(
          (path) =>
            typeof path ===
              "string" &&
            path.startsWith(
              "/api/intelligence/quick-quote-analysis/"
            )
        );

    assert.equal(
      quickQuoteRoutePaths.some(
        (path) =>
          /\/turns?(?:\/|$)/.test(
            path
          )
      ),
      false
    );
  }
);
