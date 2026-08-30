"use strict";

const service = require("./businessTimeSettingsService");
const { send } = require("./team");

function createBusinessTimeSettingsHandlers({ getPool, sendPublicDatabaseError, settingsService = service }) {
  const handle = (operation, action) => async (req, res) => {
    res.setHeader?.("Cache-Control", "private, no-store");
    try {
      return send(res, await action(req));
    } catch (error) {
      return sendPublicDatabaseError({
        res,
        error,
        operation,
        code: "BUSINESS_TIME_SETTINGS_OPERATION_FAILED",
        message: "The Business time settings operation could not be completed.",
      });
    }
  };
  return {
    get: handle("get_business_time_settings", (req) => settingsService.getBusinessTimeSettings({
      pool: getPool(req), authenticatedActor: req.user, businessId: req.query?.businessId,
    })),
    update: handle("update_business_time_settings", (req) => settingsService.updateBusinessTimeSettings({
      pool: getPool(req), authenticatedActor: req.user, businessId: req.body?.businessId,
      timeZone: req.body?.timeZone, weekStartDay: req.body?.weekStartDay,
    })),
  };
}

function registerBusinessTimeSettingsRoutes(options) {
  const { app, authMiddleware } = options;
  if (!app || typeof authMiddleware !== "function") {
    throw new TypeError("Business time settings route dependencies are required.");
  }
  const handlers = createBusinessTimeSettingsHandlers(options);
  app.get("/team/time-settings", authMiddleware, handlers.get);
  app.put("/team/time-settings", authMiddleware, handlers.update);
  return handlers;
}

module.exports = { createBusinessTimeSettingsHandlers, registerBusinessTimeSettingsRoutes };

