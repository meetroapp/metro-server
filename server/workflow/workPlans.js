"use strict";

const workPlanService = require("./workPlanService");

function sendWorkPlanResult(res, result, field) {
  if (!result?.ok) {
    return res.status(result?.status || 500).json({
      success: false,
      code: result?.code || "WORK_PLAN_FAILED",
      message: result?.message || "The Work Plan could not be loaded.",
    });
  }
  return res.status(result.status || 200).json({
    success: true,
    code: result.code,
    [field]: result[field],
  });
}

function createWorkPlanHandlers({
  getPool,
  sendPublicDatabaseError,
  service = workPlanService,
} = {}) {
  if (typeof getPool !== "function") throw new TypeError("getPool must be a function.");
  if (typeof sendPublicDatabaseError !== "function") {
    throw new TypeError("sendPublicDatabaseError must be a function.");
  }
  const handle = (operation, field, action) => async (req, res) => {
    res.setHeader?.("Cache-Control", "private, no-store");
    try {
      return sendWorkPlanResult(res, await action(req), field);
    } catch (error) {
      return sendPublicDatabaseError({
        res,
        error,
        operation,
        code: "WORK_PLAN_FAILED",
        message: "The Work Plan could not be loaded.",
      });
    }
  };
  return {
    getProfessionalSummary: handle(
      "get_professional_work_plan_summary",
      "workPlanSummary",
      (req) => service.getProfessionalWorkPlanSummary({
        pool: getPool(req),
        authenticatedActor: req.user,
      })
    ),
    getProfessionalJobPlan: handle(
      "get_professional_job_work_plan",
      "workPlan",
      (req) => service.getProfessionalJobWorkPlan({
        pool: getPool(req),
        authenticatedActor: req.user,
        jobId: req.params?.jobId,
      })
    ),
    getCustomerJobPlan: handle(
      "get_customer_job_work_plan",
      "workPlan",
      (req) => service.getCustomerJobWorkPlan({
        pool: getPool(req),
        authenticatedActor: req.user,
        jobId: req.params?.jobId,
      })
    ),
  };
}

function registerWorkPlanRoutes({
  app,
  authMiddleware,
  getPool,
  sendPublicDatabaseError,
  service = workPlanService,
} = {}) {
  if (!app || typeof app.get !== "function" || typeof authMiddleware !== "function") {
    throw new TypeError("Work Plan route dependencies are required.");
  }
  const handlers = createWorkPlanHandlers({
    getPool,
    sendPublicDatabaseError,
    service,
  });
  app.get("/professional/work-plan", authMiddleware, handlers.getProfessionalSummary);
  app.get("/professional/jobs/:jobId/work-plan", authMiddleware, handlers.getProfessionalJobPlan);
  app.get("/customer/jobs/:jobId/work-plan", authMiddleware, handlers.getCustomerJobPlan);
  return handlers;
}

module.exports = {
  createWorkPlanHandlers,
  registerWorkPlanRoutes,
  sendWorkPlanResult,
};
