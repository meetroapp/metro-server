"use strict";

const assignmentService = require("./jobAssignmentService");

function send(res, result) {
  if (!result?.ok) {
    return res.status(result?.status || 500).json({
      success: false,
      code: result?.code || "JOB_ASSIGNMENT_OPERATION_FAILED",
      message: result?.message || "The Job assignment operation could not be completed.",
    });
  }
  const { ok, status, ...payload } = result;
  return res.status(status || 200).json({ success: true, ...payload });
}

function createJobAssignmentHandlers({
  getPool,
  sendPublicDatabaseError,
  service = assignmentService,
}) {
  const handle = (operation, action) => async (req, res) => {
    res.setHeader?.("Cache-Control", "private, no-store");
    try {
      return send(res, await action(req));
    } catch (error) {
      return sendPublicDatabaseError({
        res,
        error,
        operation,
        code: "JOB_ASSIGNMENT_OPERATION_FAILED",
        message: "The Job assignment operation could not be completed.",
      });
    }
  };

  return {
    listManaged: handle("list_business_job_assignments", (req) => service.listManagedJobs({
      pool: getPool(req),
      authenticatedActor: req.user,
      businessId: req.query?.businessId,
    })),
    setAssignments: handle("set_business_job_assignments", (req) => service.setJobAssignments({
      pool: getPool(req),
      authenticatedActor: req.user,
      businessId: req.body?.businessId,
      jobId: req.params?.jobId,
      membershipIds: req.body?.membershipIds,
      idempotencyKey: req.body?.idempotencyKey,
    })),
    listMine: handle("list_employee_assigned_jobs", (req) => service.listEmployeeJobs({
      pool: getPool(req),
      authenticatedActor: req.user,
      businessId: req.query?.businessId,
    })),
    schedule: handle("list_employee_assigned_schedule", (req) => service.listEmployeeSchedule({
      pool: getPool(req),
      authenticatedActor: req.user,
      businessId: req.query?.businessId,
    })),
  };
}

function registerJobAssignmentRoutes(options) {
  const { app, authMiddleware } = options;
  if (!app || typeof authMiddleware !== "function") {
    throw new TypeError("Job assignment route dependencies are required.");
  }
  const handlers = createJobAssignmentHandlers(options);
  app.get("/team/jobs", authMiddleware, handlers.listManaged);
  app.put("/team/jobs/:jobId/assignments", authMiddleware, handlers.setAssignments);
  app.get("/employee/jobs", authMiddleware, handlers.listMine);
  app.get("/employee/schedule", authMiddleware, handlers.schedule);
  return handlers;
}

module.exports = {
  createJobAssignmentHandlers,
  registerJobAssignmentRoutes,
  send,
};
