"use strict";

const service = require("./jobCompletionService");

function sendResult(res, result, field = null) {
  res.setHeader?.("Cache-Control", "private, no-store");
  if (!result?.ok) {
    return res.status(result?.status || 500).json({
      success: false,
      code: result?.code || "JOB_COMPLETION_FAILED",
      message: result?.message || "The Job completion request could not be completed.",
      ...(Array.isArray(result?.reasons) ? { reasons: result.reasons } : {}),
    });
  }
  return res.status(result.status || 200).json({
    success: true,
    code: result.code,
    ...(field ? { [field]: result[field] } : {}),
    ...(result.replayed ? { replayed: true } : {}),
  });
}

function createJobCompletionHandlers({
  getPool,
  sendPublicDatabaseError,
  completionService = service,
} = {}) {
  const handle = (operation, field, action) => async (req, res) => {
    try {
      return sendResult(res, await action(req), field);
    } catch (error) {
      return sendPublicDatabaseError({
        res,
        error,
        operation,
        code: "JOB_COMPLETION_FAILED",
        message: "The Job completion request could not be completed.",
      });
    }
  };
  return {
    getCompletionReview: handle("get_job_completion_review", "completionReview", (req) =>
      completionService.getJobCompletionReview({
        pool: getPool(req),
        authenticatedActor: req.user,
        jobId: req.params.jobId,
      })),
    completeJob: handle("complete_job", "completion", (req) =>
      completionService.completeJob({
        pool: getPool(req),
        authenticatedActor: req.user,
        jobId: req.params.jobId,
        expectedVersion: req.body?.expectedVersion,
        idempotencyKey: req.headers?.["idempotency-key"],
      })),
    listProfessionalHistory: handle("list_professional_job_history", "jobHistory", (req) =>
      completionService.listProfessionalJobHistory({
        pool: getPool(req),
        authenticatedActor: req.user,
        limit: req.query?.limit,
        cursor: req.query?.cursor,
      })),
    getProfessionalHistory: handle("get_professional_job_history", "jobHistory", (req) =>
      completionService.getProfessionalJobHistory({
        pool: getPool(req),
        authenticatedActor: req.user,
        jobId: req.params.jobId,
      })),
    getCustomerHistory: handle("get_customer_job_history", "jobHistory", (req) =>
      completionService.getCustomerJobHistory({
        pool: getPool(req),
        authenticatedActor: req.user,
        jobId: req.params.jobId,
      })),
  };
}

function registerJobCompletionRoutes({
  app,
  authMiddleware,
  getPool,
  sendPublicDatabaseError,
  completionService = service,
} = {}) {
  const handlers = createJobCompletionHandlers({
    getPool,
    sendPublicDatabaseError,
    completionService,
  });
  app.get("/professional/jobs/history", authMiddleware, handlers.listProfessionalHistory);
  app.get(
    "/professional/jobs/:jobId/completion-review",
    authMiddleware,
    handlers.getCompletionReview
  );
  app.post("/professional/jobs/:jobId/complete", authMiddleware, handlers.completeJob);
  app.get(
    "/professional/jobs/:jobId/history",
    authMiddleware,
    handlers.getProfessionalHistory
  );
  app.get(
    "/customer/jobs/:jobId/history",
    authMiddleware,
    handlers.getCustomerHistory
  );
  return handlers;
}

module.exports = {
  createJobCompletionHandlers,
  registerJobCompletionRoutes,
  sendResult,
};
