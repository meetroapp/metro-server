"use strict";

const professionalQuotesService = require("./professionalQuotesService");

function sendProfessionalQuotesResult(res, result) {
  if (!result?.ok) {
    return res.status(result?.status || 500).json({
      success: false,
      code: result?.code || "PROFESSIONAL_QUOTES_FAILED",
      message: result?.message || "The professional Quotes could not be loaded.",
    });
  }
  return res.status(result.status || 200).json({
    success: true,
    code: result.code,
    classification: result.classification,
    summary: result.summary,
    quotes: result.quotes,
    pagination: result.pagination,
  });
}

function createProfessionalQuotesHandlers({
  getPool,
  sendPublicDatabaseError,
  service = professionalQuotesService,
} = {}) {
  if (typeof getPool !== "function") throw new TypeError("getPool must be a function.");
  if (typeof sendPublicDatabaseError !== "function") {
    throw new TypeError("sendPublicDatabaseError must be a function.");
  }
  return {
    getProfessionalQuotes: async (req, res) => {
      res.setHeader?.("Cache-Control", "private, no-store");
      try {
        return sendProfessionalQuotesResult(res, await service.getProfessionalQuotes({
          pool: getPool(req),
          authenticatedActor: req.user,
          classification: req.query?.classification,
          limit: req.query?.limit,
          cursor: req.query?.cursor,
        }));
      } catch (error) {
        return sendPublicDatabaseError({
          res,
          error,
          operation: "get_professional_quotes",
          code: "PROFESSIONAL_QUOTES_FAILED",
          message: "The professional Quotes could not be loaded.",
        });
      }
    },
  };
}

function registerProfessionalQuotesRoutes({
  app,
  authMiddleware,
  getPool,
  sendPublicDatabaseError,
  service = professionalQuotesService,
} = {}) {
  if (!app || typeof app.get !== "function") {
    throw new TypeError("An Express application is required.");
  }
  if (typeof authMiddleware !== "function") {
    throw new TypeError("authMiddleware must be a function.");
  }
  const handlers = createProfessionalQuotesHandlers({
    getPool,
    sendPublicDatabaseError,
    service,
  });
  app.get(
    "/professional/quotes",
    authMiddleware,
    handlers.getProfessionalQuotes
  );
  return handlers;
}

module.exports = {
  createProfessionalQuotesHandlers,
  registerProfessionalQuotesRoutes,
  sendProfessionalQuotesResult,
};
