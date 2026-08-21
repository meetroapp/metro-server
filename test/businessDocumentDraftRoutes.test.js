"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createBusinessDocumentDraftHandlers,
  registerBusinessDocumentDraftRoutes,
} = require("../server/documents/businessDocumentDrafts");

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

test("routes pass only authenticated actor, governed payload, version, and idempotency", async () => {
  const calls = [];
  const draftService = {
    async createBusinessDocumentDraft(input) { calls.push(["create", input]); return { ok: true, status: 201, code: "CREATED", document: { id: "draft" } }; },
    async updateBusinessDocumentDraft(input) { calls.push(["update", input]); return { ok: false, status: 409, code: "BUSINESS_DOCUMENT_VERSION_CONFLICT", message: "conflict", currentVersion: 2 }; },
    async deleteBusinessDocumentDraft(input) { calls.push(["delete", input]); return { ok: true, status: 200, code: "BUSINESS_DOCUMENT_DRAFT_DELETED", deletedDraftId: "draft-id" }; },
    async getBusinessDocumentDraft(input) { calls.push(["get", input]); return { ok: true, status: 200, code: "LOADED", document: { id: "draft" } }; },
    async listBusinessDocumentDrafts(input) { calls.push(["list", input]); return { ok: true, status: 200, code: "LISTED", documents: [] }; },
  };
  const deliveryService = {
    async deliverBusinessDocument(input) { calls.push(["deliver", input]); return { ok: true, status: 202, code: "DELIVERY_REQUESTED", delivery: { id: "delivery" } }; },
    async listBusinessDocumentDeliveries(input) { calls.push(["deliveries", input]); return { ok: true, status: 200, code: "DELIVERIES", deliveries: [] }; },
  };
  const handlers = createBusinessDocumentDraftHandlers({
    getPool: () => ({ pool: true }),
    sendPublicDatabaseError: () => { throw new Error("unexpected"); },
    draftService,
    deliveryService,
    emailDelivery: { providerName: "test" },
    env: { marker: true },
  });
  const req = { user: { id: 7 }, body: { content: {} }, params: { draftId: "draft-id" }, query: { search: "Jack" }, headers: { "idempotency-key": "key" } };
  const createRes = response();
  await handlers.create(req, createRes);
  assert.equal(createRes.statusCode, 201);
  assert.equal(createRes.headers["Cache-Control"], "private, no-store");
  const updateRes = response();
  await handlers.update(req, updateRes);
  assert.equal(updateRes.statusCode, 409);
  assert.equal(updateRes.body.currentVersion, 2);
  await handlers.get(req, response());
  await handlers.list(req, response());
  const deleteRes = response();
  await handlers.delete({ ...req, body: { expectedVersion: 3 } }, deleteRes);
  assert.equal(calls[0][1].authenticatedActor, req.user);
  assert.equal(calls[0][1].idempotencyKey, "key");
  assert.equal(calls[1][1].draftId, "draft-id");
  assert.deepEqual(calls[3][1].query, { search: "Jack", type: undefined, status: undefined, time: undefined });
  assert.equal(calls[4][1].expectedVersion, 3);
  assert.equal(deleteRes.body.deletedDraftId, "draft-id");
  await handlers.deliver({ ...req, body: { expectedVersion: 3, channel: "EMAIL", recipientEmail: "jack@example.test" }, app: { locals: {} } }, response());
  await handlers.deliveries(req, response());
  assert.equal(calls[5][1].emailDelivery.providerName, "test");
  assert.equal(calls[6][1].draftId, "draft-id");
});

test("route registration exposes authenticated create/list/get/update/delete endpoints", () => {
  const routes = [];
  const app = {
    post(path, ...handlers) { routes.push(["POST", path, handlers.length]); },
    get(path, ...handlers) { routes.push(["GET", path, handlers.length]); },
    patch(path, ...handlers) { routes.push(["PATCH", path, handlers.length]); },
    delete(path, ...handlers) { routes.push(["DELETE", path, handlers.length]); },
  };
  const draftService = {
    createBusinessDocumentDraft() {}, updateBusinessDocumentDraft() {}, deleteBusinessDocumentDraft() {},
    getBusinessDocumentDraft() {}, listBusinessDocumentDrafts() {},
  };
  const deliveryService = { deliverBusinessDocument() {}, listBusinessDocumentDeliveries() {} };
  registerBusinessDocumentDraftRoutes({ app, authMiddleware() {}, getPool() {}, sendPublicDatabaseError() {}, draftService, deliveryService });
  assert.deepEqual(routes, [
    ["POST", "/business-document-drafts", 2],
    ["GET", "/business-document-drafts", 2],
    ["GET", "/business-document-drafts/:draftId", 2],
    ["PATCH", "/business-document-drafts/:draftId", 2],
    ["DELETE", "/business-document-drafts/:draftId", 2],
    ["GET", "/business-document-drafts/:draftId/deliveries", 2],
    ["POST", "/business-document-drafts/:draftId/deliveries", 2],
  ]);
});
