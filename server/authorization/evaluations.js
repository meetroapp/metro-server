"use strict";

const evaluationService = require("./evaluationService");
const findingService = require("./findingService");

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
  if (result.finding) payload.finding = result.finding;
  if (Array.isArray(result.findings)) payload.findings = result.findings;
  if (result.concernLinkId) payload.concernLinkId = result.concernLinkId;
  if (result.evidenceReferenceId) {
    payload.evidenceReferenceId = result.evidenceReferenceId;
  }
  if (result.replayed) payload.replayed = true;
  return res.status(result.status || 200).json(payload);
}

function createEvaluationHandlers({
  getPool,
  sendPublicDatabaseError,
  service = evaluationService,
  findingAuthority = findingService,
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
    createOrdinaryJobEvaluation: handle("create_ordinary_job_evaluation", (req) =>
      service.createOrdinaryJobEvaluation({
        pool: getPool(req),
        authenticatedActor: req.user,
        jobId: req.params.jobId,
        visitId: req.body?.visitId,
        content: req.body?.content,
        expectedVersion: req.body?.expectedVersion,
        idempotencyKey: req.headers?.["idempotency-key"],
      })
    ),

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

    reviseEvaluation: handle("revise_evaluation", (req) =>
      service.reviseEvaluation({
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
        completionMode: req.body?.completionMode,
        assessmentMethod: req.body?.assessmentMethod,
        assessmentBasis: req.body?.assessmentBasis,
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

    listEvaluationsForJob: handle("list_job_evaluations", (req) =>
      service.listEvaluationsForJob({
        pool: getPool(req),
        authenticatedActor: req.user,
        jobId: req.params.jobId,
      })
    ),

    submitFinding: handle("submit_finding", (req) =>
      findingAuthority.submitFinding({
        pool: getPool(req),
        authenticatedActor: req.user,
        evaluationId: req.params.evaluationId,
        statement: req.body?.statement,
        customerVisible: req.body?.customerVisible,
        idempotencyKey: req.headers?.["idempotency-key"],
      })
    ),

    updateFinding: handle("update_finding", (req) =>
      findingAuthority.updateFinding({
        pool: getPool(req),
        authenticatedActor: req.user,
        findingId: req.params.findingId,
        expectedVersion: req.body?.expectedVersion,
        statement: req.body?.statement,
        customerVisible: req.body?.customerVisible,
        idempotencyKey: req.headers?.["idempotency-key"],
      })
    ),

    listEvaluationFindings: handle("list_evaluation_findings", (req) =>
      findingAuthority.listEvaluationFindings({
        pool: getPool(req),
        authenticatedActor: req.user,
        evaluationId: req.params.evaluationId,
      })
    ),

    getFinding: handle("get_finding", (req) =>
      findingAuthority.getFinding({
        pool: getPool(req),
        authenticatedActor: req.user,
        findingId: req.params.findingId,
      })
    ),

    linkFindingConcern: handle("link_finding_concern", (req) =>
      findingAuthority.linkFindingConcern({
        pool: getPool(req),
        authenticatedActor: req.user,
        findingId: req.params.findingId,
        concernId: req.body?.concernId,
        relationshipType: req.body?.relationshipType,
        idempotencyKey: req.headers?.["idempotency-key"],
      })
    ),

    addFindingEvidenceReference: handle("add_finding_evidence", (req) =>
      findingAuthority.addFindingEvidenceReference({
        pool: getPool(req),
        authenticatedActor: req.user,
        findingId: req.params.findingId,
        evidenceType: req.body?.evidenceType,
        referenceNamespace: req.body?.referenceNamespace,
        referenceId: req.body?.referenceId,
        idempotencyKey: req.headers?.["idempotency-key"],
      })
    ),

    confirmFinding: handle("confirm_finding", (req) =>
      findingAuthority.confirmFinding({
        pool: getPool(req),
        authenticatedActor: req.user,
        findingId: req.params.findingId,
        expectedVersion: req.body?.expectedVersion,
        idempotencyKey: req.headers?.["idempotency-key"],
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
  findingAuthority = findingService,
}) {
  if (!app) throw new TypeError("An Express application is required.");
  if (typeof authMiddleware !== "function") {
    throw new TypeError("authMiddleware must be a function.");
  }

  const handlers = createEvaluationHandlers({
    getPool,
    sendPublicDatabaseError,
    service,
    findingAuthority,
  });

  app.post(
    "/jobs/:jobId/evaluations",
    authMiddleware,
    handlers.createOrdinaryJobEvaluation
  );
  app.get(
    "/jobs/:jobId/evaluations",
    authMiddleware,
    handlers.listEvaluationsForJob
  );
  app.post(
    "/evaluations/:evaluationId/findings",
    authMiddleware,
    handlers.submitFinding
  );
  app.get(
    "/evaluations/:evaluationId/findings",
    authMiddleware,
    handlers.listEvaluationFindings
  );
  app.get(
    "/findings/:findingId",
    authMiddleware,
    handlers.getFinding
  );
  app.patch(
    "/findings/:findingId",
    authMiddleware,
    handlers.updateFinding
  );
  app.post(
    "/findings/:findingId/concern-links",
    authMiddleware,
    handlers.linkFindingConcern
  );
  app.post(
    "/findings/:findingId/evidence-references",
    authMiddleware,
    handlers.addFindingEvidenceReference
  );
  app.post(
    "/findings/:findingId/confirm",
    authMiddleware,
    handlers.confirmFinding
  );
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
    "/evaluations/:evaluationId/revisions",
    authMiddleware,
    handlers.reviseEvaluation
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
