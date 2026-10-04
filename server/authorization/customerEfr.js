"use strict";

const customerEfrService = require("./customerEfrService");

function sendCustomerEfrResult(res, result) {
  if (!result?.ok) {
    return res.status(result?.status || 500).json({
      success: false,
      code: result?.code || "CUSTOMER_EFR_FAILED",
      message: result?.message || "Project assessment details could not be loaded.",
    });
  }
  return res.status(result.status || 200).json({
    success: true,
    code: result.code,
    projectAssessment: result.projectAssessment,
  });
}

function createCustomerEfrHandlers({
  getPool,
  sendPublicDatabaseError,
  service = customerEfrService,
} = {}) {
  if (typeof getPool !== "function") throw new TypeError("getPool must be a function.");
  if (typeof sendPublicDatabaseError !== "function") {
    throw new TypeError("sendPublicDatabaseError must be a function.");
  }
  return {
    getCustomerEfr: async (req, res) => {
      res.setHeader?.("Cache-Control", "private, no-store");
      try {
        return sendCustomerEfrResult(res, await service.getCustomerEfr({
          pool: getPool(req),
          authenticatedActor: req.user,
          jobId: req.params?.jobId,
        }));
      } catch (error) {
        return sendPublicDatabaseError({
          res,
          error,
          operation: "get_customer_efr",
          code: "CUSTOMER_EFR_FAILED",
          message: "Project assessment details could not be loaded.",
        });
      }
    },
  };
}

function registerCustomerEfrRoutes({
  app,
  authMiddleware,
  getPool,
  sendPublicDatabaseError,
  service = customerEfrService,
} = {}) {
  const handlers = createCustomerEfrHandlers({
    getPool,
    sendPublicDatabaseError,
    service,
  });
  app.get(
    "/customer/jobs/:jobId/project-assessment",
    authMiddleware,
    handlers.getCustomerEfr
  );
  return handlers;
}

module.exports = {
  createCustomerEfrHandlers,
  registerCustomerEfrRoutes,
  sendCustomerEfrResult,
};
