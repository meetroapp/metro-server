"use strict";

const service = require("./businessContactService");

function sendResult(res, result) {
  const payload = {
    success: result?.ok === true,
    code: result?.code || "BUSINESS_CONTACT_FAILED",
  };
  if (result?.message) payload.message = result.message;
  if (result?.contact !== undefined) payload.contact = result.contact;
  if (result?.contacts !== undefined) payload.contacts = result.contacts;
  if (result?.duplicateCandidates !== undefined) {
    payload.duplicateCandidates = result.duplicateCandidates;
  }
  if (result?.currentVersion !== undefined) payload.currentVersion = result.currentVersion;
  if (result?.replayed) payload.replayed = true;
  res.setHeader?.("Cache-Control", "private, no-store");
  return res.status(result?.status || 500).json(payload);
}

function createBusinessContactHandlers({
  getPool,
  sendPublicDatabaseError,
  contactService = service,
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
          code: "BUSINESS_CONTACT_FAILED",
          message: "The Contact operation could not be completed.",
        });
      }
    };
  }

  return {
    create: handle("create_business_contact", (req) =>
      contactService.createBusinessContact({
        pool: getPool(req),
        authenticatedActor: req.user,
        payload: req.body,
        idempotencyKey: req.headers?.["idempotency-key"],
      })
    ),
    get: handle("get_business_contact", (req) =>
      contactService.getBusinessContact({
        pool: getPool(req),
        authenticatedActor: req.user,
        contactId: req.params.contactId,
      })
    ),
    list: handle("list_business_contacts", (req) =>
      contactService.listBusinessContacts({
        pool: getPool(req),
        authenticatedActor: req.user,
        query: {
          contractorProfileId: req.query?.contractorProfileId,
          search: req.query?.search,
          status: req.query?.status,
          role: req.query?.role,
          limit: req.query?.limit,
        },
      })
    ),
    update: handle("update_business_contact", (req) =>
      contactService.updateBusinessContact({
        pool: getPool(req),
        authenticatedActor: req.user,
        contactId: req.params.contactId,
        payload: req.body,
        idempotencyKey: req.headers?.["idempotency-key"],
      })
    ),
    assignRole: handle("assign_business_contact_role", (req) =>
      contactService.assignBusinessContactRole({
        pool: getPool(req),
        authenticatedActor: req.user,
        contactId: req.params.contactId,
        payload: req.body,
        idempotencyKey: req.headers?.["idempotency-key"],
      })
    ),
    endRole: handle("end_business_contact_role", (req) =>
      contactService.endBusinessContactRole({
        pool: getPool(req),
        authenticatedActor: req.user,
        contactId: req.params.contactId,
        roleId: req.params.roleId,
        payload: req.body,
        idempotencyKey: req.headers?.["idempotency-key"],
      })
    ),
    archive: handle("archive_business_contact", (req) =>
      contactService.archiveBusinessContact({
        pool: getPool(req),
        authenticatedActor: req.user,
        contactId: req.params.contactId,
        payload: req.body,
        idempotencyKey: req.headers?.["idempotency-key"],
      })
    ),
  };
}

function registerBusinessContactRoutes({
  app,
  authMiddleware,
  getPool,
  sendPublicDatabaseError,
  contactService = service,
} = {}) {
  if (!app) throw new TypeError("An Express application is required.");
  if (typeof authMiddleware !== "function") {
    throw new TypeError("authMiddleware must be a function.");
  }
  const handlers = createBusinessContactHandlers({
    getPool,
    sendPublicDatabaseError,
    contactService,
  });
  app.post("/business-contacts", authMiddleware, handlers.create);
  app.get("/business-contacts", authMiddleware, handlers.list);
  app.get("/business-contacts/:contactId", authMiddleware, handlers.get);
  app.patch("/business-contacts/:contactId", authMiddleware, handlers.update);
  app.post("/business-contacts/:contactId/roles", authMiddleware, handlers.assignRole);
  app.post("/business-contacts/:contactId/roles/:roleId/end", authMiddleware, handlers.endRole);
  app.post("/business-contacts/:contactId/archive", authMiddleware, handlers.archive);
  return handlers;
}

module.exports = {
  createBusinessContactHandlers,
  registerBusinessContactRoutes,
  sendBusinessContactResult: sendResult,
};
