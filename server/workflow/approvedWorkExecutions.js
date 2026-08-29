"use strict";

const approvedWorkExecutionService = require("./approvedWorkExecutionService");

function sendApprovedWorkExecutionResult(res, result) {
  if (!result?.ok) {
    return res.status(result?.status || 500).json({
      success: false,
      code: result?.code || "APPROVED_WORK_EXECUTION_FAILED",
      message: result?.message || "The Approved Work execution operation could not be completed.",
    });
  }
  const payload = { success: true, code: result.code };
  for (const field of [
    "execution",
    "executions",
    "binding",
    "classification",
    "reconciliation",
  ]) {
    if (result[field] !== undefined) payload[field] = result[field];
  }
  if (result.replayed) payload.replayed = true;
  return res.status(result.status || 200).json(payload);
}

function createApprovedWorkExecutionHandlers({
  getPool,
  sendPublicDatabaseError,
  service = approvedWorkExecutionService,
} = {}) {
  if (typeof getPool !== "function" || typeof sendPublicDatabaseError !== "function") {
    throw new TypeError("Approved Work execution route dependencies are required.");
  }
  const handle = (operation, action, { noStore = false } = {}) => async (req, res) => {
    if (noStore) res.setHeader?.("Cache-Control", "private, no-store");
    try {
      return sendApprovedWorkExecutionResult(res, await action(req));
    } catch (error) {
      return sendPublicDatabaseError({
        res,
        error,
        operation,
        code: "APPROVED_WORK_EXECUTION_FAILED",
        message: "The Approved Work execution operation could not be completed.",
      });
    }
  };
  const common = (req) => ({
    pool: getPool(req),
    authenticatedActor: req.user,
    jobId: req.params.jobId,
  });
  const execution = (req) => ({
    ...common(req),
    executionId: req.params.executionId,
  });
  return {
    list: handle(
      "list_approved_work_executions",
      (req) => service.listApprovedWorkExecutions(common(req)),
      { noStore: true }
    ),
    get: handle(
      "get_approved_work_execution",
      (req) => service.getApprovedWorkExecution(execution(req)),
      { noStore: true }
    ),
    materialize: handle("materialize_approved_work_execution", (req) =>
      service.materializeApprovedWorkExecution({
        ...common(req),
        approvedCustomerDecisionId: req.body?.approvedCustomerDecisionId,
        idempotencyKey: req.headers?.["idempotency-key"],
      })
    ),
    bindWorkstream: handle("bind_approved_work_execution_workstream", (req) =>
      service.bindWorkstreamToExecution({
        ...execution(req),
        workstreamId: req.params.workstreamId,
        expectedExecutionVersion: req.body?.expectedExecutionVersion,
        idempotencyKey: req.headers?.["idempotency-key"],
      })
    ),
    classifyActivity: handle("classify_approved_work_execution_activity", (req) =>
      service.classifyWorkActivity({
        ...execution(req),
        workstreamId: req.body?.workstreamId,
        activityId: req.params.activityId,
        expectedExecutionVersion: req.body?.expectedExecutionVersion,
        expectedActivityVersion: req.body?.expectedActivityVersion,
        classification: req.body?.classification,
        scopeBasis: req.body?.scopeBasis,
        sourceScopeItemId: req.body?.sourceScopeItemId,
        idempotencyKey: req.headers?.["idempotency-key"],
      })
    ),
    reconcileLegacy: handle("reconcile_legacy_approved_work_execution", (req) =>
      service.reconcileLegacyExecution({
        ...execution(req),
        workstreamId: req.body?.workstreamId,
        expectedExecutionVersion: req.body?.expectedExecutionVersion,
        reason: req.body?.reason,
        bindWorkstream: req.body?.bindWorkstream,
        activities: req.body?.activities,
        idempotencyKey: req.headers?.["idempotency-key"],
      })
    ),
    supersede: handle("supersede_approved_work_execution", (req) =>
      service.supersedeApprovedWorkExecution({
        ...execution(req),
        expectedVersion: req.body?.expectedVersion,
        successorExecutionId: req.body?.successorExecutionId,
        idempotencyKey: req.headers?.["idempotency-key"],
      })
    ),
    close: handle("close_approved_work_execution", (req) =>
      service.closeApprovedWorkExecution({
        ...execution(req),
        expectedVersion: req.body?.expectedVersion,
        idempotencyKey: req.headers?.["idempotency-key"],
      })
    ),
  };
}

function registerApprovedWorkExecutionRoutes({
  app,
  authMiddleware,
  getPool,
  sendPublicDatabaseError,
  service = approvedWorkExecutionService,
} = {}) {
  if (!app || typeof app.get !== "function" || typeof app.post !== "function") {
    throw new TypeError("An Express application is required.");
  }
  if (typeof authMiddleware !== "function") {
    throw new TypeError("authMiddleware must be a function.");
  }
  const handlers = createApprovedWorkExecutionHandlers({
    getPool,
    sendPublicDatabaseError,
    service,
  });
  const root = "/jobs/:jobId/approved-work-executions";
  const execution = `${root}/:executionId`;
  app.get(root, authMiddleware, handlers.list);
  app.get(execution, authMiddleware, handlers.get);
  app.post(`${root}/materialize`, authMiddleware, handlers.materialize);
  app.post(
    `${execution}/workstreams/:workstreamId`,
    authMiddleware,
    handlers.bindWorkstream
  );
  app.post(
    `${execution}/activities/:activityId/classification`,
    authMiddleware,
    handlers.classifyActivity
  );
  app.post(`${execution}/legacy-reconciliation`, authMiddleware, handlers.reconcileLegacy);
  app.post(`${execution}/supersede`, authMiddleware, handlers.supersede);
  app.post(`${execution}/close`, authMiddleware, handlers.close);
  return handlers;
}

module.exports = {
  createApprovedWorkExecutionHandlers,
  registerApprovedWorkExecutionRoutes,
  sendApprovedWorkExecutionResult,
};
