"use strict";

const liveJobProjectionService = require("./liveJobProjectionService");

function sendLiveJobResult(res, result) {
  if (!result?.ok) {
    return res.status(result?.status || 500).json({
      success: false,
      code: result?.code || "LIVE_JOB_FAILED",
      message: result?.message || "The current Job could not be loaded.",
    });
  }
  return res.status(result.status || 200).json({
    success: true,
    code: result.code,
    liveJob: result.liveJob,
  });
}

function createLiveJobHandlers({
  getPool,
  sendPublicDatabaseError,
  service = liveJobProjectionService,
} = {}) {
  return {
    getLiveJob: async (req, res) => {
      res.setHeader?.("Cache-Control", "private, no-store");
      try {
        return sendLiveJobResult(
          res,
          await service.getCanonicalLiveJob({
            pool: getPool(req),
            authenticatedActor: req.user,
            jobId: req.params.jobId,
          })
        );
      } catch (error) {
        return sendPublicDatabaseError({
          res,
          error,
          operation: "get_live_job_state",
          code: "LIVE_JOB_FAILED",
          message: "The current Job could not be loaded.",
        });
      }
    },
  };
}

function registerLiveJobRoutes({
  app,
  authMiddleware,
  getPool,
  sendPublicDatabaseError,
  service = liveJobProjectionService,
} = {}) {
  if (!app || typeof app.get !== "function" || typeof authMiddleware !== "function") {
    throw new TypeError("Live Job route dependencies are required.");
  }
  const handlers = createLiveJobHandlers({
    getPool,
    sendPublicDatabaseError,
    service,
  });
  app.get("/jobs/:jobId/live-state", authMiddleware, handlers.getLiveJob);
  return handlers;
}

module.exports = {
  createLiveJobHandlers,
  registerLiveJobRoutes,
  sendLiveJobResult,
};
