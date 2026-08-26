"use strict";

const quoteDraftService = require("./quoteDraftService");

function sendQuoteDraftResult(res, result) {
  if (!result || result.ok !== true) {
    return res.status(result?.status || 500).json({
      success: false,
      code: result?.code || "QUOTE_DRAFT_FAILED",
      message: result?.message || "The Draft Quote operation could not be completed.",
    });
  }
  const payload = { success: true, code: result.code };
  for (const field of [
    "quote",
    "quotes",
    "review",
    "scopeItem",
    "removedScopeItemId",
    "customerDecision",
  ]) {
    if (result[field] !== undefined) payload[field] = result[field];
  }
  if (result.replayed) payload.replayed = true;
  return res.status(result.status || 200).json(payload);
}

function createQuoteDraftHandlers({
  getPool,
  sendPublicDatabaseError,
  service = quoteDraftService,
}) {
  if (typeof getPool !== "function") throw new TypeError("getPool must be a function.");
  if (typeof sendPublicDatabaseError !== "function") {
    throw new TypeError("sendPublicDatabaseError must be a function.");
  }

  function handle(operation, action, { privateNoStore = false } = {}) {
    return async (req, res) => {
      if (privateNoStore) {
        res.setHeader?.("Cache-Control", "private, no-store");
      }
      try {
        return sendQuoteDraftResult(res, await action(req));
      } catch (error) {
        return sendPublicDatabaseError({
          res,
          error,
          operation,
          code: "QUOTE_DRAFT_FAILED",
          message: "The Draft Quote operation could not be completed.",
        });
      }
    };
  }

  return {
    getBusinessDocumentDraftQuoteReview: handle(
      "get_business_document_draft_quote_review",
      (req) => service.getBusinessDocumentDraftQuoteReview({
        pool: getPool(req),
        authenticatedActor: req.user,
        draftId: req.params.draftId,
        expectedDocumentVersion: req.query?.version,
      }),
      { privateNoStore: true }
    ),
    importBusinessDocumentDraftQuote: handle(
      "import_business_document_draft_quote",
      (req) => service.importBusinessDocumentDraftQuote({
        pool: getPool(req),
        authenticatedActor: req.user,
        draftId: req.params.draftId,
        expectedDocumentVersion: req.body?.expectedDocumentVersion,
        idempotencyKey: req.headers?.["idempotency-key"],
      })
    ),
    createDraftQuote: handle("create_draft_quote", (req) =>
      service.createDraftQuote({
        pool: getPool(req),
        authenticatedActor: req.user,
        jobId: req.params.jobId,
        currency: req.body?.currency,
        customerTermsSnapshot: req.body?.customerTermsSnapshot,
        idempotencyKey: req.headers?.["idempotency-key"],
      })
    ),
    listDraftQuotes: handle("list_job_draft_quotes", (req) =>
      service.listDraftQuotesByJob({
        pool: getPool(req),
        authenticatedActor: req.user,
        jobId: req.params.jobId,
      })
    ),
    getDraftQuote: handle("get_draft_quote", (req) =>
      service.getDraftQuote({
        pool: getPool(req),
        authenticatedActor: req.user,
        quoteId: req.params.quoteId,
      })
    ),
    addScopeItem: handle("add_draft_quote_scope_item", (req) =>
      service.addDraftScopeItem({
        pool: getPool(req),
        authenticatedActor: req.user,
        quoteId: req.params.quoteId,
        expectedVersion: req.body?.expectedVersion,
        item: req.body?.item,
        idempotencyKey: req.headers?.["idempotency-key"],
      })
    ),
    removeScopeItem: handle("remove_draft_quote_scope_item", (req) =>
      service.removeDraftScopeItem({
        pool: getPool(req),
        authenticatedActor: req.user,
        quoteId: req.params.quoteId,
        scopeItemId: req.params.scopeItemId,
        expectedVersion: req.body?.expectedVersion,
        idempotencyKey: req.headers?.["idempotency-key"],
      })
    ),
    issueQuote: handle("issue_quote", (req) =>
      service.issueQuote({
        pool: getPool(req),
        authenticatedActor: req.user,
        quoteId: req.params.quoteId,
        expectedVersion: req.body?.expectedVersion,
        idempotencyKey: req.headers?.["idempotency-key"],
      })
    ),
    getCustomerIssuedQuote: handle(
      "get_customer_issued_quote",
      (req) => service.getCustomerIssuedQuote({
        pool: getPool(req),
        authenticatedActor: req.user,
        quoteId: req.params.quoteId,
      }),
      { privateNoStore: true }
    ),
    approveIssuedQuote: handle("approve_issued_quote", (req) =>
      service.approveIssuedQuote({
        pool: getPool(req),
        authenticatedActor: req.user,
        quoteId: req.params.quoteId,
        expectedIssuedVersion: req.body?.expectedIssuedVersion,
        idempotencyKey: req.headers?.["idempotency-key"],
      })
    ),
    declineIssuedQuote: handle("decline_issued_quote", (req) =>
      service.declineIssuedQuote({
        pool: getPool(req),
        authenticatedActor: req.user,
        quoteId: req.params.quoteId,
        expectedIssuedVersion: req.body?.expectedIssuedVersion,
        idempotencyKey: req.headers?.["idempotency-key"],
      })
    ),
    createDerivedDraftQuote: handle("create_derived_draft_quote", (req) =>
      service.createDerivedDraftQuote({
        pool: getPool(req),
        authenticatedActor: req.user,
        parentQuoteId: req.params.quoteId,
        expectedIssuedVersion: req.body?.expectedIssuedVersion,
        lineageType: req.body?.lineageType,
        reasonCategory: req.body?.reasonCategory,
        idempotencyKey: req.headers?.["idempotency-key"],
      })
    ),
  };
}

