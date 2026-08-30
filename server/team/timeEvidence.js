"use strict";

const timeEvidenceService = require("./timeEvidenceService");
const { send } = require("./jobAssignments");

function createTimeEvidenceHandlers({ getPool, sendPublicDatabaseError, service = timeEvidenceService }) {
  const handle = (operation, action) => async (req, res) => {
    res.setHeader?.("Cache-Control", "private, no-store");
    try {
      return send(res, await action(req));
    } catch (error) {
      return sendPublicDatabaseError({
        res, error, operation,
        code: "TIME_EVIDENCE_OPERATION_FAILED",
        message: "The employee time operation could not be completed.",
      });
    }
  };
  return {
    listMine: handle("list_employee_time", (req) => service.listOwnTime({
      pool: getPool(req), authenticatedActor: req.user, businessId: req.query?.businessId,
    })),
    listTeam: handle("list_team_time", (req) => service.listTeamTime({
      pool: getPool(req), authenticatedActor: req.user, businessId: req.query?.businessId,
      membershipId: req.query?.membershipId,
    })),
    clockIn: handle("clock_in_employee_time", (req) => service.clockIn({
      pool: getPool(req), authenticatedActor: req.user,
      businessId: req.body?.businessId, category: req.body?.category,
      jobId: req.body?.jobId, assignmentId: req.body?.assignmentId,
      location: req.body?.location, idempotencyKey: req.body?.idempotencyKey,
    })),
    clockOut: handle("clock_out_employee_time", (req) => service.clockOut({
      pool: getPool(req), authenticatedActor: req.user,
      businessId: req.body?.businessId, sessionId: req.body?.sessionId,
      location: req.body?.location, idempotencyKey: req.body?.idempotencyKey,
    })),
  };
}

function registerTimeEvidenceRoutes(options) {
  const { app, authMiddleware } = options;
  if (!app || typeof authMiddleware !== "function") {
    throw new TypeError("Employee time route dependencies are required.");
  }
  const handlers = createTimeEvidenceHandlers(options);
  app.get("/employee/time", authMiddleware, handlers.listMine);
  app.post("/employee/time/clock-in", authMiddleware, handlers.clockIn);
  app.post("/employee/time/clock-out", authMiddleware, handlers.clockOut);
  app.get("/team/time", authMiddleware, handlers.listTeam);
  return handlers;
}

module.exports = { createTimeEvidenceHandlers, registerTimeEvidenceRoutes };
