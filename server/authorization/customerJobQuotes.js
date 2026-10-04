"use strict";

const customerJobQuotesService = require("./customerJobQuotesService");

function sendCustomerJobQuotesResult(res, result) {
  if (!result?.ok) {
    return res.status(result?.status || 500).json({
      success: false,
      code: result?.code || "CUSTOMER_JOB_QUOTES_FAILED",
      message: result?.message || "The customer Quotes could not be loaded.",
    });
  }
  return res.status(result.status || 200).json({
    success: true,
    code: result.code,
    job: result.job,
    quotes: result.quotes,
    pagination: result.pagination,
  });
}

function createCustomerJobQuotesHandlers({
  getPool,
  sendPublicDatabaseError,
  service = customerJobQuotesService,
} = {}) {
  if (typeof getPool !== "function") throw new TypeError("getPool must be a function.");
  if (typeof sendPublicDatabaseError !== "function") {
    throw new TypeError("sendPublicDatabaseError must be a function.");
  }
  return {
    getCustomerJobQuotes: async (req, res) => {
      res.setHeader?.("Cache-Control", "private, no-store");
      try {
        return sendCustomerJobQuotesResult(res, await service.getCustomerJobQuotes({
          pool: getPool(req),
          authenticatedActor: req.user,
          jobId: req.params?.jobId,
          limit: req.query?.limit,
          cursor: req.query?.cursor,
        }));
      } catch (error) {
        return sendPublicDatabaseError({
          res,
          error,
          operation: "get_customer_job_quotes",
          code: "CUSTOMER_JOB_QUOTES_FAILED",
          message: "The customer Quotes could not be loaded.",
        });
      }
    },
  };
}

function registerCustomerJobQuotesRoutes({
  app,
  authMiddleware,
  getPool,
  sendPublicDatabaseError,
  service = customerJobQuotesService,
} = {}) {
  if (!app || typeof app.get !== "function") {
    throw new TypeError("An Express application is required.");
  }
  if (typeof authMiddleware !== "function") {
    throw new TypeError("authMiddleware must be a function.");
  }
  const handlers = createCustomerJobQuotesHandlers({
    getPool,
    sendPublicDatabaseError,
    service,
  });
  app.get(
    "/customer/jobs/:jobId/quotes",
    authMiddleware,
    handlers.getCustomerJobQuotes
  );
  return handlers;
}

module.exports = {
  createCustomerJobQuotesHandlers,
  registerCustomerJobQuotesRoutes,
  sendCustomerJobQuotesResult,
};
