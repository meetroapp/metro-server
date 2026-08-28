"use strict";

const preWorkDepositService = require("./preWorkDepositService");

function sendPreWorkDepositResult(res, result) {
  if (!result?.ok) {
    return res.status(result?.status || 500).json({
      success: false,
      code: result?.code || "PRE_WORK_DEPOSIT_FAILED",
      message: result?.message || "The deposit operation could not be completed.",
    });
  }
  const payload = { success: true, code: result.code };
  for (const field of ["deposit", "payment", "reversal", "commercialException"]) {
    if (result[field] !== undefined) payload[field] = result[field];
  }
  if (result.replayed) payload.replayed = true;
  return res.status(result.status || 200).json(payload);
}

function createPreWorkDepositHandlers({
  getPool,
  sendPublicDatabaseError,
  service = preWorkDepositService,
} = {}) {
  if (typeof getPool !== "function" || typeof sendPublicDatabaseError !== "function") {
    throw new TypeError("Pre-work deposit route dependencies are required.");
  }
  function handle(operation, action, { noStore = false } = {}) {
    return async (req, res) => {
      if (noStore) res.setHeader?.("Cache-Control", "private, no-store");
      try {
        return sendPreWorkDepositResult(res, await action(req));
      } catch (error) {
        return sendPublicDatabaseError({
          res,
          error,
          operation,
          code: "PRE_WORK_DEPOSIT_FAILED",
          message: "The deposit operation could not be completed.",
        });
      }
    };
  }
  const common = (req) => ({
    pool: getPool(req),
    authenticatedActor: req.user,
    jobId: req.params.jobId,
  });
  return {
    getStatus: handle(
      "get_pre_work_deposit",
      (req) => service.getProfessionalDepositStatus(common(req)),
      { noStore: true }
    ),
    materialize: handle(
      "materialize_pre_work_deposit",
      (req) => service.materializePreWorkDepositObligation({
        ...common(req),
        idempotencyKey: req.headers?.["idempotency-key"],
      })
    ),
    confirmReceived: handle(
      "confirm_pre_work_deposit_received",
      (req) => service.confirmDepositReceived({
        ...common(req),
        amountMinor: req.body?.amountMinor,
        currency: req.body?.currency,
        normalizedMethod: req.body?.normalizedMethod,
        displayMethod: req.body?.displayMethod,
        externalReference: req.body?.externalReference,
        receivedAt: req.body?.receivedAt,
        expectedVersion: req.body?.expectedVersion,
        idempotencyKey: req.headers?.["idempotency-key"],
      })
    ),
    reverseAllocation: handle(
      "reverse_pre_work_deposit_allocation",
      (req) => service.reverseDepositAllocation({
        ...common(req),
        allocationId: req.params.allocationId,
        amountMinor: req.body?.amountMinor,
        reasonCategory: req.body?.reasonCategory,
        reason: req.body?.reason,
        expectedVersion: req.body?.expectedVersion,
        idempotencyKey: req.headers?.["idempotency-key"],
      })
    ),
  };
}

function registerPreWorkDepositRoutes({
  app,
  authMiddleware,
  getPool,
  sendPublicDatabaseError,
  service = preWorkDepositService,
} = {}) {
  if (!app || typeof app.get !== "function" || typeof app.post !== "function") {
    throw new TypeError("An Express application is required.");
  }
  if (typeof authMiddleware !== "function") {
    throw new TypeError("authMiddleware must be a function.");
  }
  const handlers = createPreWorkDepositHandlers({
    getPool,
    sendPublicDatabaseError,
    service,
  });
  const route = "/jobs/:jobId/pre-work-deposit";
  app.get(route, authMiddleware, handlers.getStatus);
  app.post(`${route}/materialize`, authMiddleware, handlers.materialize);
  app.post(`${route}/payments`, authMiddleware, handlers.confirmReceived);
  app.post(
    `${route}/allocations/:allocationId/reversals`,
    authMiddleware,
    handlers.reverseAllocation
  );
  return handlers;
}

module.exports = {
  createPreWorkDepositHandlers,
  registerPreWorkDepositRoutes,
  sendPreWorkDepositResult,
};