function registerQuoteDraftRoutes({
  app,
  authMiddleware,
  getPool,
  sendPublicDatabaseError,
  service = quoteDraftService,
}) {
  if (!app) throw new TypeError("An Express application is required.");
  if (typeof authMiddleware !== "function") {
    throw new TypeError("authMiddleware must be a function.");
  }
  const handlers = createQuoteDraftHandlers({
    getPool,
    sendPublicDatabaseError,
    service,
  });
  app.post("/jobs/:jobId/quotes", authMiddleware, handlers.createDraftQuote);
  app.get(
    "/business-document-drafts/:draftId/quote-review",
    authMiddleware,
    handlers.getBusinessDocumentDraftQuoteReview
  );
  app.post(
    "/business-document-drafts/:draftId/canonical-quote",
    authMiddleware,
    handlers.importBusinessDocumentDraftQuote
  );
  app.get("/jobs/:jobId/quotes", authMiddleware, handlers.listDraftQuotes);
  app.get("/quotes/:quoteId", authMiddleware, handlers.getDraftQuote);
  app.post("/quotes/:quoteId/scope-items", authMiddleware, handlers.addScopeItem);
  app.post(
    "/quotes/:quoteId/scope-items/:scopeItemId/remove",
    authMiddleware,
    handlers.removeScopeItem
  );
  app.post("/quotes/:quoteId/issue", authMiddleware, handlers.issueQuote);
  app.get("/quotes/:quoteId/customer", authMiddleware, handlers.getCustomerIssuedQuote);
  app.post("/quotes/:quoteId/approve", authMiddleware, handlers.approveIssuedQuote);
  app.post("/quotes/:quoteId/decline", authMiddleware, handlers.declineIssuedQuote);
  app.post(
    "/quotes/:quoteId/derived-quotes",
    authMiddleware,
    handlers.createDerivedDraftQuote
  );
  return handlers;
}

module.exports = {
  createQuoteDraftHandlers,
  registerQuoteDraftRoutes,
  sendQuoteDraftResult,
};
