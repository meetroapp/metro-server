"use strict";

const fieldOperationsService = require("./fieldOperationsService");
const { send } = require("./jobAssignments");

function createFieldOperationsHandlers({ getPool, sendPublicDatabaseError, service = fieldOperationsService }) {
  const handle = (operation, action) => async (req, res) => {
    res.setHeader?.("Cache-Control", "private, no-store");
    try {
      return send(res, await action(req));
    } catch (error) {
      return sendPublicDatabaseError({
        res, error, operation,
        code: "FIELD_OPERATION_FAILED",
        message: "The Job field operation could not be completed.",
      });
    }
  };
  const list = (req) => service.listFieldOperations({
    pool: getPool(req), authenticatedActor: req.user,
    businessId: req.query?.businessId, jobId: req.params?.jobId,
    assignmentId: req.query?.assignmentId,
  });
  const listManagedCommunications = (req) =>
    service.listManagedFieldCommunications({
      pool: getPool(req), authenticatedActor: req.user,
      businessId: req.query?.businessId, jobId: req.params?.jobId,
    });
  const resolveTeamAlertDestination = (req) =>
    service.resolveFieldTeamAlertDestination({
      pool: getPool(req), authenticatedActor: req.user,
      businessId: req.query?.businessId, alertId: req.params?.alertId,
    });
  const message = (req) => service.sendFieldMessage({
    pool: getPool(req), authenticatedActor: req.user,
    businessId: req.body?.businessId, jobId: req.params?.jobId,
    assignmentId: req.body?.assignmentId, message: req.body?.message,
    idempotencyKey: req.body?.idempotencyKey,
  });
  return {
    listManagedCommunications: handle("list_managed_job_field_communications", listManagedCommunications),
    listManaged: handle("list_managed_job_field_operations", list),
    listMine: handle("list_employee_job_field_operations", list),
    transition: handle("transition_employee_job_field_status", (req) => service.transitionFieldStatus({
      pool: getPool(req), authenticatedActor: req.user,
      businessId: req.body?.businessId, jobId: req.params?.jobId,
      assignmentId: req.body?.assignmentId, toStatus: req.body?.toStatus,
      note: req.body?.note, idempotencyKey: req.body?.idempotencyKey,
    })),
    sendManagedMessage: handle("send_managed_job_field_message", message),
    sendEmployeeMessage: handle("send_employee_job_field_message", message),
    resolveTeamAlertDestination: handle("resolve_field_team_alert_destination", resolveTeamAlertDestination),
  };
}

function registerFieldOperationsRoutes(options) {
  const { app, authMiddleware } = options;
  if (!app || typeof authMiddleware !== "function") throw new TypeError("Field operations route dependencies are required.");
  const handlers = createFieldOperationsHandlers(options);
  app.get("/team/jobs/:jobId/field-communications", authMiddleware, handlers.listManagedCommunications);
  app.get("/team/jobs/:jobId/field-operations", authMiddleware, handlers.listManaged);
  app.post("/team/jobs/:jobId/field-messages", authMiddleware, handlers.sendManagedMessage);
  app.get("/employee/jobs/:jobId/field-operations", authMiddleware, handlers.listMine);
  app.post("/employee/jobs/:jobId/field-status", authMiddleware, handlers.transition);
  app.post("/employee/jobs/:jobId/field-messages", authMiddleware, handlers.sendEmployeeMessage);
  app.get("/employee/alerts/:alertId/team-message-destination", authMiddleware, handlers.resolveTeamAlertDestination);
  return handlers;
}

module.exports = { createFieldOperationsHandlers, registerFieldOperationsRoutes };
