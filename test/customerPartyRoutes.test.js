"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const {
  createCustomerPartyHandlers,
  registerCustomerPartyRoutes,
} = require("../server/relationships/customerParties");

function response() {
  return {
    statusCode: 0,
    body: null,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
  };
}

test("authenticated Job customer-party handlers forward only governed identity inputs", async () => {
  const calls = [];
  const pool = { marker: true };
  const service = {
    async linkJobCustomerParty(input) {
      calls.push(["link", input]);
      return { ok: true, status: 201, code: "LINKED", customerParty: { businessContactId: "contact" } };
    },
    async getJobCustomerParty(input) {
      calls.push(["get", input]);
      return { ok: true, status: 200, code: "FOUND", customerParty: { businessContactId: "contact" } };
    },
  };
  const handlers = createCustomerPartyHandlers({
    getPool: () => pool,
    sendPublicDatabaseError() { throw new Error("unexpected"); },
    customerPartyService: service,
  });
  const request = {
    user: { id: 7 },
    params: { jobId: "job" },
    body: { businessContactId: "contact", customerRelationshipId: "relationship" },
    headers: { "idempotency-key": "command" },
  };
  const linked = response();
  await handlers.linkJob(request, linked);
  await handlers.getJob(request, response());
  assert.deepEqual(calls[0][1], {
    pool,
    authenticatedActor: request.user,
    jobId: "job",
    payload: request.body,
    idempotencyKey: "command",
  });
  assert.deepEqual(calls[1][1], {
    pool,
    authenticatedActor: request.user,
    jobId: "job",
  });
  assert.equal(linked.headers["Cache-Control"], "private, no-store");
});

test("registers only authenticated explicit link and owner-scoped read routes", () => {
  const routes = [];
  const app = {
    post(path, ...handlers) { routes.push(["POST", path, handlers.length]); },
    get(path, ...handlers) { routes.push(["GET", path, handlers.length]); },
    patch(path, ...handlers) { routes.push(["PATCH", path, handlers.length]); },
    delete(path, ...handlers) { routes.push(["DELETE", path, handlers.length]); },
  };
  registerCustomerPartyRoutes({
    app,
    authMiddleware() {},
    getPool() {},
    sendPublicDatabaseError() {},
    customerPartyService: {},
  });
  assert.deepEqual(routes, [
    ["POST", "/jobs/:jobId/customer-party", 2],
    ["GET", "/jobs/:jobId/customer-party", 2],
  ]);
});

test("server application registers the bounded customer-party routes", () => {
  const source = readFileSync(join(__dirname, "..", "index.js"), "utf8");
  assert.match(source, /registerCustomerPartyRoutes/);
  assert.match(source, /\.\/server\/relationships\/customerParties/);
});
