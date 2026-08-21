"use strict";

const service = require("./businessDocumentDraftService");

function sendResult(res, result) {
  const status = result?.status || 500;
  const payload = {
    success: result?.ok === true,
    code: result?.code || "BUSINESS_DOCUMENT_FAILED",
  };
  if (result?.message) payload.message = result.message;
  if (result?.document !== undefined) payload.document = result.document;
  if (result?.documents !== undefined) payload.documents = result.documents;
  if (result?.deletedDraftId !== undefined) payload.deletedDraftId = result.deletedDraftId;
  if (result?.currentVersion !== undefined) payload.currentVersion = result.currentVersion;
  if (result?.replayed) payload.replayed = true;
  res.setHeader?.("Cache-Control", "private, no-store");
  return res.status(status).json(payload);
}

function createBusinessDocumentDraftHandlers({
  getPool,
  sendPublicDatabaseError,
  draftService = service,
  env = process.env,
} = {}) {
  if (typeof getPool !== "function") throw new TypeError("getPool must be a function.");
  if (typeof sendPublicDatabaseError !== "function") throw new TypeError("sendPublicDatabaseError must be a function.");

  function handle(operation, action) {
    return async (req, res) => {
      try {
        return sendResult(res, await action(req));
      } catch (error) {
        return sendPublicDatabaseError({
          res,
          error,
          operation,
          code: "BUSINESS_DOCUMENT_FAILED",
          message: "The working document operation could not be completed.",
        });
      }
    };
  }

  return {
    create: handle("create_business_document_draft", (req) =>
      draftService.createBusinessDocumentDraft({
        pool: getPool(req),
        authenticatedActor: req.user,
        payload: req.body,
        idempotencyKey: req.headers?.["idempotency-key"],
        env,
      })
    ),
    get: handle("get_business_document_draft", (req) =>
      draftService.getBusinessDocumentDraft({
        pool: getPool(req),
        authenticatedActor: req.user,
        draftId: req.params.draftId,
      })
    ),
    update: handle("update_business_document_draft", (req) =>
      draftService.updateBusinessDocumentDraft({
        pool: getPool(req),
        authenticatedActor: req.user,
        draftId: req.params.draftId,
        payload: req.body,
        idempotencyKey: req.headers?.["idempotency-key"],
        env,
      })
    ),
    delete: handle("delete_business_document_draft", (req) =>
      draftService.deleteBusinessDocumentDraft({
        pool: getPool(req),
        authenticatedActor: req.user,
        draftId: req.params.draftId,
        expectedVersion: req.body?.expectedVersion,
      })
    ),
    list: handle("list_business_document_drafts", (req) =>
      draftService.listBusinessDocumentDrafts({
        pool: getPool(req),
        authenticatedActor: req.user,
        query: {
          search: req.query?.search,
          type: req.query?.type,
          status: req.query?.status,
          time: req.query?.time,
        },
      })
    ),
  };
}

function registerBusinessDocumentDraftRoutes({
  app,
  authMiddleware,
  getPool,
  sendPublicDatabaseError,
  draftService = service,
  env = process.env,
} = {}) {
  if (!app) throw new TypeError("An Express application is required.");
  if (typeof authMiddleware !== "function") throw new TypeError("authMiddleware must be a function.");
  const handlers = createBusinessDocumentDraftHandlers({
    getPool,
    sendPublicDatabaseError,
    draftService,
    env,
  });
  app.post("/business-document-drafts", authMiddleware, handlers.create);
  app.get("/business-document-drafts", authMiddleware, handlers.list);
  app.get("/business-document-drafts/:draftId", authMiddleware, handlers.get);
  app.patch("/business-document-drafts/:draftId", authMiddleware, handlers.update);
  app.delete("/business-document-drafts/:draftId", authMiddleware, handlers.delete);
  return handlers;
}

module.exports = {
  createBusinessDocumentDraftHandlers,
  registerBusinessDocumentDraftRoutes,
  sendBusinessDocumentDraftResult: sendResult,
};
