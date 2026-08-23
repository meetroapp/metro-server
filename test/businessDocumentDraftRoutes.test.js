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
    send(value) { this.body = value; return this; },
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
    async getBusinessDocumentCustomerPdf(input) { calls.push(["customerPdf", input]); return { ok: true, status: 200, code: "PDF", pdf: { buffer: Buffer.from("%PDF"), filename: "quote-WQ-1-v3.pdf" } }; },
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
  const pdfRes = response();
  await handlers.customerPdf({ ...req, query: { version: "3" } }, pdfRes);
  assert.equal(pdfRes.statusCode, 200);
  assert.equal(pdfRes.headers["Content-Type"], "application/pdf");
  assert.equal(pdfRes.headers["Content-Disposition"], "inline; filename=\"quote-WQ-1-v3.pdf\"");
  assert.equal(calls[7][1].expectedVersion, "3");
});

test("route registration preserves draft/delivery routes and adds authenticated numbering endpoints", () => {
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
  const deliveryService = { deliverBusinessDocument() {}, listBusinessDocumentDeliveries() {}, getBusinessDocumentCustomerPdf() {} };
  registerBusinessDocumentDraftRoutes({ app, authMiddleware() {}, getPool() {}, sendPublicDatabaseError() {}, draftService, deliveryService });
  assert.deepEqual(routes, [
    ["GET", "/business-document-numbering", 2],
    ["POST", "/business-document-numbering", 2],
    ["POST", "/business-document-drafts", 2],
    ["GET", "/business-document-drafts", 2],
    ["GET", "/business-document-drafts/:draftId", 2],
    ["GET", "/business-document-drafts/:draftId/customer-pdf", 2],
    ["PATCH", "/business-document-drafts/:draftId", 2],
    ["DELETE", "/business-document-drafts/:draftId", 2],
    ["GET", "/business-document-drafts/:draftId/deliveries", 2],
    ["POST", "/business-document-drafts/:draftId/deliveries", 2],
  ]);
});

test("numbering GET/POST handlers pass governed inputs and serialize private numbering state and errors", async () => {
  const calls = [];
  const numberingService = {
    async getBusinessDocumentNumbering(input) {
      calls.push(["getNumbering", input]);
      if (input.query.documentType === "BAD") {
        return {
          ok: false,
          status: 409,
          code: "BUSINESS_DOCUMENT_PROFILE_AMBIGUOUS",
          message: "Select a Job to identify the business.",
        };
      }
      return {
        ok: true,
        status: 200,
        code: "BUSINESS_DOCUMENT_NUMBERING_LOADED",
        numbering: {
          initialized: true,
          documentType: input.query.documentType,
          prefix: "Q",
          width: 7,
          lastNumber: 0,
          nextNumberPreview: "Q-0000001",
          initializationMode: "START_NEW",
        },
      };
    },
    async initializeBusinessDocumentNumbering(input) {
      calls.push(["initializeNumbering", input]);
      const continued = input.payload.mode === "CONTINUE_EXISTING";
      return {
        ok: true,
        status: 201,
        code: "BUSINESS_DOCUMENT_NUMBERING_INITIALIZED",
        numbering: {
          initialized: true,
          documentType: input.payload.documentType,
          prefix: continued ? "BG" : "INV",
          width: 7,
          lastNumber: continued ? 1019 : 0,
          nextNumberPreview: continued ? "BG-0001020" : "INV-0000001",
          initializationMode: input.payload.mode,
        },
      };
    },
  };
  const pool = { pool: true };
  const handlers = createBusinessDocumentDraftHandlers({
    getPool: () => pool,
    sendPublicDatabaseError: () => { throw new Error("unexpected"); },
    numberingService,
  });
  const actor = { id: 7 };
  const jobId = "11111111-1111-4111-8111-111111111111";
  const getResponse = response();
  await handlers.numbering({
    user: actor,
    query: { documentType: "QUOTE", jobId },
  }, getResponse);
  assert.equal(getResponse.statusCode, 200);
  assert.equal(getResponse.headers["Cache-Control"], "private, no-store");
  assert.equal(getResponse.body.success, true);
  assert.equal(getResponse.body.numbering.nextNumberPreview, "Q-0000001");
  assert.deepEqual(calls[0][1], {
    pool,
    authenticatedActor: actor,
    query: { documentType: "QUOTE", jobId },
  });

  const startNewBody = {
    documentType: "INVOICE",
    jobId: null,
    mode: "START_NEW",
  };
  const startNewResponse = response();
  await handlers.initializeNumbering({ user: actor, body: startNewBody }, startNewResponse);
  assert.strictEqual(calls[1][1].payload, startNewBody);
  assert.equal(startNewResponse.statusCode, 201);
  assert.equal(startNewResponse.headers["Cache-Control"], "private, no-store");
  assert.equal(startNewResponse.body.numbering.nextNumberPreview, "INV-0000001");

  const continueBody = {
    documentType: "QUOTE",
    jobId: null,
    mode: "CONTINUE_EXISTING",
    previousDocumentNumber: "BG-0001019",
  };
  const continueResponse = response();
  await handlers.initializeNumbering({ user: actor, body: continueBody }, continueResponse);
  assert.strictEqual(calls[2][1].payload, continueBody);
  assert.equal(continueResponse.body.numbering.prefix, "BG");
  assert.equal(continueResponse.body.numbering.nextNumberPreview, "BG-0001020");

  const errorResponse = response();
  await handlers.numbering({
    user: actor,
    query: { documentType: "BAD" },
  }, errorResponse);
  assert.equal(errorResponse.statusCode, 409);
  assert.deepEqual(errorResponse.body, {
    success: false,
    code: "BUSINESS_DOCUMENT_PROFILE_AMBIGUOUS",
    message: "Select a Job to identify the business.",
  });
  assert.equal(errorResponse.headers["Cache-Control"], "private, no-store");
});
