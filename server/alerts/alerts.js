"use strict";

const {
  ALERT_ERROR_CODES,
  alertFailure,
  isPlainObject,
  parsePositiveSafeInteger,
} = require("./alertContracts");
const alertService = require("./alertService");

function setAlertNoStore(_req, res, next) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  next();
}

function isExactEmptyDataObject(value) {
  const input = value === undefined ? {} : value;
  if (!isPlainObject(input)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(input);
  return Reflect.ownKeys(descriptors).length === 0;
}

function sendAlertFailure(res, result) {
  return res.status(result?.status || 500).json({
    success: false,
    code: result?.code || "ALERT_OPERATION_FAILED",
    message: result?.message || "The alert operation could not be completed.",
  });
}

function invalidAlertId() {
  return alertFailure(
    ALERT_ERROR_CODES.INVALID_ID,
    "Alert ID is invalid."
  );
}

function invalidAlertRequest() {
  return alertFailure(
    ALERT_ERROR_CODES.INVALID_REQUEST,
    "Alert request is invalid."
  );
}

function createAlertHandlers({
  getPool,
  sendPublicDatabaseError,
  service = alertService,
}) {
  if (typeof getPool !== "function") {
    throw new TypeError("getPool must be a function.");
  }
  if (typeof sendPublicDatabaseError !== "function") {
    throw new TypeError("sendPublicDatabaseError must be a function.");
  }

  function handle(operation, failureCode, action, serializeSuccess) {
    return async (req, res) => {
      try {
        const result = await action(req);
        if (!result?.ok) return sendAlertFailure(res, result);
        return res.status(result.status || 200).json(serializeSuccess(result));
      } catch (error) {
        return sendPublicDatabaseError({
          res,
          error,
          operation,
          code: failureCode,
          message: "The alert operation could not be completed.",
        });
      }
    };
  }

  const listAlerts = handle(
    "list_alerts",
    ALERT_ERROR_CODES.FETCH_FAILED,
    (req) => {
      if (!isExactEmptyDataObject(req.body)) return invalidAlertRequest();
      return service.listAlertsForRecipient({
        pool: getPool(req),
        recipientUserId: req.user.id,
        query: req.query,
      });
    },
    (result) => ({
      success: true,
      code: result.code,
      alerts: result.alerts,
      pagination: result.pagination,
    })
  );

  const getCounts = handle(
    "get_alert_counts",
    ALERT_ERROR_CODES.COUNTS_FETCH_FAILED,
    (req) => {
      if (!isExactEmptyDataObject(req.body)) return invalidAlertRequest();
      return service.getAlertCountsForRecipient({
        pool: getPool(req),
        recipientUserId: req.user.id,
        query: req.query,
      });
    },
    (result) => ({
      success: true,
      code: result.code,
      counts: result.counts,
    })
  );

  const markAllRead = handle(
    "mark_all_alerts_read",
    ALERT_ERROR_CODES.READ_ALL_FAILED,
    (req) => service.markAllAlertsRead({
      pool: getPool(req),
      recipientUserId: req.user.id,
      query: req.query,
      input: req.body,
    }),
    (result) => ({
      success: true,
      code: result.code,
      markedReadCount: result.markedReadCount,
      cutoffAt: result.cutoffAt,
    })
  );

  const markOneRead = handle(
    "mark_alert_read",
    ALERT_ERROR_CODES.READ_FAILED,
    (req) => {
      if (
        !isExactEmptyDataObject(req.query) ||
        !isExactEmptyDataObject(req.body)
      ) {
        return invalidAlertRequest();
      }
      const alertId = parsePositiveSafeInteger(req.params?.alertId);
      if (!alertId) return invalidAlertId();
      return service.markAlertRead({
        pool: getPool(req),
        alertId,
        recipientUserId: req.user.id,
      });
    },
    (result) => ({
      success: true,
      code: "ALERT_MARKED_READ",
      alert: result.alert,
    })
  );

  const dismiss = handle(
    "dismiss_alert",
    ALERT_ERROR_CODES.DISMISS_FAILED,
    (req) => {
      if (
        !isExactEmptyDataObject(req.query) ||
        !isExactEmptyDataObject(req.body)
      ) {
        return invalidAlertRequest();
      }
      const alertId = parsePositiveSafeInteger(req.params?.alertId);
      if (!alertId) return invalidAlertId();
      return service.dismissAlert({
        pool: getPool(req),
        alertId,
        recipientUserId: req.user.id,
      });
    },
    (result) => ({
      success: true,
      code: result.code,
      alert: result.alert,
    })
  );

  return {
    dismiss,
    getCounts,
    listAlerts,
    markAllRead,
    markOneRead,
  };
}

function registerAlertRoutes({
  app,
  authMiddleware,
  getPool,
  sendPublicDatabaseError,
  service = alertService,
}) {
  if (!app) throw new TypeError("An Express application is required.");
  if (typeof authMiddleware !== "function") {
    throw new TypeError("authMiddleware must be a function.");
  }

  const handlers = createAlertHandlers({
    getPool,
    sendPublicDatabaseError,
    service,
  });

  app.get("/alerts", setAlertNoStore, authMiddleware, handlers.listAlerts);
  app.get("/alerts/counts", setAlertNoStore, authMiddleware, handlers.getCounts);
  app.post("/alerts/read-all", setAlertNoStore, authMiddleware, handlers.markAllRead);
  app.post("/alerts/:alertId/read", setAlertNoStore, authMiddleware, handlers.markOneRead);
  app.post("/alerts/:alertId/dismiss", setAlertNoStore, authMiddleware, handlers.dismiss);

  return handlers;
}

module.exports = {
  createAlertHandlers,
  registerAlertRoutes,
  setAlertNoStore,
};
