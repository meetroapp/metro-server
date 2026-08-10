"use strict";

const recommendationService = require("./recommendationService");

function sendRecommendationResult(res, result) {
  if (!result || result.ok !== true) {
    return res.status(result?.status || 500).json({
      success: false,
      code: result?.code || "RECOMMENDATION_FAILED",
      message: result?.message || "The Recommendation operation could not be completed.",
    });
  }
  const payload = { success: true, code: result.code };
  for (const field of [
    "recommendation",
    "recommendations",
    "constraint",
    "dispositionEvent",
  ]) {
    if (result[field] !== undefined) payload[field] = result[field];
  }
  if (result.replayed) payload.replayed = true;
  return res.status(result.status || 200).json(payload);
}

function createRecommendationHandlers({
  getPool,
  sendPublicDatabaseError,
  service = recommendationService,
}) {
  if (typeof getPool !== "function") throw new TypeError("getPool must be a function.");
  if (typeof sendPublicDatabaseError !== "function") {
    throw new TypeError("sendPublicDatabaseError must be a function.");
  }

  function handle(operation, action) {
    return async (req, res) => {
      try {
        return sendRecommendationResult(res, await action(req));
      } catch (error) {
        return sendPublicDatabaseError({
          res,
          error,
          operation,
          code: "RECOMMENDATION_FAILED",
          message: "The Recommendation operation could not be completed.",
        });
      }
    };
  }

  return {
    createRecommendation: handle("create_recommendation", (req) =>
      service.createRecommendation({
        pool: getPool(req),
        authenticatedActor: req.user,
        findingId: req.params.findingId,
        kind: req.body?.kind,
        statement: req.body?.statement,
        primaryRecommendationId: req.body?.primaryRecommendationId,
        idempotencyKey: req.headers?.["idempotency-key"],
      })
    ),
    listRecommendations: handle("list_finding_recommendations", (req) =>
      service.listRecommendationsByFinding({
        pool: getPool(req),
        authenticatedActor: req.user,
        findingId: req.params.findingId,
      })
    ),
    getRecommendation: handle("get_recommendation", (req) =>
      service.getRecommendation({
        pool: getPool(req),
        authenticatedActor: req.user,
        recommendationId: req.params.recommendationId,
      })
    ),
    recordConstraint: handle("record_customer_constraint", (req) =>
      service.recordCustomerConstraint({
        pool: getPool(req),
        authenticatedActor: req.user,
        recommendationId: req.params.recommendationId,
        constraintType: req.body?.constraintType,
        statement: req.body?.statement,
        idempotencyKey: req.headers?.["idempotency-key"],
      })
    ),
    transitionRecommendation: handle("transition_recommendation", (req) =>
      service.transitionRecommendation({
        pool: getPool(req),
        authenticatedActor: req.user,
        recommendationId: req.params.recommendationId,
        expectedVersion: req.body?.expectedVersion,
        targetStatus: req.body?.targetStatus,
        replacementRecommendationId: req.body?.replacementRecommendationId,
        decisionEvidenceNote: req.body?.decisionEvidenceNote,
        idempotencyKey: req.headers?.["idempotency-key"],
      })
    ),
  };
}

function registerRecommendationRoutes({
  app,
  authMiddleware,
  getPool,
  sendPublicDatabaseError,
  service = recommendationService,
}) {
  if (!app) throw new TypeError("An Express application is required.");
  if (typeof authMiddleware !== "function") {
    throw new TypeError("authMiddleware must be a function.");
  }
  const handlers = createRecommendationHandlers({
    getPool,
    sendPublicDatabaseError,
    service,
  });
  app.post(
    "/findings/:findingId/recommendations",
    authMiddleware,
    handlers.createRecommendation
  );
  app.get(
    "/findings/:findingId/recommendations",
    authMiddleware,
    handlers.listRecommendations
  );
  app.get(
    "/recommendations/:recommendationId",
    authMiddleware,
    handlers.getRecommendation
  );
  app.post(
    "/recommendations/:recommendationId/constraints",
    authMiddleware,
    handlers.recordConstraint
  );
  app.post(
    "/recommendations/:recommendationId/transition",
    authMiddleware,
    handlers.transitionRecommendation
  );
  return handlers;
}

module.exports = {
  createRecommendationHandlers,
  registerRecommendationRoutes,
  sendRecommendationResult,
};
