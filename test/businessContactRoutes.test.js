"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createBusinessContactHandlers,
  registerBusinessContactRoutes,
} = require("../server/contacts/businessContacts");

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

test("authenticated Contact handlers pass only governed actor, identity, query, payload, and idempotency", async () => {
  const calls = [];
  const contactService = {
    async createBusinessContact(input) { calls.push(["create", input]); return { ok: true, status: 201, code: "CREATED", contact: { id: "contact" }, duplicateCandidates: [] }; },
    async getBusinessContact(input) { calls.push(["get", input]); return { ok: true, status: 200, code: "LOADED", contact: { id: "contact" } }; },
    async listBusinessContacts(input) { calls.push(["list", input]); return { ok: true, status: 200, code: "LISTED", contacts: [] }; },
    async updateBusinessContact(input) { calls.push(["update", input]); return { ok: false, status: 409, code: "BUSINESS_CONTACT_VERSION_CONFLICT", currentVersion: 3 }; },
    async assignBusinessContactRole(input) { calls.push(["assign", input]); return { ok: true, status: 201, code: "ASSIGNED", contact: {} }; },
    async endBusinessContactRole(input) { calls.push(["end", input]); return { ok: true, status: 200, code: "ENDED", contact: {} }; },
    async archiveBusinessContact(input) { calls.push(["archive", input]); return { ok: true, status: 200, code: "ARCHIVED", contact: {} }; },
  };
  const pool = { marker: true };
  const handlers = createBusinessContactHandlers({
    getPool: () => pool,
    sendPublicDatabaseError() { throw new Error("unexpected"); },
    contactService,
  });
  const request = {
    user: { id: 7 },
    body: { expectedVersion: 2 },
    params: { contactId: "contact-id", roleId: "role-id" },
    query: { contractorProfileId: "10", search: "Jack", status: "ALL", role: "CUSTOMER", limit: "20" },
    headers: { "idempotency-key": "command-key" },
  };
  for (const name of ["create", "get", "list", "update", "assignRole", "endRole", "archive"]) {
    await handlers[name](request, response());
  }
  assert.deepEqual(calls[0][1], {
    pool,
    authenticatedActor: request.user,
    payload: request.body,
    idempotencyKey: "command-key",
  });
  assert.equal(calls[1][1].contactId, "contact-id");
  assert.deepEqual(calls[2][1].query, request.query);
  assert.equal(calls[3][1].idempotencyKey, "command-key");
  assert.equal(calls[5][1].roleId, "role-id");
  assert.equal(calls[6][1].payload, request.body);
});

test("Contact responses are private, expose duplicate candidates, and preserve governed failures", async () => {
  const handlers = createBusinessContactHandlers({
    getPool: () => ({}),
    sendPublicDatabaseError() { throw new Error("unexpected"); },
    contactService: {
      async createBusinessContact() {
        return { ok: true, status: 201, code: "BUSINESS_CONTACT_CREATED", contact: { id: "one" }, duplicateCandidates: [{ id: "two" }] };
      },
      async updateBusinessContact() {
        return { ok: false, status: 409, code: "BUSINESS_CONTACT_VERSION_CONFLICT", message: "newer", currentVersion: 4 };
      },
    },
  });
  const created = response();
  await handlers.create({ user: { id: 1 }, body: {}, headers: {} }, created);
  assert.equal(created.statusCode, 201);
  assert.equal(created.headers["Cache-Control"], "private, no-store");
  assert.deepEqual(created.body.duplicateCandidates, [{ id: "two" }]);
  const conflict = response();
  await handlers.update({ user: { id: 1 }, body: {}, params: {}, headers: {} }, conflict);
  assert.deepEqual(conflict.body, {
    success: false,
    code: "BUSINESS_CONTACT_VERSION_CONFLICT",
    message: "newer",
    currentVersion: 4,
  });
});

test("registers only authenticated professional Contact routes and no delete endpoint", () => {
  const routes = [];
  const app = {
    post(path, ...handlers) { routes.push(["POST", path, handlers.length]); },
    get(path, ...handlers) { routes.push(["GET", path, handlers.length]); },
    patch(path, ...handlers) { routes.push(["PATCH", path, handlers.length]); },
  };
  registerBusinessContactRoutes({
    app,
    authMiddleware() {},
    getPool() {},
    sendPublicDatabaseError() {},
    contactService: {},
  });
  assert.deepEqual(routes, [
    ["POST", "/business-contacts", 2],
    ["GET", "/business-contacts", 2],
    ["GET", "/business-contacts/:contactId", 2],
    ["PATCH", "/business-contacts/:contactId", 2],
    ["POST", "/business-contacts/:contactId/roles", 2],
    ["POST", "/business-contacts/:contactId/roles/:roleId/end", 2],
    ["POST", "/business-contacts/:contactId/archive", 2],
  ]);
  assert.equal(routes.some(([method]) => method === "DELETE"), false);
});
