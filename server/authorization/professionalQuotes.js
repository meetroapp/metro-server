"use strict";

const professionalQuotesService = require("./professionalQuotesService");
const quoteDeliveryService = require("./quoteDeliveryService");

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

function sendQuoteDeliveryResult(res, result) {
  if (!result?.ok) {
    return res.status(result?.status || 500).json({
      success: false,
      code: result?.code || "QUOTE_DELIVERY_FAILED",
      message: result?.message || "The Quote delivery operation could not be completed.",
    });
  }
  return res.status(result.status || 200).json({
    success: true,
    code: result.code,
    delivery: result.delivery,
  });
}

function createProfessionalQuotesHandlers({
  getPool,
  sendPublicDatabaseError,
  service = professionalQuotesService,
  deliveryService = quoteDeliveryService,
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
    getProfessionalQuoteDelivery: async (req, res) => {
      res.setHeader?.("Cache-Control", "private, no-store");
      try {
        return sendQuoteDeliveryResult(res, await deliveryService.getProfessionalQuoteDelivery({
          pool: getPool(req),
          authenticatedActor: req.user,
          quoteId: req.params.quoteId,
        }));
      } catch (error) {
        return sendPublicDatabaseError({
          res,
          error,
          operation: "get_professional_quote_delivery",
          code: "QUOTE_DELIVERY_FAILED",
          message: "The Quote delivery operation could not be completed.",
        });
      }
    },
    sendQuoteInMeetro: async (req, res) => {
      res.setHeader?.("Cache-Control", "private, no-store");
      try {
        return sendQuoteDeliveryResult(res, await deliveryService.sendQuoteInMeetro({
          pool: getPool(req),
          authenticatedActor: req.user,
          quoteId: req.params.quoteId,
          expectedIssuedVersion: req.body?.expectedIssuedVersion,
          idempotencyKey: req.headers?.["idempotency-key"],
        }));
      } catch (error) {
        return sendPublicDatabaseError({
          res,
          error,
          operation: "send_quote_in_meetro",
          code: "QUOTE_DELIVERY_FAILED",
          message: "The Quote delivery operation could not be completed.",
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
  deliveryService = quoteDeliveryService,
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
    deliveryService,
  });
  app.get(
    "/professional/quotes",
    authMiddleware,
    handlers.getProfessionalQuotes
  );
  app.get(
    "/professional/quotes/:quoteId/delivery",
    authMiddleware,
    handlers.getProfessionalQuoteDelivery
  );
  app.post(
    "/professional/quotes/:quoteId/send-in-meetro",
    authMiddleware,
    handlers.sendQuoteInMeetro
  );
  return handlers;
}

module.exports = {
  createProfessionalQuotesHandlers,
  registerProfessionalQuotesRoutes,
  sendQuoteDeliveryResult,
  sendProfessionalQuotesResult,
};
