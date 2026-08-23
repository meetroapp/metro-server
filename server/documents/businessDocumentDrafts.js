"use strict";

const service = require("./businessDocumentDraftService");
const deliveryServiceDefault = require("./businessDocumentDeliveryService");
const numberingServiceDefault = require("./businessDocumentNumberingService");

function sendResult(res, result) {
  const status = result?.status || 500;
  const payload = {
    success: result?.ok === true,
    code: result?.code || "BUSINESS_DOCUMENT_FAILED",
  };
  if (result?.message) payload.message = result.message;
  if (result?.document !== undefined) payload.document = result.document;
  if (result?.documents !== undefined) payload.documents = result.documents;
  if (result?.delivery !== undefined) payload.delivery = result.delivery;
  if (result?.deliveries !== undefined) payload.deliveries = result.deliveries;
  if (result?.numbering !== undefined) payload.numbering = result.numbering;
  if (result?.deletedDraftId !== undefined) payload.deletedDraftId = result.deletedDraftId;
  if (result?.currentVersion !== undefined) payload.currentVersion = result.currentVersion;
  if (result?.replayed) payload.replayed = true;
  res.setHeader?.("Cache-Control", "private, no-store");
  return res.status(status).json(payload);
}

function sendPdfResult(res, result) {
  if (result?.ok !== true || !result.pdf?.buffer) return sendResult(res, result);
  res.setHeader?.("Cache-Control", "private, no-store");
  res.setHeader?.("Content-Type", "application/pdf");
  res.setHeader?.("Content-Disposition", `inline; filename="${result.pdf.filename}"`);
  res.setHeader?.("X-Content-Type-Options", "nosniff");
  return res.status(result.status || 200).send(result.pdf.buffer);
}

function createBusinessDocumentDraftHandlers({
  getPool,
  sendPublicDatabaseError,
  draftService = service,
  deliveryService = deliveryServiceDefault,
  numberingService = numberingServiceDefault,
  emailDelivery = null,
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
    numbering: handle("get_business_document_numbering", (req) =>
      numberingService.getBusinessDocumentNumbering({
        pool: getPool(req),
        authenticatedActor: req.user,
        query: {
          documentType: req.query?.documentType,
          jobId: req.query?.jobId,
        },
      })
    ),
    initializeNumbering: handle("initialize_business_document_numbering", (req) =>
      numberingService.initializeBusinessDocumentNumbering({
        pool: getPool(req),
        authenticatedActor: req.user,
        payload: req.body,
      })
    ),
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
    deliver: handle("deliver_business_document_draft", (req) =>
      deliveryService.deliverBusinessDocument({
        pool: getPool(req),
        authenticatedActor: req.user,
        draftId: req.params.draftId,
        expectedVersion: req.body?.expectedVersion,
        idempotencyKey: req.headers?.["idempotency-key"],
        channel: req.body?.channel,
        recipientEmail: req.body?.recipientEmail,
        subject: req.body?.subject,
        customerMessage: req.body?.customerMessage,
        emailDelivery: req.app?.locals?.emailDelivery || emailDelivery,
      })
    ),
    deliveries: handle("list_business_document_deliveries", (req) =>
      deliveryService.listBusinessDocumentDeliveries({
        pool: getPool(req),
        authenticatedActor: req.user,
        draftId: req.params.draftId,
      })
    ),
    customerPdf: async (req, res) => {
      try {
        return sendPdfResult(res, await deliveryService.getBusinessDocumentCustomerPdf({
          pool: getPool(req),
          authenticatedActor: req.user,
          draftId: req.params.draftId,
          expectedVersion: req.query?.version,
        }));
      } catch (error) {
        return sendPublicDatabaseError({
          res,
          error,
          operation: "get_business_document_customer_pdf",
          code: "BUSINESS_DOCUMENT_FAILED",
          message: "The customer PDF could not be prepared.",
        });
      }
    },
  };
}

function registerBusinessDocumentDraftRoutes({
  app,
  authMiddleware,
  getPool,
  sendPublicDatabaseError,
  draftService = service,
  deliveryService = deliveryServiceDefault,
  numberingService = numberingServiceDefault,
  emailDelivery = null,
  env = process.env,
} = {}) {
  if (!app) throw new TypeError("An Express application is required.");
  if (typeof authMiddleware !== "function") throw new TypeError("authMiddleware must be a function.");
  const handlers = createBusinessDocumentDraftHandlers({
    getPool,
    sendPublicDatabaseError,
    draftService,
    deliveryService,
    numberingService,
    emailDelivery,
    env,
  });
  app.get("/business-document-numbering", authMiddleware, handlers.numbering);
  app.post("/business-document-numbering", authMiddleware, handlers.initializeNumbering);
  app.post("/business-document-drafts", authMiddleware, handlers.create);
  app.get("/business-document-drafts", authMiddleware, handlers.list);
  app.get("/business-document-drafts/:draftId", authMiddleware, handlers.get);
  app.get("/business-document-drafts/:draftId/customer-pdf", authMiddleware, handlers.customerPdf);
  app.patch("/business-document-drafts/:draftId", authMiddleware, handlers.update);
  app.delete("/business-document-drafts/:draftId", authMiddleware, handlers.delete);
  app.get("/business-document-drafts/:draftId/deliveries", authMiddleware, handlers.deliveries);
  app.post("/business-document-drafts/:draftId/deliveries", authMiddleware, handlers.deliver);
  return handlers;
}

module.exports = {
  createBusinessDocumentDraftHandlers,
  registerBusinessDocumentDraftRoutes,
  sendBusinessDocumentDraftResult: sendResult,
  sendBusinessDocumentPdfResult: sendPdfResult,
};
