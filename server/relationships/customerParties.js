"use strict";

const service = require("./customerPartyService");

function sendResult(res, result) {
  res.setHeader?.("Cache-Control", "private, no-store");
  return res.status(result?.status || 500).json({
    success: result?.ok === true,
    code: result?.code || "CUSTOMER_PARTY_FAILED",
    ...(result?.message ? { message: result.message } : {}),
    ...(result?.customerParty ? { customerParty: result.customerParty } : {}),
    ...(result?.replayed ? { replayed: true } : {}),
  });
}

function createCustomerPartyHandlers({
  getPool,
  sendPublicDatabaseError,
  customerPartyService = service,
} = {}) {
  if (typeof getPool !== "function") throw new TypeError("getPool must be a function.");
  if (typeof sendPublicDatabaseError !== "function") {
    throw new TypeError("sendPublicDatabaseError must be a function.");
  }
  const handle = (operation, action) => async (req, res) => {
    try {
      return sendResult(res, await action(req));
    } catch (error) {
      return sendPublicDatabaseError({
        res,
        error,
        operation,
        code: "CUSTOMER_PARTY_FAILED",
        message: "The customer link operation could not be completed.",
      });
    }
  };
  return {
    linkJob: handle("link_job_customer_party", (req) =>
      customerPartyService.linkJobCustomerParty({
        pool: getPool(req),
        authenticatedActor: req.user,
        jobId: req.params.jobId,
        payload: req.body,
        idempotencyKey: req.headers?.["idempotency-key"],
      })),
    getJob: handle("get_job_customer_party", (req) =>
      customerPartyService.getJobCustomerParty({
        pool: getPool(req),
        authenticatedActor: req.user,
        jobId: req.params.jobId,
      })),
  };
}

function registerCustomerPartyRoutes({
  app,
  authMiddleware,
  getPool,
  sendPublicDatabaseError,
  customerPartyService = service,
} = {}) {
  if (!app) throw new TypeError("An Express application is required.");
  if (typeof authMiddleware !== "function") {
    throw new TypeError("authMiddleware must be a function.");
  }
  const handlers = createCustomerPartyHandlers({
    getPool,
    sendPublicDatabaseError,
    customerPartyService,
  });
  app.post("/jobs/:jobId/customer-party", authMiddleware, handlers.linkJob);
  app.get("/jobs/:jobId/customer-party", authMiddleware, handlers.getJob);
  return handlers;
}

module.exports = {
  createCustomerPartyHandlers,
  registerCustomerPartyRoutes,
  sendCustomerPartyResult: sendResult,
};

