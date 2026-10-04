"use strict";

const service = require("./homeownerProfessionalsDirectoryService");
const savedProfessionalService = require("./homeownerSavedProfessionalService");

function sendResult(res, result) {
  const payload = {
    success: result?.ok === true,
    code: result?.code || "HOMEOWNER_PROFESSIONALS_FAILED",
  };

  if (result?.message) {
    payload.message = result.message;
  }

  if (result?.saved !== undefined) {
    payload.saved = result.saved;
  }

  if (result?.workedWith !== undefined) {
    payload.workedWith = result.workedWith;
  }

  if (result?.savedProfessional !== undefined) {
    payload.savedProfessional = result.savedProfessional;
  }

  if (result?.replayed) {
    payload.replayed = true;
  }

  res.setHeader?.("Cache-Control", "private, no-store");

  return res
    .status(result?.status || 500)
    .json(payload);
}

function createHomeownerProfessionalsHandlers({
  getPool,
  sendPublicDatabaseError,
  directoryService = service,
  mutationService = savedProfessionalService,
} = {}) {
  if (typeof getPool !== "function") {
    throw new TypeError("getPool must be a function.");
  }

  if (typeof sendPublicDatabaseError !== "function") {
    throw new TypeError(
      "sendPublicDatabaseError must be a function."
    );
  }

  async function runMutation({
    req,
    res,
    operation,
    action,
  }) {
    try {
      const result = await action({
        pool: getPool(req),
        authenticatedActor: req.user,
        contractorProfileId:
          req.params?.contractorProfileId,
        idempotencyKey:
          req.headers?.["idempotency-key"],
      });

      return sendResult(res, result);
    } catch (error) {
      return sendPublicDatabaseError({
        res,
        error,
        operation,
        code: "HOMEOWNER_PROFESSIONALS_FAILED",
        message:
          "The Saved Professional operation could not be completed.",
      });
    }
  }

  return {
    list: async (req, res) => {
      try {
        const result =
          await directoryService.listHomeownerProfessionals({
            pool: getPool(req),
            homeownerUserId: req.user?.id,
          });

        return sendResult(res, result);
      } catch (error) {
        return sendPublicDatabaseError({
          res,
          error,
          operation: "list_homeowner_professionals",
          code: "HOMEOWNER_PROFESSIONALS_FAILED",
          message:
            "My Professionals could not be loaded.",
        });
      }
    },

    save: (req, res) =>
      runMutation({
        req,
        res,
        operation:
          "save_homeowner_professional",
        action:
          mutationService.saveHomeownerProfessional,
      }),

    remove: (req, res) =>
      runMutation({
        req,
        res,
        operation:
          "remove_homeowner_saved_professional",
        action:
          mutationService.removeHomeownerSavedProfessional,
      }),
  };
}

function registerHomeownerProfessionalsRoutes({
  app,
  authMiddleware,
  getPool,
  sendPublicDatabaseError,
  directoryService = service,
  mutationService = savedProfessionalService,
} = {}) {
  if (!app) {
    throw new TypeError(
      "An Express application is required."
    );
  }

  if (typeof authMiddleware !== "function") {
    throw new TypeError(
      "authMiddleware must be a function."
    );
  }

  const handlers =
    createHomeownerProfessionalsHandlers({
      getPool,
      sendPublicDatabaseError,
      directoryService,
      mutationService,
    });

  app.get(
    "/my-professionals",
    authMiddleware,
    handlers.list
  );

  app.post(
    "/my-professionals/:contractorProfileId/save",
    authMiddleware,
    handlers.save
  );

  app.post(
    "/my-professionals/:contractorProfileId/remove",
    authMiddleware,
    handlers.remove
  );

  return handlers;
}

module.exports = {
  createHomeownerProfessionalsHandlers,
  registerHomeownerProfessionalsRoutes,
  sendHomeownerProfessionalsResult: sendResult,
};
