"use strict";

const evaluationVisitService = require("./evaluationVisitService");
const visitService = require("./visitService");

function sendEvaluationVisitResult(res, result) {
  if (!result?.ok) {
    return res.status(result?.status || 500).json({
      success: false,
      code: result?.code || "EVALUATION_VISIT_FAILED",
      message:
        result?.message || "The Evaluation Visit operation could not be completed.",
    });
  }
  const payload = { success: true, code: result.code };
  for (const field of ["authority", "visit", "visits", "actions"]) {
    if (result[field] !== undefined) payload[field] = result[field];
  }
  if (result.replayed) payload.replayed = true;
  return res.status(result.status || 200).json(payload);
}

function createEvaluationVisitHandlers({
  getPool,
  sendPublicDatabaseError,
  authorityService = evaluationVisitService,
  canonicalVisitService = visitService,
} = {}) {
  if (typeof getPool !== "function") {
    throw new TypeError("getPool must be a function.");
  }
  if (typeof sendPublicDatabaseError !== "function") {
    throw new TypeError("sendPublicDatabaseError must be a function.");
  }

  function handle(operation, action, { noStore = false } = {}) {
    return async (req, res) => {
      if (noStore) res.setHeader?.("Cache-Control", "private, no-store");
      try {
        return sendEvaluationVisitResult(res, await action(req));
      } catch (error) {
        return sendPublicDatabaseError({
          res,
          error,
          operation,
          code: "EVALUATION_VISIT_FAILED",
          message: "The Evaluation Visit operation could not be completed.",
        });
      }
    };
  }

  const subject = (req) => ({
    pool: getPool(req),
    authenticatedActor: req.user,
    jobId: req.params.jobId,
    evaluationId: req.params.evaluationId,
  });

  return {
    getAuthority: handle(
      "get_evaluation_visit_authority",
      (req) => authorityService.getEvaluationVisitAuthority(subject(req)),
      { noStore: true }
    ),
    activateAuthority: handle(
      "activate_evaluation_visit_authority",
      (req) => authorityService.activateEvaluationVisitAuthority({
        ...subject(req),
        idempotencyKey: req.headers?.["idempotency-key"],
      })
    ),
    listVisits: handle(
      "list_evaluation_visits",
      (req) => canonicalVisitService.listEvaluationVisits(subject(req)),
      { noStore: true }
    ),
    getVisit: handle(
      "get_evaluation_visit",
      (req) => canonicalVisitService.getEvaluationVisit({
        ...subject(req),
        visitId: req.params.visitId,
      }),
      { noStore: true }
    ),
  };
}

function registerEvaluationVisitRoutes({
  app,
  authMiddleware,
  getPool,
  sendPublicDatabaseError,
  authorityService = evaluationVisitService,
  canonicalVisitService = visitService,
} = {}) {
  if (!app || typeof app.get !== "function" || typeof app.post !== "function") {
    throw new TypeError("An Express application is required.");
  }
  if (typeof authMiddleware !== "function") {
    throw new TypeError("authMiddleware must be a function.");
  }
  const handlers = createEvaluationVisitHandlers({
    getPool,
    sendPublicDatabaseError,
    authorityService,
    canonicalVisitService,
  });
  const base = "/jobs/:jobId/evaluations/:evaluationId";
  app.get(`${base}/visit-authority`, authMiddleware, handlers.getAuthority);
  app.post(`${base}/visit-authority`, authMiddleware, handlers.activateAuthority);
  app.get(`${base}/visits`, authMiddleware, handlers.listVisits);
  app.get(`${base}/visits/:visitId`, authMiddleware, handlers.getVisit);
  return handlers;
}

module.exports = {
  createEvaluationVisitHandlers,
  registerEvaluationVisitRoutes,
  sendEvaluationVisitResult,
};
