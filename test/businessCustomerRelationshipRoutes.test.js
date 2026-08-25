"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const {
  createBusinessCustomerRelationshipHandlers,
  registerBusinessCustomerRelationshipRoutes,
} = require("../server/relationships/businessCustomerRelationships");

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

test("authenticated handlers pass only governed actor, identity, query, payload, and idempotency", async () => {
  const calls = [];
  const relationshipService = {
    async establishBusinessCustomerRelationship(input) {
      calls.push(["establish", input]);
      return { ok: true, status: 201, code: "ESTABLISHED", relationship: { id: "relationship" } };
    },
    async listBusinessCustomerRelationships(input) {
      calls.push(["list", input]);
      return { ok: true, status: 200, code: "LISTED", relationships: [] };
    },
    async getBusinessCustomerRelationshipByContact(input) {
      calls.push(["byContact", input]);
      return { ok: true, status: 200, code: "LOADED", relationship: { id: "relationship" } };
    },
    async getBusinessCustomerRelationshipActivity(input) {
      calls.push(["activity", input]);
      return { ok: true, status: 200, code: "ACTIVITY", activity: { work: [], quotes: [], invoices: [] } };
    },
    async getBusinessCustomerRelationship(input) {
      calls.push(["get", input]);
      return { ok: true, status: 200, code: "LOADED", relationship: { id: "relationship" } };
    },
  };
  const pool = { marker: true };
  const handlers = createBusinessCustomerRelationshipHandlers({
    getPool: () => pool,
    sendPublicDatabaseError() { throw new Error("unexpected"); },
    relationshipService,
  });
  const request = {
    user: { id: 7 },
    body: { contractorProfileId: 10, businessContactId: "contact-id" },
    params: { relationshipId: "relationship-id", businessContactId: "contact-id" },
    query: { contractorProfileId: "10", limit: "20" },
    headers: { "idempotency-key": "command-key" },
  };
  for (const name of ["establish", "list", "getByContact", "getActivity", "get"]) {
    await handlers[name](request, response());
  }
  assert.deepEqual(calls[0][1], {
    pool,
    authenticatedActor: request.user,
    payload: request.body,
    idempotencyKey: "command-key",
  });
  assert.deepEqual(calls[1][1].query, request.query);
  assert.equal(calls[2][1].businessContactId, "contact-id");
  assert.equal(calls[3][1].relationshipId, "relationship-id");
  assert.equal(calls[4][1].relationshipId, "relationship-id");
});

test("Customer Relationship responses remain private and preserve governed failures", async () => {
  const handlers = createBusinessCustomerRelationshipHandlers({
    getPool: () => ({}),
    sendPublicDatabaseError() { throw new Error("unexpected"); },
    relationshipService: {
      async establishBusinessCustomerRelationship() {
        return {
          ok: true,
          status: 201,
          code: "BUSINESS_CUSTOMER_RELATIONSHIP_ESTABLISHED",
          relationship: { id: "one" },
          replayed: true,
        };
      },
      async getBusinessCustomerRelationship() {
        return {
          ok: false,
          status: 404,
          code: "BUSINESS_CUSTOMER_RELATIONSHIP_NOT_FOUND",
          message: "not found",
        };
      },
      async getBusinessCustomerRelationshipActivity() {
        return {
          ok: true,
          status: 200,
          code: "BUSINESS_CUSTOMER_RELATIONSHIP_ACTIVITY_LOADED",
          activity: { work: [], quotes: [], invoices: [] },
        };
      },
    },
  });
  const created = response();
  await handlers.establish({ user: { id: 1 }, body: {}, headers: {} }, created);
  assert.equal(created.statusCode, 201);
  assert.equal(created.headers["Cache-Control"], "private, no-store");
  assert.equal(created.body.replayed, true);
  const missing = response();
  await handlers.get({ user: { id: 1 }, params: {} }, missing);
  assert.deepEqual(missing.body, {
    success: false,
    code: "BUSINESS_CUSTOMER_RELATIONSHIP_NOT_FOUND",
    message: "not found",
  });
  const activity = response();
  await handlers.getActivity({ user: { id: 1 }, params: {} }, activity);
  assert.deepEqual(activity.body.activity, { work: [], quotes: [], invoices: [] });
});

test("registers only authenticated establish and owner-scoped read routes", () => {
  const routes = [];
  const app = {
    post(path, ...handlers) { routes.push(["POST", path, handlers.length]); },
    get(path, ...handlers) { routes.push(["GET", path, handlers.length]); },
    patch(path, ...handlers) { routes.push(["PATCH", path, handlers.length]); },
    delete(path, ...handlers) { routes.push(["DELETE", path, handlers.length]); },
  };
  registerBusinessCustomerRelationshipRoutes({
    app,
    authMiddleware() {},
    getPool() {},
    sendPublicDatabaseError() {},
    relationshipService: {},
  });
  assert.deepEqual(routes, [
    ["POST", "/business-customer-relationships", 2],
    ["GET", "/business-customer-relationships", 2],
    ["GET", "/business-customer-relationships/by-contact/:businessContactId", 2],
    ["GET", "/business-customer-relationships/:relationshipId/activity", 2],
    ["GET", "/business-customer-relationships/:relationshipId", 2],
  ]);
  assert.equal(routes.some(([method]) => method === "PATCH" || method === "DELETE"), false);
});

test("server application registers the bounded Customer Relationship routes", () => {
  const source = readFileSync(join(__dirname, "..", "index.js"), "utf8");
  assert.match(source, /registerBusinessCustomerRelationshipRoutes/);
  assert.match(source, /\.\/server\/relationships\/businessCustomerRelationships/);
});
