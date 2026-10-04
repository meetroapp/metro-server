"use strict";

const {
  parsePositiveSafeInteger,
  requireDatabasePool,
} = require("./alertContracts");
const {
  createCanonicalLifecycleAlertWithClient,
} = require("./lifecycleAlertService");

async function loadEligibleProfessionalUserIds({
  client,
  source,
  homeownerUserId,
  eligibility,
}) {
  requireDatabasePool(client);
  const homeownerId = parsePositiveSafeInteger(homeownerUserId);
  if (!homeownerId || typeof eligibility !== "function") {
    throw new TypeError("Canonical opportunity Alert eligibility is required.");
  }

  const profiles = await client.query(
    `
    /* opportunity_alert:eligible_professional_profiles */
    SELECT id, user_id, category, profile_details
    FROM contractor_profiles
    WHERE user_id <> $1
    ORDER BY user_id ASC, id ASC
    `,
    [homeownerId]
  );

  const recipients = new Set();
  for (const profile of profiles.rows) {
    const professionalUserId = parsePositiveSafeInteger(profile.user_id);
    if (
      professionalUserId &&
      professionalUserId !== homeownerId &&
      eligibility(profile, source, professionalUserId)
    ) {
      recipients.add(professionalUserId);
    }
  }
  return [...recipients].sort((left, right) => left - right);
}

async function projectNewLeadAlertsWithClient({
  client,
  request,
  sourceEventId,
  professionalCanSeeRequest,
  createAlert = createCanonicalLifecycleAlertWithClient,
}) {
  const requestId = parsePositiveSafeInteger(request?.id);
  const homeownerUserId = parsePositiveSafeInteger(request?.user_id);
  if (!requestId || !homeownerUserId || !sourceEventId) {
    throw new TypeError("Canonical Lead Alert identity is required.");
  }

  const recipients = await loadEligibleProfessionalUserIds({
    client,
    source: request,
    homeownerUserId,
    eligibility: professionalCanSeeRequest,
  });
  const alerts = [];
  for (const recipientUserId of recipients) {
    alerts.push(await createAlert({
      client,
      recipientUserId,
      sourceDomain: "workflow",
      sourceEventType: "request.created",
      sourceEntityType: "request",
      sourceEntityId: String(requestId),
      sourceEventId: String(sourceEventId),
      category: "request",
      priority: "high",
      titleKey: "alerts.request.newLead.title",
      messageKey: "alerts.request.newLead.message",
      safePayload: { shortPreview: "New lead" },
      destination: {
        type: "request",
        payload: { requestId },
      },
      availableAt: request.created_at || null,
    }));
  }
  return { recipients, alerts };
}

async function projectEmergencyRequestAlertsWithClient({
  client,
  emergencyRequest,
  professionalCanSeeEmergencyOpportunity,
  createAlert = createCanonicalLifecycleAlertWithClient,
}) {
  const emergencyRequestId = parsePositiveSafeInteger(emergencyRequest?.id);
  const homeownerUserId = parsePositiveSafeInteger(
    emergencyRequest?.homeowner_id
  );
  if (!emergencyRequestId || !homeownerUserId) {
    throw new TypeError("Canonical Emergency Alert identity is required.");
  }

  const recipients = await loadEligibleProfessionalUserIds({
    client,
    source: emergencyRequest,
    homeownerUserId,
    eligibility: professionalCanSeeEmergencyOpportunity,
  });
  const alerts = [];
  for (const recipientUserId of recipients) {
    alerts.push(await createAlert({
      client,
      recipientUserId,
      sourceDomain: "emergency",
      sourceEventType: "emergency.request_ready",
      sourceEntityType: "emergency_request",
      sourceEntityId: String(emergencyRequestId),
      sourceEventId: `${emergencyRequestId}:ready`,
      category: "emergency",
      priority: "critical",
      titleKey: "alerts.emergency.request.title",
      messageKey: "alerts.emergency.request.message",
      safePayload: { shortPreview: "Emergency request" },
      destination: {
        type: "emergency_request",
        payload: { emergencyRequestId },
      },
      availableAt: emergencyRequest.requested_at || null,
    }));
  }
  return { recipients, alerts };
}

async function projectEmergencyResponseAlertWithClient({
  client,
  emergencyRequest,
  relationship,
  createAlert = createCanonicalLifecycleAlertWithClient,
}) {
  const emergencyRequestId = parsePositiveSafeInteger(emergencyRequest?.id);
  const homeownerUserId = parsePositiveSafeInteger(
    emergencyRequest?.homeowner_id
  );
  const professionalUserId = parsePositiveSafeInteger(
    relationship?.professional_user_id
  );
  const relationshipId = parsePositiveSafeInteger(relationship?.id);
  if (
    !emergencyRequestId ||
    !homeownerUserId ||
    !professionalUserId ||
    !relationshipId ||
    homeownerUserId === professionalUserId ||
    Number(relationship?.emergency_request_id) !== emergencyRequestId ||
    Number(relationship?.homeowner_id) !== homeownerUserId
  ) {
    throw new TypeError("Canonical Emergency response Alert identity is required.");
  }

  return createAlert({
    client,
    recipientUserId: homeownerUserId,
    sourceDomain: "emergency",
    sourceEventType: "emergency.response_created",
    sourceEntityType: "emergency_relationship",
    sourceEntityId: String(relationshipId),
    sourceEventId: `${relationshipId}:created`,
    category: "emergency",
    priority: "high",
    titleKey: "alerts.emergency.response.title",
    messageKey: "alerts.emergency.response.message",
    safePayload: { shortPreview: "Emergency response" },
    destination: {
      type: "emergency_request",
      payload: { emergencyRequestId },
    },
    availableAt: relationship.responded_at || relationship.created_at || null,
  });
}

module.exports = {
  loadEligibleProfessionalUserIds,
  projectEmergencyRequestAlertsWithClient,
  projectEmergencyResponseAlertWithClient,
  projectNewLeadAlertsWithClient,
};
