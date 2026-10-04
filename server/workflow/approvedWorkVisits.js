"use strict";

const approvedWorkVisitService = require("./approvedWorkVisitService");

function sendApprovedWorkVisitResult(res, result) {
  if (!result?.ok) {
    return res.status(result?.status || 500).json({
      success: false,
      code: result?.code || "APPROVED_WORK_VISIT_FAILED",
      message:
        result?.message || "The Approved Work Visit operation could not be completed.",
    });
  }
  const payload = { success: true, code: result.code };
  if (result.authority !== undefined) payload.authority = result.authority;
  if (result.replayed) payload.replayed = true;
  return res.status(result.status || 200).json(payload);
}

function createApprovedWorkVisitHandlers({
  getPool,
  sendPublicDatabaseError,
  service = approvedWorkVisitService,
} = {}) {
  if (typeof getPool !== "function" || typeof sendPublicDatabaseError !== "function") {
    throw new TypeError("Approved Work Visit route dependencies are required.");
  }

  function handle(operation, action, { noStore = false } = {}) {
    return async (req, res) => {
      if (noStore) res.setHeader?.("Cache-Control", "private, no-store");
      try {
        return sendApprovedWorkVisitResult(res, await action(req));
      } catch (error) {
        return sendPublicDatabaseError({
          res,
          error,
          operation,
          code: "APPROVED_WORK_VISIT_FAILED",
          message: "The Approved Work Visit operation could not be completed.",
        });
      }
    };
  }

  const subject = (req) => ({
    pool: getPool(req),
    authenticatedActor: req.user,
    jobId: req.params.jobId,
    quoteId: req.params.quoteId,
  });

  return {
    getAuthority: handle(
      "get_approved_work_visit_authority",
      (req) => service.getApprovedWorkVisitAuthority(subject(req)),
      { noStore: true }
    ),
    activateAuthority: handle(
      "activate_approved_work_visit_authority",
      (req) => service.activateApprovedWorkVisitAuthority({
        ...subject(req),
        idempotencyKey: req.headers?.["idempotency-key"],
      })
    ),
  };
}

function registerApprovedWorkVisitRoutes({
  app,
  authMiddleware,
  getPool,
  sendPublicDatabaseError,
  service = approvedWorkVisitService,
} = {}) {
  if (!app || typeof app.get !== "function" || typeof app.post !== "function") {
    throw new TypeError("An Express application is required.");
  }
  if (typeof authMiddleware !== "function") {
    throw new TypeError("authMiddleware must be a function.");
  }
  const handlers = createApprovedWorkVisitHandlers({
    getPool,
    sendPublicDatabaseError,
    service,
  });
  const route = "/jobs/:jobId/quotes/:quoteId/approved-work-visit-authority";
  app.get(route, authMiddleware, handlers.getAuthority);
  app.post(route, authMiddleware, handlers.activateAuthority);
  return handlers;
}

module.exports = {
  createApprovedWorkVisitHandlers,
  registerApprovedWorkVisitRoutes,
  sendApprovedWorkVisitResult,
};
