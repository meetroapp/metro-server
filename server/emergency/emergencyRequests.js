"use strict";

const emergencySelectionService = require(
  "./emergencySelectionService"
);

const emergencyOpportunityService = require("./emergencyOpportunityService");
const emergencyRequestService = require("./emergencyRequestService");
const requestRelationshipService = require(
  "../relationships/requestRelationshipService"
);
const {
  serializeEmergencyResponseRelationship,
  serializeHomeownerEmergencyResponse,
} = require("../relationships/requestRelationships");

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

function sendOpportunityResult(res, result) {
  if (!result || result.ok !== true) {
    return res.status(result?.status || 500).json({
      success: false,
      code:
        result?.code ||
        "EMERGENCY_OPPORTUNITIES_FETCH_FAILED",
      message:
        result?.message ||
        "Emergency opportunities could not be loaded.",
    });
  }

  return res.status(result.status || 200).json({
    success: true,
    code:
      result.code ||
      "EMERGENCY_OPPORTUNITIES_FOUND",
    opportunities: Array.isArray(result.opportunities)
      ? result.opportunities
      : [],
  });
}

function createEmergencyRequestHandlers({
  getPool,
  sendPublicDatabaseError,
  service = emergencyRequestService,
  opportunityService = emergencyOpportunityService,
  relationshipService = requestRelationshipService,
  selectionService = emergencySelectionService,
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
  const {
    listProfessionalEmergencyOpportunities,
    professionalCanSeeEmergencyOpportunity,
  } = opportunityService;
  const {
    createProfessionalEmergencyResponse,
    listHomeownerEmergencyResponses,
  } = relationshipService;
  const {
    selectHomeownerEmergencyResponse,
  } = selectionService;

  async function listProfessionalOpportunities(req, res) {
    try {
      const result =
        await listProfessionalEmergencyOpportunities({
          pool: getPool(req),
          professionalUserId: req.user.id,
        });

      return sendOpportunityResult(res, result);
    } catch (error) {
      return sendPublicDatabaseError({
        res,
        error,
        operation:
          "list_professional_emergency_opportunities",
        code:
          "EMERGENCY_OPPORTUNITIES_FETCH_FAILED",
        message:
          "Emergency opportunities could not be loaded.",
      });
    }
  }

  async function respondToProfessionalOpportunity(req, res) {
    try {
      const result = await createProfessionalEmergencyResponse({
        pool: getPool(req),
        professionalUserId: req.user.id,
        emergencyRequestId: req.params.emergencyRequestId,
        payload: req.body,
        professionalCanSeeEmergencyOpportunity,
      });

      if (!result || result.ok !== true) {
        return res.status(result?.status || 500).json({
          success: false,
          code: result?.code || "EMERGENCY_RESPONSE_CREATE_FAILED",
          message:
            result?.message ||
            "The Emergency response could not be created.",
        });
      }

      return res.status(result.status || 200).json({
        success: true,
        code: result.code,
        created: Boolean(result.created),
        relationship: serializeEmergencyResponseRelationship(
          result.relationship
        ),
      });
    } catch (error) {
      return sendPublicDatabaseError({
        res,
        error,
        operation: "create_emergency_response",
        code: "EMERGENCY_RESPONSE_CREATE_FAILED",
        message: "The Emergency response could not be created.",
      });
    }
  }

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

  async function listHomeownerResponses(req, res) {
    try {
      const result = await listHomeownerEmergencyResponses({
        pool: getPool(req),
        homeownerUserId: req.user.id,
        emergencyRequestId:
          req.params.emergencyRequestId,
      });

      if (!result || result.ok !== true) {
        return res.status(result?.status || 500).json({
          success: false,
          code:
            result?.code ||
            "EMERGENCY_RESPONSES_FETCH_FAILED",
          message:
            result?.message ||
            "Emergency responses could not be loaded.",
        });
      }

      return res.status(result.status || 200).json({
        success: true,
        code: "EMERGENCY_RESPONSES_FOUND",
        emergencyRequest: {
          id: result.emergencyRequest.id,
          status: result.emergencyRequest.status,
        },
        responses: Array.isArray(result.responses)
          ? result.responses.map(
              serializeHomeownerEmergencyResponse
            )
          : [],
      });
    } catch (error) {
      return sendPublicDatabaseError({
        res,
        error,
        operation: "fetch_emergency_responses",
        code: "EMERGENCY_RESPONSES_FETCH_FAILED",
        message:
          "Emergency responses could not be loaded.",
      });
    }
  }

  async function selectHomeownerResponse(req, res) {
    try {
      const result =
        await selectHomeownerEmergencyResponse({
          pool: getPool(req),
          homeownerUserId: req.user.id,
          emergencyRequestId:
            req.params.emergencyRequestId,
          relationshipId:
            req.params.relationshipId,
        });

      if (!result || result.ok !== true) {
        return res.status(result?.status || 500).json({
          success: false,
          code:
            result?.code ||
            "EMERGENCY_RESPONSE_SELECT_FAILED",
          message:
            result?.message ||
            "The Emergency response could not be selected.",
        });
      }

      return res.status(result.status || 200).json({
        success: true,
        code:
          result.code ||
          "EMERGENCY_RESPONSE_SELECTED",
        alreadySelected:
          Boolean(result.alreadySelected),
        declinedResponseCount:
          Number(result.declinedResponseCount || 0),
        emergencyRequest: {
          id: result.emergencyRequest.id,
          status: result.emergencyRequest.status,
          assignedAt:
            result.emergencyRequest.assigned_at || null,
          updatedAt:
            result.emergencyRequest.updated_at || null,
        },
        relationship: {
          id: result.relationship.id,
          emergencyRequestId:
            result.relationship.emergency_request_id,
          status: result.relationship.status,
          acceptedAt:
            result.relationship.accepted_at || null,
          conversationAvailable: true,
        },
        conversation: {
          id: result.conversation.id,
          relationshipId:
            result.conversation.relationship_id,
          status: result.conversation.status,
        },
      });
    } catch (error) {
      return sendPublicDatabaseError({
        res,
        error,
        operation: "select_emergency_response",
        code: "EMERGENCY_RESPONSE_SELECT_FAILED",
        message:
          "The Emergency response could not be selected.",
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
    listHomeownerResponses,
    listProfessionalOpportunities,
    prepareRequest,
    respondToProfessionalOpportunity,
    selectHomeownerResponse,
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
  opportunityService = emergencyOpportunityService,
  relationshipService = requestRelationshipService,
  selectionService = emergencySelectionService,
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
    opportunityService,
    relationshipService,
    selectionService,
  });

  app.get(
    "/professional-emergency-opportunities",
    authMiddleware,
    handlers.listProfessionalOpportunities
  );

  app.post(
    "/professional-emergency-opportunities/:emergencyRequestId/respond",
    authMiddleware,
    handlers.respondToProfessionalOpportunity
  );

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

  app.get(
    "/emergency-requests/:emergencyRequestId/responses",
    authMiddleware,
    handlers.listHomeownerResponses
  );

  app.post(
    "/emergency-requests/:emergencyRequestId/responses/:relationshipId/select",
    authMiddleware,
    handlers.selectHomeownerResponse
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
  sendOpportunityResult,
  sendServiceResult,
};
