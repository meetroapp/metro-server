"use strict";

const service = require("./professionalQuoteCustomerOptionsService");

function sendResult(res, result) {
  res.setHeader?.("Cache-Control", "private, no-store");
  if (!result?.ok) {
    return res.status(result?.status || 500).json({
      success: false,
      code: result?.code || "PROFESSIONAL_QUOTE_CUSTOMER_OPTIONS_FAILED",
      message: result?.message || "Quote customer options could not be loaded.",
    });
  }
  return res.status(result.status || 200).json({
    success: true,
    code: result.code,
    contractVersion: result.contractVersion,
    customers: result.customers,
  });
}

function createProfessionalQuoteCustomerOptionsHandlers({
  getPool,
  sendPublicDatabaseError,
  customerOptionsService = service,
} = {}) {
  if (typeof getPool !== "function") throw new TypeError("getPool must be a function.");
  if (typeof sendPublicDatabaseError !== "function") {
    throw new TypeError("sendPublicDatabaseError must be a function.");
  }
  return {
    list: async (req, res) => {
      try {
        return sendResult(res, await customerOptionsService.listProfessionalQuoteCustomerOptions({
          pool: getPool(req),
          authenticatedActor: req.user,
        }));
      } catch (error) {
        return sendPublicDatabaseError({
          res,
          error,
          operation: "list_professional_quote_customer_options",
          code: "PROFESSIONAL_QUOTE_CUSTOMER_OPTIONS_FAILED",
          message: "Quote customer options could not be loaded.",
        });
      }
    },
  };
}

function registerProfessionalQuoteCustomerOptionsRoutes({
  app,
  authMiddleware,
  getPool,
  sendPublicDatabaseError,
  customerOptionsService = service,
} = {}) {
  if (!app || typeof app.get !== "function") throw new TypeError("An Express application is required.");
  if (typeof authMiddleware !== "function") throw new TypeError("authMiddleware must be a function.");
  const handlers = createProfessionalQuoteCustomerOptionsHandlers({
    getPool,
    sendPublicDatabaseError,
    customerOptionsService,
  });
  app.get("/professional/quote-customer-options", authMiddleware, handlers.list);
  return handlers;
}

module.exports = {
  createProfessionalQuoteCustomerOptionsHandlers,
  registerProfessionalQuoteCustomerOptionsRoutes,
  sendProfessionalQuoteCustomerOptionsResult: sendResult,
};
