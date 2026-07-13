"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "explicit-test-jwt-secret-for-ownership-tests";

const {
  app,
  buildOwnedContractorProjectCreateQuery,
  buildOwnedContractorProjectUpdateQuery,
  buildQuoteRequestParticipantQuery,
  createToken,
  receiverBelongsToQuoteRequest,
} = require("../index");

function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, " ").trim();
}

function createFakePool({ quoteRows = [], projectRows = [] } = {}) {
  const calls = [];

  return {
    calls,
    async query(text, values = []) {
      const normalized = normalizeSql(text);
      calls.push({ text: normalized, values });

      if (
        normalized.includes("SELECT id, email, role, token_version") &&
        normalized.includes("FROM users")
      ) {
        return {
          rows: [{
            id: values[0],
            email: `account-${values[0]}@example.test`,
            role: "homeowner",
            token_version: 0,
          }],
        };
      }

      if (
        normalized.includes("FROM quote_requests") &&
        normalized.includes("JOIN contractor_profiles")
      ) {
        return { rows: quoteRows };
      }

      if (normalized.includes("SELECT messages.")) {
        return {
          rows: [
            {
              id: 301,
              quote_request_id: values[0],
              message_text: "A-only staging trust message",
            },
          ],
        };
      }

      if (normalized.includes("INSERT INTO messages")) {
        return {
          rows: [
            {
              id: 302,
              quote_request_id: values[0],
              sender_id: values[1],
              message_text: values[3],
            },
          ],
        };
      }

      if (normalized.includes("CREATE TABLE IF NOT EXISTS workflow_events")) {
        return { rows: [] };
      }

      if (normalized.includes("SELECT workflow_events.")) {
        return {
          rows: [
            {
              id: 401,
              quote_request_id: values[0],
              workflow_type: "staging_trust",
            },
          ],
        };
      }

      if (normalized.includes("INSERT INTO workflow_events")) {
        return {
          rows: [
            {
              id: 402,
              quote_request_id: values[0],
              user_id: values[1],
              workflow_type: values[2],
            },
          ],
        };
      }

      if (
        normalized.includes("UPDATE contractor_projects") ||
        normalized.includes("INSERT INTO contractor_projects")
      ) {
        return { rows: projectRows };
      }

      throw new Error(`Unexpected query in ownership test: ${normalized}`);
    },
  };
}

function getRouteHandlers(method, routePath) {
  const layer = app.router.stack.find(
    (item) => item.route?.path === routePath && item.route.methods[method]
  );

  assert.ok(layer, `Route not found: ${method.toUpperCase()} ${routePath}`);

  return layer.route.stack.map((item) => item.handle);
}

function createMockResponse() {
  return {
    statusCode: 200,
    body: null,
    finished: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      this.finished = true;
      return this;
    },
    setHeader() {},
    getHeader() {
      return undefined;
    },
  };
}

async function invokeRoute(method, routePath, { pool, token, body, params = {} }) {
  app.locals.pool = pool;
  const req = {
    app,
    body: body || {},
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    method: method.toUpperCase(),
    params,
  };
  const res = createMockResponse();
  const handlers = getRouteHandlers(method, routePath);

  try {
    for (const handler of handlers) {
      if (res.finished) break;

      if (handler.length >= 3) {
        await new Promise((resolve, reject) => {
          handler(req, res, (error) => (error ? reject(error) : resolve()));
        });
      } else {
        await handler(req, res);
      }
    }

    return {
      status: res.statusCode,
      json: res.body,
    };
  } finally {
    delete app.locals.pool;
  }
}

function tokenFor(id) {
  return createToken({
    id,
    email: `account-${id}@example.test`,
    role: "homeowner",
  });
}

test("quote thread authorization is scoped to homeowner or contractor owner", () => {
  const query = buildQuoteRequestParticipantQuery(101, 202);

  assert.match(query.text, /quote_requests\.homeowner_id = \$2/);
  assert.match(query.text, /contractor_profiles\.user_id = \$2/);
  assert.deepEqual(query.values, [101, 202]);

  assert.equal(
    receiverBelongsToQuoteRequest(
      { homeowner_id: 1, contractor_user_id: 2 },
      2
    ),
    true
  );
  assert.equal(
    receiverBelongsToQuoteRequest(
      { homeowner_id: 1, contractor_user_id: 2 },
      3
    ),
    false
  );
});

test("Account B cannot read Account A-only message thread", async () => {
  const pool = createFakePool({ quoteRows: [] });

  const result = await invokeRoute("get", "/messages/:quoteRequestId", {
    pool,
    token: tokenFor(2),
    params: { quoteRequestId: 1001 },
  });

  assert.equal(result.status, 404);
  assert.equal(
    pool.calls.some((call) => call.text.includes("SELECT messages.")),
    false
  );
});

test("Account B cannot write to Account A-only message thread", async () => {
  const pool = createFakePool({ quoteRows: [] });

  const result = await invokeRoute("post", "/messages", {
    pool,
    token: tokenFor(2),
    body: {
      quote_request_id: 1001,
      receiver_id: 1,
      message_text: "B unauthorized staging trust message",
    },
  });

  assert.equal(result.status, 404);
  assert.equal(
    pool.calls.some((call) => call.text.includes("INSERT INTO messages")),
    false
  );
});

test("Account B cannot read Account A-only workflow events", async () => {
  const pool = createFakePool({ quoteRows: [] });

  const result = await invokeRoute("get", "/workflow-events/:quoteRequestId", {
    pool,
    token: tokenFor(2),
    params: { quoteRequestId: 1001 },
  });

  assert.equal(result.status, 404);
  assert.equal(
    pool.calls.some((call) => call.text.includes("SELECT workflow_events.")),
    false
  );
});

test("Account B cannot write workflow events into Account A-only quote request", async () => {
  const pool = createFakePool({ quoteRows: [] });

  const result = await invokeRoute("post", "/workflow-events", {
    pool,
    token: tokenFor(2),
    body: {
      quote_request_id: 1001,
      workflow_type: "staging_trust",
      workflow_status: "unauthorized",
    },
  });

  assert.equal(result.status, 404);
  assert.equal(
    pool.calls.some((call) => call.text.includes("INSERT INTO workflow_events")),
    false
  );
});

test("Account B cannot update Account A contractor project", async () => {
  const pool = createFakePool({ projectRows: [] });

  const result = await invokeRoute("put", "/contractor-projects/:id", {
    pool,
    token: tokenFor(2),
    params: { id: 7001 },
    body: {
      title: "Unauthorized update",
      description: "This should be rejected.",
      image_urls: [],
    },
  });

  assert.equal(result.status, 404);
  const projectUpdateCall = pool.calls.find((call) =>
    call.text.includes("UPDATE contractor_projects")
  );
  assert.ok(projectUpdateCall);
  assert.match(projectUpdateCall.text, /contractor_profiles\.user_id = \$6/);
});

test("contractor project create and update queries require contractor profile ownership", () => {
  const create = buildOwnedContractorProjectCreateQuery({
    contractorId: 10,
    ownerUserId: 20,
    title: "Project",
    description: "Scoped project",
    imageUrl: "",
    imageUrls: [],
  });
  const update = buildOwnedContractorProjectUpdateQuery({
    projectId: 30,
    ownerUserId: 20,
    title: "Project",
    description: "Scoped project",
    imageUrl: "",
    imageUrls: [],
  });

  assert.match(create.text, /contractor_profiles\.user_id = \$6/);
  assert.match(update.text, /contractor_profiles\.user_id = \$6/);
  assert.equal(create.values[5], 20);
  assert.equal(update.values[5], 20);
});
