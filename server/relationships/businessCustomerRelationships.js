"use strict";

const service = require("./businessCustomerRelationshipService");

function sendResult(res, result) {
  const payload = {
    success: result?.ok === true,
    code: result?.code || "BUSINESS_CUSTOMER_RELATIONSHIP_FAILED",
  };
  if (result?.message) payload.message = result.message;
  if (result?.activity !== undefined) payload.activity = result.activity;
  if (result?.relationship !== undefined) payload.relationship = result.relationship;
  if (result?.relationships !== undefined) payload.relationships = result.relationships;
  if (result?.replayed) payload.replayed = true;
  res.setHeader?.("Cache-Control", "private, no-store");
  return res.status(result?.status || 500).json(payload);
}

function createBusinessCustomerRelationshipHandlers({
  getPool,
  sendPublicDatabaseError,
  relationshipService = service,
} = {}) {
  if (typeof getPool !== "function") throw new TypeError("getPool must be a function.");
  if (typeof sendPublicDatabaseError !== "function") {
    throw new TypeError("sendPublicDatabaseError must be a function.");
  }

  function handle(operation, action) {
    return async (req, res) => {
      try {
        return sendResult(res, await action(req));
      } catch (error) {
        return sendPublicDatabaseError({
          res,
          error,
          operation,
          code: "BUSINESS_CUSTOMER_RELATIONSHIP_FAILED",
          message: "The Customer Relationship operation could not be completed.",
        });
      }
    };
  }

  return {
    establish: handle("establish_business_customer_relationship", (req) =>
      relationshipService.establishBusinessCustomerRelationship({
        pool: getPool(req),
        authenticatedActor: req.user,
        payload: req.body,
        idempotencyKey: req.headers?.["idempotency-key"],
      })
    ),
    list: handle("list_business_customer_relationships", (req) =>
      relationshipService.listBusinessCustomerRelationships({
        pool: getPool(req),
        authenticatedActor: req.user,
        query: {
          contractorProfileId: req.query?.contractorProfileId,
          limit: req.query?.limit,
        },
      })
    ),
    getByContact: handle("get_business_customer_relationship_by_contact", (req) =>
      relationshipService.getBusinessCustomerRelationshipByContact({
        pool: getPool(req),
        authenticatedActor: req.user,
        businessContactId: req.params.businessContactId,
      })
    ),
    getActivity: handle("get_business_customer_relationship_activity", (req) =>
      relationshipService.getBusinessCustomerRelationshipActivity({
        pool: getPool(req),
        authenticatedActor: req.user,
        relationshipId: req.params.relationshipId,
      })
    ),
    get: handle("get_business_customer_relationship", (req) =>
      relationshipService.getBusinessCustomerRelationship({
        pool: getPool(req),
        authenticatedActor: req.user,
        relationshipId: req.params.relationshipId,
      })
    ),
  };
}

function registerBusinessCustomerRelationshipRoutes({
  app,
  authMiddleware,
  getPool,
  sendPublicDatabaseError,
  relationshipService = service,
} = {}) {
  if (!app) throw new TypeError("An Express application is required.");
  if (typeof authMiddleware !== "function") {
    throw new TypeError("authMiddleware must be a function.");
  }
  const handlers = createBusinessCustomerRelationshipHandlers({
    getPool,
    sendPublicDatabaseError,
    relationshipService,
  });
  app.post("/business-customer-relationships", authMiddleware, handlers.establish);
  app.get("/business-customer-relationships", authMiddleware, handlers.list);
  app.get(
    "/business-customer-relationships/by-contact/:businessContactId",
    authMiddleware,
    handlers.getByContact
  );
  app.get(
    "/business-customer-relationships/:relationshipId/activity",
    authMiddleware,
    handlers.getActivity
  );
  app.get(
    "/business-customer-relationships/:relationshipId",
    authMiddleware,
    handlers.get
  );
  return handlers;
}

module.exports = {
  createBusinessCustomerRelationshipHandlers,
  registerBusinessCustomerRelationshipRoutes,
  sendBusinessCustomerRelationshipResult: sendResult,
};
