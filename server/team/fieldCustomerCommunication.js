"use strict";

const fieldCustomerCommunicationService = require("./fieldCustomerCommunicationService");
const { send } = require("./jobAssignments");

function createFieldCustomerCommunicationHandlers({
  getPool,
  sendPublicDatabaseError,
  service = fieldCustomerCommunicationService,
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
        code: "FIELD_CUSTOMER_COMMUNICATION_FAILED",
        message: "The assigned Job customer communication operation could not be completed.",
      });
    }
  };

  return {
    acknowledgeAttention: handle(
      "acknowledge_employee_job_customer_communication_attention",
      (req) => service.acknowledgeFieldCustomerAttention({
        pool: getPool(req),
        authenticatedActor: req.user,
        jobId: req.params?.jobId,
        payload: req.body,
      })
    ),
    resolveAlertDestination: handle(
      "resolve_employee_alert_customer_conversation_destination",
      (req) => service.resolveFieldCustomerAlertDestination({
        pool: getPool(req),
        authenticatedActor: req.user,
        alertId: req.params?.alertId,
        payload: req.query,
      })
    ),
    getConversation: handle(
      "get_employee_job_customer_conversation",
      (req) => service.getFieldCustomerConversation({
        pool: getPool(req),
        authenticatedActor: req.user,
        jobId: req.params?.jobId,
        payload: req.query,
      })
    ),
    sendMessage: handle(
      "send_employee_job_customer_conversation_message",
      (req) => service.sendFieldCustomerMessage({
        pool: getPool(req),
        authenticatedActor: req.user,
        jobId: req.params?.jobId,
        payload: req.body,
      })
    ),
  };
}

function registerFieldCustomerCommunicationRoutes(options) {
  const { app, authMiddleware } = options;
  if (!app || typeof authMiddleware !== "function") {
    throw new TypeError("Field customer communication route dependencies are required.");
  }
  const handlers = createFieldCustomerCommunicationHandlers(options);
  app.get(
    "/employee/alerts/:alertId/customer-conversation-destination",
    authMiddleware,
    handlers.resolveAlertDestination
  );
  app.get(
    "/employee/jobs/:jobId/customer-conversation",
    authMiddleware,
    handlers.getConversation
  );
  app.post(
    "/employee/jobs/:jobId/customer-conversation/read",
    authMiddleware,
    handlers.acknowledgeAttention
  );
  app.post(
    "/employee/jobs/:jobId/customer-conversation/messages",
    authMiddleware,
    handlers.sendMessage
  );
  return handlers;
}

module.exports = {
  createFieldCustomerCommunicationHandlers,
  registerFieldCustomerCommunicationRoutes,
};
