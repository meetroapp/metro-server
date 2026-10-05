"use strict";

const service = require("./connectedServicesService");

function send(res, result) {
  if (!result?.ok) {
    return res.status(result?.status || 500).json({
      success: false,
      code: result?.code || "CONNECTED_SERVICES_FAILED",
      message:
        result?.message ||
        "Connected Services could not be loaded.",
    });
  }

  const { ok, status, ...payload } = result;
  return res.status(status || 200).json({
    success: true,
    ...payload,
  });
}

function createConnectedServicesHandlers({
  getPool,
  sendPublicDatabaseError,
  connectedServicesService = service,
}) {
  if (
    typeof getPool !== "function" ||
    typeof sendPublicDatabaseError !== "function"
  ) {
    throw new TypeError(
      "Connected Services handler dependencies are required."
    );
  }

  return {
    getConnectedServices: async (req, res) => {
      res.setHeader?.("Cache-Control", "private, no-store");

      try {
        return send(
          res,
          await connectedServicesService.getConnectedServices({
            pool: getPool(req),
            authenticatedActor: req.user,
          })
        );
      } catch (error) {
        return sendPublicDatabaseError({
          res,
          error,
          operation: "get_connected_services",
          code: "CONNECTED_SERVICES_FAILED",
          message: "Connected Services could not be loaded.",
        });
      }
    },
  };
}

function registerConnectedServicesRoutes(options) {
  const { app, authMiddleware } = options || {};

  if (!app || typeof authMiddleware !== "function") {
    throw new TypeError(
      "Connected Services route dependencies are required."
    );
  }

  const handlers = createConnectedServicesHandlers(options);

  app.get(
    "/connected-services",
    authMiddleware,
    handlers.getConnectedServices
  );

  return handlers;
}

module.exports = {
  createConnectedServicesHandlers,
  registerConnectedServicesRoutes,
  send,
};
