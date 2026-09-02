"use strict";

const workPreparationService = require("./workPreparationService");

function sendWorkPreparationResult(res, result) {
  if (!result?.ok) {
    return res.status(result?.status || 500).json({
      success: false,
      code: result?.code || "WORK_PREPARATION_FAILED",
      message: result?.message || "The Work Preparation operation could not be completed.",
    });
  }
  const payload = { success: true, code: result.code };
  for (const field of [
    "workPreparation", "purchase", "correction", "event", "evidence",
  ]) {
    if (result[field] !== undefined) payload[field] = result[field];
  }
  if (result.replayed) payload.replayed = true;
  return res.status(result.status || 200).json(payload);
}

function createWorkPreparationHandlers({
  getPool,
  sendPublicDatabaseError,
  service = workPreparationService,
} = {}) {
  if (typeof getPool !== "function" || typeof sendPublicDatabaseError !== "function") {
    throw new TypeError("Work Preparation route dependencies are required.");
  }
  const handle = (operation, action, { noStore = false } = {}) => async (req, res) => {
    if (noStore) res.setHeader?.("Cache-Control", "private, no-store");
    try {
      return sendWorkPreparationResult(res, await action(req));
    } catch (error) {
      return sendPublicDatabaseError({
        res,
        error,
        operation,
        code: "WORK_PREPARATION_FAILED",
        message: "The Work Preparation operation could not be completed.",
      });
    }
  };
  const common = (req) => ({
    pool: getPool(req),
    authenticatedActor: req.user,
    jobId: req.params.jobId,
  });
  const plan = (req) => ({ ...common(req), planId: req.params.planId });
  return {
    getPlan: handle(
      "get_work_preparation",
      (req) => service.getWorkPreparation(common(req)),
      { noStore: true }
    ),
    materialize: handle("materialize_work_preparation", (req) =>
      service.materializeWorkPreparation({
        ...common(req),
        approvedCustomerDecisionId: req.body?.approvedCustomerDecisionId,
      quoteApprovalId: req.body?.quoteApprovalId,
        idempotencyKey: req.headers?.["idempotency-key"],
      })
    ),
    revise: handle("revise_work_preparation", (req) =>
      service.reviseWorkPreparation({
        ...plan(req),
        expectedVersion: req.body?.expectedVersion,
        planningState: req.body?.planningState,
        workStartPolicy: req.body?.workStartPolicy,
        internalNotes: req.body?.internalNotes,
        items: req.body?.items,
        idempotencyKey: req.headers?.["idempotency-key"],
      })
    ),
    recordPurchase: handle("record_material_purchase", (req) =>
      service.recordMaterialPurchase({
        ...plan(req),
        itemId: req.params.itemId,
        expectedVersion: req.body?.expectedVersion,
        quantity: req.body?.quantity,
        unit: req.body?.unit,
        internalCostMinor: req.body?.internalCostMinor,
        internalCostCurrency: req.body?.internalCostCurrency,
        vendor: req.body?.vendor,
        purchasedAt: req.body?.purchasedAt,
        externalReference: req.body?.externalReference,
        visibility: req.body?.visibility,
        idempotencyKey: req.headers?.["idempotency-key"],
      })
    ),
    correctPurchase: handle("correct_material_purchase", (req) =>
      service.correctMaterialPurchase({
        ...plan(req),
        purchaseId: req.params.purchaseId,
        expectedVersion: req.body?.expectedVersion,
        reversedQuantity: req.body?.reversedQuantity,
        reversedInternalCostMinor: req.body?.reversedInternalCostMinor,
        reasonCategory: req.body?.reasonCategory,
        reason: req.body?.reason,
        correctedAt: req.body?.correctedAt,
        idempotencyKey: req.headers?.["idempotency-key"],
      })
    ),
    recordEvent: handle("record_work_preparation_event", (req) =>
      service.recordPreparationEvent({
        ...plan(req),
        itemId: req.body?.itemId,
        expectedVersion: req.body?.expectedVersion,
        eventType: req.body?.eventType,
        visibility: req.body?.visibility,
        customerVisibleNote: req.body?.customerVisibleNote,
        internalNote: req.body?.internalNote,
        idempotencyKey: req.headers?.["idempotency-key"],
      })
    ),
    attachEvidence: handle("attach_work_preparation_evidence", (req) =>
      service.attachEvidenceReference({
        ...plan(req),
        purchaseId: req.body?.purchaseId,
        purchaseCorrectionId: req.body?.purchaseCorrectionId,
        eventId: req.body?.eventId,
        evidenceType: req.body?.evidenceType,
        referenceNamespace: req.body?.referenceNamespace,
        referenceId: req.body?.referenceId,
        visibility: req.body?.visibility,
        idempotencyKey: req.headers?.["idempotency-key"],
      })
    ),
  };
}

function registerWorkPreparationRoutes({
  app,
  authMiddleware,
  getPool,
  sendPublicDatabaseError,
  service = workPreparationService,
} = {}) {
  if (!app || typeof app.get !== "function" || typeof app.post !== "function") {
    throw new TypeError("An Express application is required.");
  }
  if (typeof authMiddleware !== "function") {
    throw new TypeError("authMiddleware must be a function.");
  }
  const handlers = createWorkPreparationHandlers({
    getPool,
    sendPublicDatabaseError,
    service,
  });
  const root = "/jobs/:jobId/work-preparation";
  const plan = `${root}/:planId`;
  app.get(root, authMiddleware, handlers.getPlan);
  app.post(`${root}/materialize`, authMiddleware, handlers.materialize);
  app.post(`${plan}/revisions`, authMiddleware, handlers.revise);
  app.post(`${plan}/items/:itemId/purchases`, authMiddleware, handlers.recordPurchase);
  app.post(
    `${plan}/purchases/:purchaseId/corrections`,
    authMiddleware,
    handlers.correctPurchase
  );
  app.post(`${plan}/events`, authMiddleware, handlers.recordEvent);
  app.post(`${plan}/evidence-references`, authMiddleware, handlers.attachEvidence);
  return handlers;
}

module.exports = {
  createWorkPreparationHandlers,
  registerWorkPreparationRoutes,
  sendWorkPreparationResult,
};
