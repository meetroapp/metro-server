"use strict";

const {
  executeIntelligenceGateway,
} = require("./intelligenceGateway");

const INTELLIGENCE_COMPANION_ROUTE = "/api/companion/ask";

function setIntelligenceNoStore(_req, res, next) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  next();
}

function createIntelligenceGatewayHandler({
  getPool,
  gateway = executeIntelligenceGateway,
  logger = null,
  ...gatewayDependencies
}) {
  if (typeof getPool !== "function" || typeof gateway !== "function") {
    throw new TypeError("Intelligence route dependencies are required.");
  }

  return async function intelligenceGatewayHandler(req, res) {
    try {
      const result = await gateway({
        ...gatewayDependencies,
        pool: getPool(req),
        authenticatedActor: req.user,
        idempotencyKey: req.headers?.["idempotency-key"],
        body: req.body,
        logger,
      });
      const { ok, status, ...payload } = result;
      return res.status(status).json({ success: ok, ...payload });
    } catch {
      if (logger && typeof logger.error === "function") {
        logger.error("intelligence.gateway.internal_failure", {
          operation: String(req.body?.operation || "unknown").slice(0, 160),
        });
      }
      return res.status(500).json({
        success: false,
        code: "INTELLIGENCE_INTERNAL_FAILURE",
        message: "The Intelligence operation could not be completed.",
      });
    }
  };
}

function registerIntelligenceRoutes({
  app,
  authMiddleware,
  getPool,
  ...dependencies
}) {
  if (!app || typeof app.post !== "function" || typeof authMiddleware !== "function") {
    throw new TypeError("Intelligence route registration requires an app and authentication.");
  }
  app.post(
    INTELLIGENCE_COMPANION_ROUTE,
    setIntelligenceNoStore,
    authMiddleware,
    createIntelligenceGatewayHandler({ getPool, ...dependencies })
  );
}

module.exports = {
  INTELLIGENCE_COMPANION_ROUTE,
  createIntelligenceGatewayHandler,
  registerIntelligenceRoutes,
  setIntelligenceNoStore,
};
