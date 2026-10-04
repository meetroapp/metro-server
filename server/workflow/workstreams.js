"use strict";

const workstreamService = require("./workstreamService");

function sendWorkflowResult(res, result) {
  if (!result || result.ok !== true) {
    const payload = {
      success: false,
      code: result?.code || "WORKFLOW_FAILED",
      message: result?.message || "The workflow operation could not be completed.",
    };
    if (result?.reasons !== undefined) payload.reasons = result.reasons;
    if (result?.eligibility !== undefined) payload.eligibility = result.eligibility;
    return res.status(result?.status || 500).json(payload);
  }
  const payload = {
    success: true,
    code: result.code,
  };
  for (const field of [
    "workstream",
    "workstreams",
    "assignment",
    "activity",
    "activities",
    "obligation",
    "obligations",
    "finding",
    "resolutionEvent",
    "eligibility",
    "approvedWorkStart",
    "approvedWorkStartEvent",
  ]) {
    if (result[field] !== undefined) payload[field] = result[field];
  }
  if (result.replayed) payload.replayed = true;
  return res.status(result.status || 200).json(payload);
}

function createWorkstreamHandlers({
  getPool,
  sendPublicDatabaseError,
  service = workstreamService,
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
        return sendWorkflowResult(res, await action(req));
      } catch (error) {
        return sendPublicDatabaseError({
          res,
          error,
          operation,
          code: "WORKFLOW_FAILED",
          message: "The workflow operation could not be completed.",
        });
      }
    };
  }

  const common = (req) => ({
    pool: getPool(req),
    authenticatedActor: req.user,
    jobId: req.params.jobId,
  });
  const workstream = (req) => ({
    ...common(req),
    workstreamId: req.params.workstreamId,
  });

  return {
    createWorkstream: handle("create_workstream", (req) =>
      service.createWorkstream({
        ...common(req),
        title: req.body?.title,
        sequence: req.body?.sequence,
        idempotencyKey: req.headers?.["idempotency-key"],
      })
    ),
    listWorkstreams: handle("list_workstreams", (req) =>
      service.listWorkstreams(common(req))
    ),
    getWorkstream: handle("get_workstream", (req) =>
      service.getWorkstream(workstream(req))
    ),
    assignFinding: handle("assign_finding_workstream", (req) =>
      service.assignFindingToWorkstream({
        ...workstream(req),
        findingId: req.params.findingId,
        idempotencyKey: req.headers?.["idempotency-key"],
      })
    ),
    createActivity: handle("create_work_activity", (req) =>
      service.createWorkActivity({
        ...workstream(req),
        activityType: req.body?.activityType,
        statement: req.body?.statement,
        temporaryIntervention: req.body?.temporaryIntervention,
        temporaryDetails: req.body?.temporaryDetails,
        customerVisible: req.body?.customerVisible,
        idempotencyKey: req.headers?.["idempotency-key"],
      })
    ),
    listActivities: handle("list_work_activities", (req) =>
      service.listWorkActivities(workstream(req))
    ),
    getActivity: handle("get_work_activity", (req) =>
      service.getWorkActivity({
        ...workstream(req),
        activityId: req.params.activityId,
      })
    ),
    progressActivity: handle("progress_work_activity", (req) =>
      service.progressWorkActivity({
        ...workstream(req),
        activityId: req.params.activityId,
        expectedVersion: req.body?.expectedVersion,
        targetStatus: req.body?.targetStatus,
        ...(req.body?.approvedWorkExecutionId !== undefined
          ? { approvedWorkExecutionId: req.body.approvedWorkExecutionId }
          : {}),
        ...(req.body?.expectedExecutionVersion !== undefined
          ? { expectedExecutionVersion: req.body.expectedExecutionVersion }
          : {}),
        idempotencyKey: req.headers?.["idempotency-key"],
      })
    ),
    updateActivity: handle("update_work_activity", (req) =>
      service.updateWorkActivity({
        ...workstream(req),
        activityId: req.params.activityId,
        expectedVersion: req.body?.expectedVersion,
        statement: req.body?.statement,
        customerVisible: req.body?.customerVisible,
        idempotencyKey: req.headers?.["idempotency-key"],
      })
    ),
    createObligation: handle("create_work_obligation", (req) =>
      service.createWorkObligation({
        ...workstream(req),
        sequence: req.body?.sequence,
        statement: req.body?.statement,
        sourceFindingId: req.body?.sourceFindingId,
        idempotencyKey: req.headers?.["idempotency-key"],
      })
    ),
    listObligations: handle("list_work_obligations", (req) =>
      service.listWorkObligations(workstream(req))
    ),
    getObligation: handle("get_work_obligation", (req) =>
      service.getWorkObligation({
        ...workstream(req),
        obligationId: req.params.obligationId,
      })
    ),
    resolveFinding: handle("resolve_finding", (req) =>
      service.resolveFinding({
        ...common(req),
        findingId: req.params.findingId,
        expectedVersion: req.body?.expectedVersion,
        expectedResolutionState: req.body?.expectedResolutionState,
        targetResolutionState: req.body?.targetResolutionState,
        resolutionStatement: req.body?.resolutionStatement,
        idempotencyKey: req.headers?.["idempotency-key"],
      })
    ),
    transitionObligation: handle("transition_work_obligation", (req) =>
      service.transitionWorkObligation({
        ...workstream(req),
        obligationId: req.params.obligationId,
        expectedVersion: req.body?.expectedVersion,
        targetStatus: req.body?.targetStatus,
        idempotencyKey: req.headers?.["idempotency-key"],
      })
    ),
    getCompletionEligibility: handle("get_workstream_completion_eligibility", (req) =>
      service.getWorkstreamCompletionEligibility(workstream(req))
    ),
    completeWorkstream: handle("complete_workstream", (req) =>
      service.completeWorkstream({
        ...workstream(req),
        expectedVersion: req.body?.expectedVersion,
        idempotencyKey: req.headers?.["idempotency-key"],
      })
    ),
  };
}

