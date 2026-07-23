"use strict";

const emergencyRequestService = require("./emergencyRequestService");

function sendServiceResult(res, result) {
  if (!result || result.ok !== true) {
    return res.status(result?.status || 500).json({
      success: false,
      code: result?.code || "EMERGENCY_REQUEST_FAILED",
      message:
        result?.message ||
        "The Emergency request could not be completed.",
    });
  }

  return res.status(result.status || 200).json({
    success: true,
    code: result.code,
    emergencyRequest: result.emergencyRequest,
  });
}

function createEmergencyRequestHandlers({
  getPool,
  sendPublicDatabaseError,
  service = emergencyRequestService,
}) {
  if (typeof getPool !== "function") {
    throw new TypeError("getPool must be a function.");
  }

  if (typeof sendPublicDatabaseError !== "function") {
    throw new TypeError(
      "sendPublicDatabaseError must be a function."
    );
  }

  const {
    cancelEmergencyRequest,
    createEmergencyDraft,
    getOwnedEmergencyRequest,
    prepareEmergencyRequest,
    saveEmergencySafetyAssessment,
    updateEmergencyDraft,
  } = service;

  async function createDraft(req, res) {
    try {
      const result = await createEmergencyDraft({
        pool: getPool(req),
        homeownerUserId: req.user.id,
        payload: req.body,
      });

      return sendServiceResult(res, result);
    } catch (error) {
      return sendPublicDatabaseError({
        res,
        error,
        operation: "create_emergency_draft",
        code: "EMERGENCY_DRAFT_CREATE_FAILED",
        message:
          "The Emergency draft could not be created.",
      });
    }
  }

  async function getRequest(req, res) {
    try {
      const result = await getOwnedEmergencyRequest({
        pool: getPool(req),
        homeownerUserId: req.user.id,
        emergencyRequestId:
          req.params.emergencyRequestId,
      });

      return sendServiceResult(res, result);
    } catch (error) {
      return sendPublicDatabaseError({
        res,
        error,
        operation: "fetch_emergency_request",
        code: "EMERGENCY_REQUEST_FETCH_FAILED",
        message:
          "The Emergency request could not be loaded.",
      });
    }
  }

  async function updateDraft(req, res) {
    try {
      const result = await updateEmergencyDraft({
        pool: getPool(req),
        homeownerUserId: req.user.id,
        emergencyRequestId:
          req.params.emergencyRequestId,
        payload: req.body,
      });

      return sendServiceResult(res, result);
    } catch (error) {
      return sendPublicDatabaseError({
        res,
        error,
        operation: "update_emergency_draft",
        code: "EMERGENCY_DRAFT_UPDATE_FAILED",
        message:
          "The Emergency draft could not be updated.",
      });
    }
  }

  async function saveSafetyAssessment(req, res) {
    try {
      const result =
        await saveEmergencySafetyAssessment({
          pool: getPool(req),
          homeownerUserId: req.user.id,
          emergencyRequestId:
            req.params.emergencyRequestId,
          payload: req.body,
        });

      return sendServiceResult(res, result);
    } catch (error) {
      return sendPublicDatabaseError({
        res,
        error,
        operation:
          "save_emergency_safety_assessment",
        code:
          "EMERGENCY_SAFETY_ASSESSMENT_SAVE_FAILED",
        message:
          "The Emergency safety assessment could not be saved.",
      });
    }
  }

  async function prepareRequest(req, res) {
    try {
      const result = await prepareEmergencyRequest({
        pool: getPool(req),
        homeownerUserId: req.user.id,
        emergencyRequestId:
          req.params.emergencyRequestId,
      });

      return sendServiceResult(res, result);
    } catch (error) {
      return sendPublicDatabaseError({
        res,
        error,
        operation: "prepare_emergency_request",
        code: "EMERGENCY_REQUEST_PREPARE_FAILED",
        message:
          "The Emergency request could not be prepared.",
      });
    }
  }

  async function cancelRequest(req, res) {
    try {
      const result = await cancelEmergencyRequest({
        pool: getPool(req),
        homeownerUserId: req.user.id,
        emergencyRequestId:
          req.params.emergencyRequestId,
      });

      return sendServiceResult(res, result);
    } catch (error) {
      return sendPublicDatabaseError({
        res,
        error,
        operation: "cancel_emergency_request",
        code: "EMERGENCY_REQUEST_CANCEL_FAILED",
        message:
          "The Emergency request could not be cancelled.",
      });
    }
  }

  return {
    cancelRequest,
    createDraft,
    getRequest,
    prepareRequest,
    saveSafetyAssessment,
    updateDraft,
  };
}

function registerEmergencyRequestRoutes({
  app,
  authMiddleware,
  getPool,
  sendPublicDatabaseError,
  service = emergencyRequestService,
}) {
  if (!app) {
    throw new TypeError(
      "An Express application is required."
    );
  }

  if (typeof authMiddleware !== "function") {
    throw new TypeError(
      "authMiddleware must be a function."
    );
  }

  const handlers = createEmergencyRequestHandlers({
    getPool,
    sendPublicDatabaseError,
    service,
  });

  app.post(
    "/emergency-requests/drafts",
    authMiddleware,
    handlers.createDraft
  );

  app.get(
    "/emergency-requests/:emergencyRequestId",
    authMiddleware,
    handlers.getRequest
  );

  app.patch(
    "/emergency-requests/:emergencyRequestId",
    authMiddleware,
    handlers.updateDraft
  );

  app.post(
    "/emergency-requests/:emergencyRequestId/safety-assessment",
    authMiddleware,
    handlers.saveSafetyAssessment
  );

  app.post(
    "/emergency-requests/:emergencyRequestId/prepare",
    authMiddleware,
    handlers.prepareRequest
  );

  app.post(
    "/emergency-requests/:emergencyRequestId/cancel",
    authMiddleware,
    handlers.cancelRequest
  );

  return handlers;
}

module.exports = {
  createEmergencyRequestHandlers,
  registerEmergencyRequestRoutes,
  sendServiceResult,
};
