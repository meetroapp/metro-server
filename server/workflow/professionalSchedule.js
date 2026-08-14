"use strict";

const professionalScheduleService = require("./professionalScheduleService");

function sendScheduleResult(res, result) {
  if (!result?.ok) {
    return res.status(result?.status || 500).json({
      success: false,
      code: result?.code || "PROFESSIONAL_SCHEDULE_FAILED",
      message: result?.message || "The professional Schedule could not be loaded.",
    });
  }
  return res.status(result.status || 200).json({
    success: true,
    code: result.code,
    schedule: result.schedule,
  });
}

function createProfessionalScheduleHandlers({
  getPool,
  sendPublicDatabaseError,
  service = professionalScheduleService,
} = {}) {
  if (typeof getPool !== "function") throw new TypeError("getPool must be a function.");
  if (typeof sendPublicDatabaseError !== "function") {
    throw new TypeError("sendPublicDatabaseError must be a function.");
  }
  return {
    getSchedule: async (req, res) => {
      res.setHeader?.("Cache-Control", "private, no-store");
      try {
        return sendScheduleResult(res, await service.getProfessionalSchedule({
          pool: getPool(req),
          authenticatedActor: req.user,
          view: req.query?.view,
          limit: req.query?.limit,
          cursor: req.query?.cursor,
        }));
      } catch (error) {
        return sendPublicDatabaseError({
          res,
          error,
          operation: "get_professional_schedule",
          code: "PROFESSIONAL_SCHEDULE_FAILED",
          message: "The professional Schedule could not be loaded.",
        });
      }
    },
  };
}

function registerProfessionalScheduleRoutes({
  app,
  authMiddleware,
  getPool,
  sendPublicDatabaseError,
  service = professionalScheduleService,
} = {}) {
  if (!app || typeof app.get !== "function") {
    throw new TypeError("An Express application is required.");
  }
  if (typeof authMiddleware !== "function") {
    throw new TypeError("authMiddleware must be a function.");
  }
  const handlers = createProfessionalScheduleHandlers({
    getPool,
    sendPublicDatabaseError,
    service,
  });
  app.get("/professional/schedule", authMiddleware, handlers.getSchedule);
  return handlers;
}

module.exports = {
  createProfessionalScheduleHandlers,
  registerProfessionalScheduleRoutes,
  sendScheduleResult,
};
