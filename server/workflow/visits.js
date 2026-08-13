"use strict";

const visitService = require("./visitService");

function sendVisitResult(res, result) {
  if (!result?.ok) {
    return res.status(result?.status || 500).json({
      success: false,
      code: result?.code || "VISIT_FAILED",
      message: result?.message || "The Visit operation could not be completed.",
    });
  }
  const payload = {
    success: true,
    code: result.code,
  };
  for (const field of ["visit", "visits", "event", "actions"]) {
    if (result[field] !== undefined) payload[field] = result[field];
  }
  if (result.replayed) payload.replayed = true;
  return res.status(result.status || 200).json(payload);
}

function createVisitHandlers({
  getPool,
  sendPublicDatabaseError,
  service = visitService,
} = {}) {
  if (typeof getPool !== "function") {
    throw new TypeError("getPool must be a function.");
  }
  if (typeof sendPublicDatabaseError !== "function") {
    throw new TypeError("sendPublicDatabaseError must be a function.");
  }

  function handle(operation, action, { noStore = false } = {}) {
    return async (req, res) => {
      if (noStore) res.setHeader?.("Cache-Control", "private, no-store");
      try {
        return sendVisitResult(res, await action(req));
      } catch (error) {
        return sendPublicDatabaseError({
          res,
          error,
          operation,
          code: "VISIT_FAILED",
          message: "The Visit operation could not be completed.",
        });
      }
    };
  }

  const common = (req) => ({
    pool: getPool(req),
    authenticatedActor: req.user,
    jobId: req.params.jobId,
  });
  const visit = (req) => ({
    ...common(req),
    visitId: req.params.visitId,
  });
  const versionCommand = (req) => ({
    ...visit(req),
    expectedVersion: req.body?.expectedVersion,
    idempotencyKey: req.headers?.["idempotency-key"],
  });

  return {
    listVisits: handle(
      "list_visits",
      (req) => service.listVisits(common(req)),
      { noStore: true }
    ),
    getVisit: handle(
      "get_visit",
      (req) => service.getVisit(visit(req)),
      { noStore: true }
    ),
    proposeVisit: handle("propose_visit", (req) => service.proposeVisit({
      ...common(req),
      purpose: req.body?.purpose,
      scheduledStartAt: req.body?.scheduledStartAt,
      scheduledEndAt: req.body?.scheduledEndAt,
      timeZone: req.body?.timeZone,
      locationMode: req.body?.locationMode,
      evaluationId: req.body?.evaluationId,
      workstreamIds: req.body?.workstreamIds,
      approvedQuoteDecisionId: req.body?.approvedQuoteDecisionId,
      idempotencyKey: req.headers?.["idempotency-key"],
    })),
    confirmVisit: handle("confirm_visit", (req) =>
      service.confirmVisit(versionCommand(req))
    ),
    requestVisitChange: handle("request_visit_change", (req) =>
      service.requestVisitChange({
        ...versionCommand(req),
        reason: req.body?.reason,
      })
    ),
    rescheduleVisit: handle("reschedule_visit", (req) =>
      service.rescheduleVisit({
        ...versionCommand(req),
        scheduledStartAt: req.body?.scheduledStartAt,
        scheduledEndAt: req.body?.scheduledEndAt,
        timeZone: req.body?.timeZone,
        locationMode: req.body?.locationMode,
        reason: req.body?.reason,
      })
    ),
    cancelVisit: handle("cancel_visit", (req) =>
      service.cancelVisit({
        ...versionCommand(req),
        reason: req.body?.reason,
      })
    ),
    completeVisit: handle("complete_visit", (req) =>
      service.completeVisit(versionCommand(req))
    ),
  };
}

function registerVisitRoutes({
  app,
  authMiddleware,
  getPool,
  sendPublicDatabaseError,
  service = visitService,
} = {}) {
  if (!app || typeof app.get !== "function" || typeof app.post !== "function") {
    throw new TypeError("An Express application is required.");
  }
  if (typeof authMiddleware !== "function") {
    throw new TypeError("authMiddleware must be a function.");
  }
  const handlers = createVisitHandlers({
    getPool,
    sendPublicDatabaseError,
    service,
  });

  app.get("/jobs/:jobId/visits", authMiddleware, handlers.listVisits);
  app.get("/jobs/:jobId/visits/:visitId", authMiddleware, handlers.getVisit);
  app.post("/jobs/:jobId/visits", authMiddleware, handlers.proposeVisit);
  app.post(
    "/jobs/:jobId/visits/:visitId/confirm",
    authMiddleware,
    handlers.confirmVisit
  );
  app.post(
    "/jobs/:jobId/visits/:visitId/change-request",
    authMiddleware,
    handlers.requestVisitChange
  );
  app.post(
    "/jobs/:jobId/visits/:visitId/reschedule",
    authMiddleware,
    handlers.rescheduleVisit
  );
  app.post(
    "/jobs/:jobId/visits/:visitId/cancel",
    authMiddleware,
    handlers.cancelVisit
  );
  app.post(
    "/jobs/:jobId/visits/:visitId/complete",
    authMiddleware,
    handlers.completeVisit
  );

  return handlers;
}

module.exports = {
  createVisitHandlers,
  registerVisitRoutes,
  sendVisitResult,
};
