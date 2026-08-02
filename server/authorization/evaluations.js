"use strict";

const evaluationService = require("./evaluationService");

function sendEvaluationResult(res, result) {
  if (!result || result.ok !== true) {
    return res.status(result?.status || 500).json({
      success: false,
      code: result?.code || "EVALUATION_FAILED",
      message: result?.message || "The Evaluation could not be completed.",
    });
  }

  const payload = {
    success: true,
    code: result.code,
  };
  if (result.evaluation) {
    payload.authoritySource = result.authoritySource;
    payload.confirmed = result.confirmed;
    payload.aggregate = result.aggregate;
    payload.evaluation = result.evaluation;
    if (result.evidence) payload.evidence = result.evidence;
    if (result.replayed) payload.replayed = true;
  }
  if (Array.isArray(result.evaluations)) {
    payload.evaluations = result.evaluations;
  }
  return res.status(result.status || 200).json(payload);
}

function createEvaluationHandlers({
  getPool,
  sendPublicDatabaseError,
  service = evaluationService,
}) {
  if (typeof getPool !== "function") {
    throw new TypeError("getPool must be a function.");
  }
  if (typeof sendPublicDatabaseError !== "function") {
    throw new TypeError("sendPublicDatabaseError must be a function.");
  }

  function handle(operation, action) {
    return async (req, res) => {
      try {
        return sendEvaluationResult(res, await action(req));
      } catch (error) {
        return sendPublicDatabaseError({
          res,
          error,
          operation,
          code: "EVALUATION_FAILED",
          message: "The Evaluation could not be completed.",
        });
      }
    };
  }

  return {
    createEvaluation: handle("create_evaluation", (req) =>
      service.createEvaluation({
        pool: getPool(req),
        authenticatedActor: req.user,
        sourceContext: req.body?.sourceContext,
        content: req.body?.content,
        expectedVersion: req.body?.expectedVersion,
        idempotencyKey: req.headers?.["idempotency-key"],
      })
    ),

    getEvaluation: handle("get_evaluation", (req) =>
      service.getEvaluation({
        pool: getPool(req),
        authenticatedActor: req.user,
        evaluationId: req.params.evaluationId,
      })
    ),

    updateEvaluationDraft: handle("update_evaluation_draft", (req) =>
      service.updateEvaluationDraft({
        pool: getPool(req),
        authenticatedActor: req.user,
        evaluationId: req.params.evaluationId,
        expectedVersion: req.body?.expectedVersion,
        content: req.body?.content,
        idempotencyKey: req.headers?.["idempotency-key"],
      })
    ),

    completeEvaluation: handle("complete_evaluation", (req) =>
      service.completeEvaluation({
        pool: getPool(req),
        authenticatedActor: req.user,
        evaluationId: req.params.evaluationId,
        expectedVersion: req.body?.expectedVersion,
        idempotencyKey: req.headers?.["idempotency-key"],
      })
    ),

    listEvaluationsForEmergencyRequest: handle(
      "list_emergency_evaluations",
      (req) =>
        service.listEvaluationsForEmergencyRequest({
          pool: getPool(req),
          authenticatedActor: req.user,
          emergencyRequestId: req.params.emergencyRequestId,
        })
    ),
  };
}

function registerEvaluationRoutes({
  app,
  authMiddleware,
  getPool,
  sendPublicDatabaseError,
  service = evaluationService,
}) {
  if (!app) throw new TypeError("An Express application is required.");
  if (typeof authMiddleware !== "function") {
    throw new TypeError("authMiddleware must be a function.");
  }

  const handlers = createEvaluationHandlers({
    getPool,
    sendPublicDatabaseError,
    service,
  });

  app.post("/evaluations", authMiddleware, handlers.createEvaluation);
  app.get(
    "/evaluations/:evaluationId",
    authMiddleware,
    handlers.getEvaluation
  );
  app.patch(
    "/evaluations/:evaluationId",
    authMiddleware,
    handlers.updateEvaluationDraft
  );
  app.post(
    "/evaluations/:evaluationId/complete",
    authMiddleware,
    handlers.completeEvaluation
  );
  app.get(
    "/emergency-requests/:emergencyRequestId/evaluations",
    authMiddleware,
    handlers.listEvaluationsForEmergencyRequest
  );

  return handlers;
}

module.exports = {
  createEvaluationHandlers,
  registerEvaluationRoutes,
  sendEvaluationResult,
};