function registerWorkstreamRoutes({
  app,
  authMiddleware,
  getPool,
  sendPublicDatabaseError,
  service = workstreamService,
}) {
  if (!app) throw new TypeError("An Express application is required.");
  if (typeof authMiddleware !== "function") {
    throw new TypeError("authMiddleware must be a function.");
  }
  const handlers = createWorkstreamHandlers({
    getPool,
    sendPublicDatabaseError,
    service,
  });

  app.post("/jobs/:jobId/workstreams", authMiddleware, handlers.createWorkstream);
  app.get("/jobs/:jobId/workstreams", authMiddleware, handlers.listWorkstreams);
  app.get(
    "/jobs/:jobId/workstreams/:workstreamId",
    authMiddleware,
    handlers.getWorkstream
  );
  app.post(
    "/jobs/:jobId/workstreams/:workstreamId/findings/:findingId/assignment",
    authMiddleware,
    handlers.assignFinding
  );
  app.post(
    "/jobs/:jobId/workstreams/:workstreamId/activities",
    authMiddleware,
    handlers.createActivity
  );
  app.get(
    "/jobs/:jobId/workstreams/:workstreamId/activities",
    authMiddleware,
    handlers.listActivities
  );
  app.get(
    "/jobs/:jobId/workstreams/:workstreamId/activities/:activityId",
    authMiddleware,
    handlers.getActivity
  );
  app.post(
    "/jobs/:jobId/workstreams/:workstreamId/activities/:activityId/progress",
    authMiddleware,
    handlers.progressActivity
  );
  app.post(
    "/jobs/:jobId/workstreams/:workstreamId/activities/:activityId/update",
    authMiddleware,
    handlers.updateActivity
  );
  app.post(
    "/jobs/:jobId/workstreams/:workstreamId/obligations",
    authMiddleware,
    handlers.createObligation
  );
  app.get(
    "/jobs/:jobId/workstreams/:workstreamId/obligations",
    authMiddleware,
    handlers.listObligations
  );
  app.get(
    "/jobs/:jobId/workstreams/:workstreamId/obligations/:obligationId",
    authMiddleware,
    handlers.getObligation
  );
  app.post(
    "/jobs/:jobId/findings/:findingId/resolve",
    authMiddleware,
    handlers.resolveFinding
  );
  app.post(
    "/jobs/:jobId/workstreams/:workstreamId/obligations/:obligationId/transition",
    authMiddleware,
    handlers.transitionObligation
  );
  app.get(
    "/jobs/:jobId/workstreams/:workstreamId/completion-eligibility",
    authMiddleware,
    handlers.getCompletionEligibility
  );
  app.post(
    "/jobs/:jobId/workstreams/:workstreamId/complete",
    authMiddleware,
    handlers.completeWorkstream
  );

  return handlers;
}

module.exports = {
  createWorkstreamHandlers,
  registerWorkstreamRoutes,
  sendWorkflowResult,
};
