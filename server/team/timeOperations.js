"use strict";

const service = require("./timeOperationsService");
const { send } = require("./team");

function createTimeOperationsHandlers({ getPool, sendPublicDatabaseError, operationsService = service }) {
  const handle = (operation, action) => async (req, res) => {
    res.setHeader?.("Cache-Control", "private, no-store");
    try {
      return send(res, await action(req));
    } catch (error) {
      return sendPublicDatabaseError({
        res,
        error,
        operation,
        code: "TEAM_TIME_PROJECTION_FAILED",
        message: "The Team time projection could not be loaded.",
      });
    }
  };
  return {
    today: handle("get_team_today", (req) => operationsService.getTeamToday({
      pool: getPool(req), authenticatedActor: req.user, businessId: req.query?.businessId,
    })),
    timesheets: handle("get_team_timesheets", (req) => operationsService.getTimesheets({
      pool: getPool(req), authenticatedActor: req.user, businessId: req.query?.businessId,
      range: req.query?.range,
    })),
  };
}

function registerTimeOperationsRoutes(options) {
  const { app, authMiddleware } = options;
  if (!app || typeof authMiddleware !== "function") {
    throw new TypeError("Team time projection route dependencies are required.");
  }
  const handlers = createTimeOperationsHandlers(options);
  app.get("/team/today", authMiddleware, handlers.today);
  app.get("/team/timesheets", authMiddleware, handlers.timesheets);
  return handlers;
}

module.exports = { createTimeOperationsHandlers, registerTimeOperationsRoutes };

