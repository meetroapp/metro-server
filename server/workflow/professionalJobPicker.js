"use strict";

const professionalJobPickerService = require("./professionalJobPickerService");

function sendProfessionalJobPickerResult(res, result) {
  if (!result?.ok) {
    return res.status(result?.status || 500).json({
      success: false,
      code: result?.code || "PROFESSIONAL_JOBS_FAILED",
      message:
        result?.message || "The professional Jobs could not be loaded.",
    });
  }
  return res.status(result.status || 200).json({
    success: true,
    code: result.code,
    jobs: result.jobs,
  });
}

function createProfessionalJobPickerHandlers({
  getPool,
  sendPublicDatabaseError,
  service = professionalJobPickerService,
} = {}) {
  if (typeof getPool !== "function") {
    throw new TypeError("getPool must be a function.");
  }
  if (typeof sendPublicDatabaseError !== "function") {
    throw new TypeError("sendPublicDatabaseError must be a function.");
  }
  return {
    listAuthorizedProfessionalJobs: async (req, res) => {
      res.setHeader?.("Cache-Control", "private, no-store");
      try {
        return sendProfessionalJobPickerResult(
          res,
          await service.listAuthorizedProfessionalJobs({
            pool: getPool(req),
            authenticatedActor: req.user,
          })
        );
      } catch (error) {
        return sendPublicDatabaseError({
          res,
          error,
          operation: "list_authorized_professional_jobs",
          code: "PROFESSIONAL_JOBS_FAILED",
          message: "The professional Jobs could not be loaded.",
        });
      }
    },
  };
}

function registerProfessionalJobPickerRoutes({
  app,
  authMiddleware,
  getPool,
  sendPublicDatabaseError,
  service = professionalJobPickerService,
} = {}) {
  if (!app || typeof app.get !== "function") {
    throw new TypeError("An Express application is required.");
  }
  if (typeof authMiddleware !== "function") {
    throw new TypeError("authMiddleware must be a function.");
  }
  const handlers = createProfessionalJobPickerHandlers({
    getPool,
    sendPublicDatabaseError,
    service,
  });
  app.get(
    "/professional/jobs",
    authMiddleware,
    handlers.listAuthorizedProfessionalJobs
  );
  return handlers;
}

module.exports = {
  createProfessionalJobPickerHandlers,
  registerProfessionalJobPickerRoutes,
  sendProfessionalJobPickerResult,
};
