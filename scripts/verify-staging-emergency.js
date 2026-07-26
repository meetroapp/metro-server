"use strict";

const crypto = require("node:crypto");
const {
  getProfessionalServiceDomain,
  getRequestServiceDomain,
  normalizeRequestServiceId,
} = require("../server/requests/serviceCompatibility");

const EXPECTED_HOST =
  "athletic-rebirth-staging.up.railway.app";

const LIVE_GATE_ONE =
  "RUN_EMERGENCY_STAGING_CERTIFICATION";

const LIVE_GATE_TWO =
  "CONFIRM_EMERGENCY_STAGING_MUTATION";

const REQUIRED_CONFIRMATION =
  "I_UNDERSTAND_THIS_CREATES_RETAINED_STAGING_RECORDS";

const SECRET_KEY_PATTERN =
  /authorization|bearer|token|password|secret|cookie|jwt/i;

const WORKFLOW = Object.freeze([
  {
    name: "en-route",
    endpoint: (id) =>
      `/emergency-requests/${id}/en-route`,
    successCode: "EMERGENCY_EN_ROUTE",
    repeatCode: "EMERGENCY_ALREADY_EN_ROUTE",
    status: "professional_en_route",
    timestampField: "enRouteAt",
  },
  {
    name: "arrived",
    endpoint: (id) =>
      `/emergency-requests/${id}/arrived`,
    successCode: "EMERGENCY_ARRIVED",
    repeatCode: "EMERGENCY_ALREADY_ARRIVED",
    status: "professional_arrived",
    timestampField: "arrivedAt",
  },
  {
    name: "start",
    endpoint: (id) =>
      `/emergency-requests/${id}/start`,
    successCode: "EMERGENCY_WORK_STARTED",
    repeatCode:
      "EMERGENCY_WORK_ALREADY_STARTED",
    status: "work_in_progress",
    timestampField: "workStartedAt",
  },
  {
    name: "complete",
    endpoint: (id) =>
      `/emergency-requests/${id}/complete`,
    successCode: "EMERGENCY_COMPLETED",
    repeatCode:
      "EMERGENCY_ALREADY_COMPLETED",
    status: "completed",
    timestampField: "completedAt",
  },
]);

class VerificationFailure extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "VerificationFailure";
    this.details = details;
  }
}

function isRecord(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function redact(value, key = "") {
  if (SECRET_KEY_PATTERN.test(String(key))) {
    return "<REDACTED>";
  }

  if (Array.isArray(value)) {
    return value.map((item) => redact(item));
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        redact(childValue, childKey),
      ])
    );
  }

  if (typeof value === "string") {
    return value
      .replace(
        /\bBearer\s+[A-Za-z0-9._~-]+\b/gi,
        "Bearer <REDACTED>"
      )
      .replace(
        /\beyJ[A-Za-z0-9._~-]+\b/g,
        "<REDACTED_JWT>"
      );
  }

  return value;
}

function validateTarget(rawUrl) {
  let target;

  try {
    target = new URL(String(rawUrl || ""));
  } catch {
    throw new VerificationFailure(
      "A valid staging URL is required."
    );
  }

  if (target.protocol !== "https:") {
    throw new VerificationFailure(
      "Only HTTPS staging targets are allowed."
    );
  }

  if (
    target.username ||
    target.password ||
    target.search ||
    target.hash
  ) {
    throw new VerificationFailure(
      "The staging URL cannot contain credentials, a query, or a fragment."
    );
  }

  if (target.hostname !== EXPECTED_HOST) {
    throw new VerificationFailure(
      "The Emergency verifier is restricted to the approved staging host.",
      {
        expectedHost: EXPECTED_HOST,
        receivedHost: target.hostname,
      }
    );
  }

  if (
    /production/i.test(target.hostname) ||
    /production/i.test(target.pathname)
  ) {
    throw new VerificationFailure(
      "Production-like targets are forbidden."
    );
  }

  target.pathname =
    target.pathname.replace(/\/+$/, "") || "/";

  return target;
}

function authorizeLiveExecution(env = process.env) {
  if (
    env[LIVE_GATE_ONE] !== "true" ||
    env[LIVE_GATE_TWO] !== REQUIRED_CONFIRMATION
  ) {
    throw new VerificationFailure(
      "Live Emergency staging certification is not authorized."
    );
  }
}

function requireToken(env, name) {
  const value = String(env[name] || "").trim();

  if (!value) {
    throw new VerificationFailure(
      `${name} is required.`
    );
  }

  if (value.startsWith("Bearer ")) {
    return value.slice("Bearer ".length).trim();
  }

  return value;
}

function createRunId(now = Date.now()) {
  return [
    "mc-emergency",
    new Date(now)
      .toISOString()
      .replace(/[-:.TZ]/g, "")
      .slice(0, 14),
    crypto.randomBytes(4).toString("hex"),
  ].join("-");
}

function assertStatus(response, expected, label) {
  const allowed = Array.isArray(expected)
    ? expected
    : [expected];

  if (!allowed.includes(response.status)) {
    throw new VerificationFailure(
      `${label} returned HTTP ${response.status}.`,
      {
        label,
        expectedStatus: allowed,
        actualStatus: response.status,
        body: redact(response.body),
      }
    );
  }
}

function assertCode(body, expected, label) {
  const allowed = Array.isArray(expected)
    ? expected
    : [expected];

  if (!allowed.includes(body?.code)) {
    throw new VerificationFailure(
      `${label} returned an unexpected response code.`,
      {
        label,
        expectedCode: allowed,
        actualCode: body?.code || null,
        body: redact(body),
      }
    );
  }
}

function assertPositiveInteger(value, label) {
  const number = Number(value);

  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new VerificationFailure(
      `${label} was not a positive integer.`,
      {
        label,
        value,
      }
    );
  }

  return number;
}

function createHttpClient({
  baseUrl,
  fetchImpl = globalThis.fetch,
}) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError(
      "A fetch implementation is required."
    );
  }

  async function request({
    method = "GET",
    endpoint,
    token,
    body,
  }) {
    const url = new URL(endpoint, baseUrl);

    const response = await fetchImpl(url, {
      method,
      headers: {
        accept: "application/json",
        ...(body !== undefined
          ? { "content-type": "application/json" }
          : {}),
        ...(token
          ? { authorization: `Bearer ${token}` }
          : {}),
      },
      ...(body !== undefined
        ? { body: JSON.stringify(body) }
        : {}),
    });

    const text = await response.text();
    let parsed = null;

    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = {
          nonJsonResponse: true,
          text: text.slice(0, 500),
        };
      }
    }

    return {
      status: response.status,
      body: parsed,
    };
  }

  return { request };
}

function createSummary({
  runId,
  target,
}) {
  return {
    success: false,
    runId,
    target: {
      host: target.hostname,
      protocol: target.protocol,
    },
    startedAt: new Date().toISOString(),
    completedAt: null,
    identities: {
      homeownerValidated: false,
      professionalValidated: false,
      professionalProfileValidated: false,
    },
    resources: {
      emergencyRequestId: null,
      relationshipId: null,
      conversationId: null,
    },
    checks: [],
    retainedRecords: [],
    finalState: null,
    failure: null,
  };
}

function recordCheck(
  summary,
  name,
  passed,
  details = {}
) {
  summary.checks.push({
    name,
    passed: Boolean(passed),
    details: redact(details),
  });
}

function buildEmergencyDraft(
  runId,
  rawServiceSpecialty = "electrical"
) {
  const serviceSpecialty =
    normalizeRequestServiceId(rawServiceSpecialty);
  const serviceDomain =
    getRequestServiceDomain(serviceSpecialty);

  if (!serviceDomain) {
    throw new VerificationFailure(
      "The Emergency certification service specialty is unsupported."
    );
  }

  return {
    category: "Home Repair",
    serviceDomain,
    serviceSpecialty,
    title:
      `Emergency staging certification ${runId}`,
    description:
      "Governed staging-only Emergency workflow certification.",
    locationText: "Cape Coral, FL 33904",
    unitNumber: "",
    accessNotes:
      `Certification marker: ${runId}`,
  };
}

function buildSafeAssessment() {
  return {
    immediateDanger: false,
    medicalEmergency: false,
    fireOrSmoke: false,
    gasOdorOrSuspectedLeak: false,
    activeCrimeOrThreat: false,
    electricalImmediateHazard: false,
    structuralCollapseRisk: false,
    floodingOrWaterDamage: false,
    occupantsUnableToExit: false,
    emergencyServicesContacted: false,
    safeToRemainAtLocation: true,
    additionalSafetyContext:
      "Governed staging certification; no real emergency exists.",
  };
}

async function verifyIdentity({
  client,
  token,
  label,
}) {
  const response = await client.request({
    endpoint: "/auth/me",
    token,
  });

  assertStatus(response, 200, `${label} identity`);

  const user = response.body?.user;

  if (!user?.id) {
    throw new VerificationFailure(
      `${label} identity was not returned.`,
      {
        body: redact(response.body),
      }
    );
  }

  return user;
}

async function verifyProfessionalProfile({
  client,
  token,
}) {
  const response = await client.request({
    endpoint: "/my-contractor-profile",
    token,
  });

  assertStatus(
    response,
    200,
    "Professional profile"
  );

  const profile = response.body?.profile;

  if (!profile?.id) {
    throw new VerificationFailure(
      "The professional account has no canonical contractor profile."
    );
  }

  const specialties = Array.isArray(
    profile.service_specialties
  )
    ? profile.service_specialties
    : [];

  const usableSpecialties = specialties.filter(
    (specialty) =>
      Boolean(
        getProfessionalServiceDomain(specialty)
      )
  );

  const serviceArea = String(
    profile.service_area || ""
  ).trim();

  if (
    usableSpecialties.length === 0 ||
    !serviceArea
  ) {
    throw new VerificationFailure(
      "The professional profile is not usable for Emergency opportunity evaluation.",
      {
        profile: {
          id: profile.id,
          category: profile.category,
          serviceSpecialties: specialties,
          usableServiceSpecialties:
            usableSpecialties,
          serviceArea,
        },
      }
    );
  }

  return {
    ...profile,
    usableServiceSpecialties:
      usableSpecialties,
  };
}

async function runEmergencyCertification({
  env = process.env,
  fetchImpl = globalThis.fetch,
  logger = console,
} = {}) {
  authorizeLiveExecution(env);

  const target = validateTarget(
    env.EMERGENCY_STAGING_BASE_URL
  );

  const homeownerToken = requireToken(
    env,
    "EMERGENCY_HOMEOWNER_BEARER_TOKEN"
  );

  const professionalToken = requireToken(
    env,
    "EMERGENCY_PROFESSIONAL_BEARER_TOKEN"
  );

  if (homeownerToken === professionalToken) {
    throw new VerificationFailure(
      "Homeowner and professional tokens must be different."
    );
  }

  const runId =
    String(env.EMERGENCY_CERTIFICATION_RUN_ID || "").trim() ||
    createRunId();

  const client = createHttpClient({
    baseUrl: target,
    fetchImpl,
  });

  const summary = createSummary({
    runId,
    target,
  });

  try {
    const homeowner = await verifyIdentity({
      client,
      token: homeownerToken,
      label: "Homeowner",
    });

    summary.identities.homeownerValidated = true;
    recordCheck(summary, "homeowner_identity", true, {
      userId: homeowner.id,
      accountType: homeowner.account_type,
    });

    const professional = await verifyIdentity({
      client,
      token: professionalToken,
      label: "Professional",
    });

    summary.identities.professionalValidated = true;
    recordCheck(
      summary,
      "professional_identity",
      true,
      {
        userId: professional.id,
        accountType: professional.account_type,
      }
    );

    if (Number(homeowner.id) === Number(professional.id)) {
      throw new VerificationFailure(
        "Certification identities must belong to different accounts."
      );
    }

    const professionalProfile =
      await verifyProfessionalProfile({
        client,
        token: professionalToken,
      });

    summary.identities.professionalProfileValidated =
      true;

    recordCheck(
      summary,
      "professional_profile",
      true,
      {
        profileId: professionalProfile.id,
        category: professionalProfile.category,
        serviceArea:
          professionalProfile.service_area,
        serviceSpecialties:
          professionalProfile.service_specialties,
        usableServiceSpecialties:
          professionalProfile
            .usableServiceSpecialties,
      }
    );

    const draftResponse = await client.request({
      method: "POST",
      endpoint: "/emergency-requests/drafts",
      token: homeownerToken,
      body: buildEmergencyDraft(runId),
    });

    assertStatus(
      draftResponse,
      201,
      "Emergency draft creation"
    );

    assertCode(
      draftResponse.body,
      "EMERGENCY_DRAFT_CREATED",
      "Emergency draft creation"
    );

    const emergencyRequestId =
      assertPositiveInteger(
        draftResponse.body?.emergencyRequest?.id,
        "Emergency request ID"
      );

    summary.resources.emergencyRequestId =
      emergencyRequestId;

    summary.retainedRecords.push({
      type: "emergency_request",
      id: emergencyRequestId,
      marker: runId,
      cleanupSupported: false,
    });

    recordCheck(
      summary,
      "emergency_draft_created",
      true,
      {
        emergencyRequestId,
        status:
          draftResponse.body.emergencyRequest.status,
      }
    );

    const safetyResponse = await client.request({
      method: "POST",
      endpoint:
        `/emergency-requests/${emergencyRequestId}/safety-assessment`,
      token: homeownerToken,
      body: buildSafeAssessment(),
    });

    assertStatus(
      safetyResponse,
      200,
      "Emergency safety assessment"
    );

    assertCode(
      safetyResponse.body,
      "EMERGENCY_SAFETY_ASSESSMENT_SAVED",
      "Emergency safety assessment"
    );

    if (
      safetyResponse.body?.emergencyRequest
        ?.safetyAssessment?.disposition !==
      "continue"
    ) {
      throw new VerificationFailure(
        "The server did not derive the expected safe disposition.",
        {
          emergencyRequest:
            safetyResponse.body?.emergencyRequest,
        }
      );
    }

    recordCheck(
      summary,
      "safety_assessment_saved",
      true,
      {
        disposition: "continue",
      }
    );

    const prepareResponse = await client.request({
      method: "POST",
      endpoint:
        `/emergency-requests/${emergencyRequestId}/prepare`,
      token: homeownerToken,
      body: {},
    });

    assertStatus(
      prepareResponse,
      200,
      "Emergency preparation"
    );

    assertCode(
      prepareResponse.body,
      "EMERGENCY_REQUEST_PREPARED",
      "Emergency preparation"
    );

    if (
      prepareResponse.body?.emergencyRequest?.status !==
      "ready_for_distribution"
    ) {
      throw new VerificationFailure(
        "Emergency request did not become ready for distribution.",
        {
          status:
            prepareResponse.body?.emergencyRequest
              ?.status,
        }
      );
    }

    recordCheck(
      summary,
      "emergency_prepared",
      true,
      {
        status: "ready_for_distribution",
      }
    );

    const opportunityResponse =
      await client.request({
        endpoint:
          "/professional-emergency-opportunities",
        token: professionalToken,
      });

    assertStatus(
      opportunityResponse,
      200,
      "Professional Emergency opportunities"
    );

    assertCode(
      opportunityResponse.body,
      "EMERGENCY_OPPORTUNITIES_FOUND",
      "Professional Emergency opportunities"
    );

    const opportunity = (
      opportunityResponse.body?.opportunities || []
    ).find(
      (item) =>
        Number(item.id) === emergencyRequestId
    );

    if (!opportunity) {
      throw new VerificationFailure(
        "The new Emergency request was not visible to the approved professional.",
        {
          emergencyRequestId,
          visibleOpportunityIds: (
            opportunityResponse.body?.opportunities ||
            []
          ).map((item) => item.id),
        }
      );
    }

    recordCheck(
      summary,
      "professional_opportunity_visible",
      true,
      {
        emergencyRequestId,
      }
    );

    const professionalResponse =
      await client.request({
        method: "POST",
        endpoint:
          `/professional-emergency-opportunities/${emergencyRequestId}/respond`,
        token: professionalToken,
        body: {},
      });

    assertStatus(
      professionalResponse,
      [200, 201],
      "Professional Emergency response"
    );

    assertCode(
      professionalResponse.body,
      [
        "EMERGENCY_RESPONSE_CREATED",
        "EMERGENCY_RESPONSE_EXISTS",
      ],
      "Professional Emergency response"
    );

    const relationshipId =
      assertPositiveInteger(
        professionalResponse.body?.relationship?.id,
        "Emergency relationship ID"
      );

    summary.resources.relationshipId =
      relationshipId;

    summary.retainedRecords.push({
      type: "request_relationship",
      id: relationshipId,
      marker: runId,
      cleanupSupported: false,
    });

    recordCheck(
      summary,
      "professional_response_created",
      true,
      {
        relationshipId,
        created:
          professionalResponse.body?.created,
      }
    );

    const inboxResponse = await client.request({
      endpoint:
        `/emergency-requests/${emergencyRequestId}/responses`,
      token: homeownerToken,
    });

    assertStatus(
      inboxResponse,
      200,
      "Homeowner Emergency responses"
    );

    assertCode(
      inboxResponse.body,
      "EMERGENCY_RESPONSES_FOUND",
      "Homeowner Emergency responses"
    );

    const homeownerResponse = (
      inboxResponse.body?.responses || []
    ).find(
      (item) =>
        Number(item.id) === relationshipId
    );

    if (!homeownerResponse) {
      throw new VerificationFailure(
        "The homeowner response inbox did not contain the professional response.",
        {
          relationshipId,
        }
      );
    }

    recordCheck(
      summary,
      "homeowner_response_visible",
      true,
      {
        relationshipId,
      }
    );

    const selectionResponse =
      await client.request({
        method: "POST",
        endpoint:
          `/emergency-requests/${emergencyRequestId}/responses/${relationshipId}/select`,
        token: homeownerToken,
        body: {},
      });

    assertStatus(
      selectionResponse,
      200,
      "Emergency professional selection"
    );

    assertCode(
      selectionResponse.body,
      "EMERGENCY_RESPONSE_SELECTED",
      "Emergency professional selection"
    );

    const conversationId =
      assertPositiveInteger(
        selectionResponse.body?.conversation?.id,
        "Emergency conversation ID"
      );

    summary.resources.conversationId =
      conversationId;

    summary.retainedRecords.push({
      type: "conversation",
      id: conversationId,
      marker: runId,
      cleanupSupported: false,
    });

    if (
      selectionResponse.body?.emergencyRequest
        ?.status !== "assigned" ||
      selectionResponse.body?.relationship?.status !==
        "active" ||
      selectionResponse.body?.conversation?.status !==
        "active"
    ) {
      throw new VerificationFailure(
        "Selection did not return the canonical assigned, active relationship, and active conversation state.",
        {
          body: redact(selectionResponse.body),
        }
      );
    }

    recordCheck(
      summary,
      "professional_selected",
      true,
      {
        relationshipId,
        conversationId,
      }
    );

    for (const transition of WORKFLOW) {
      const response = await client.request({
        method: "POST",
        endpoint:
          transition.endpoint(emergencyRequestId),
        token: professionalToken,
        body: {},
      });

      assertStatus(
        response,
        200,
        `Dispatch ${transition.name}`
      );

      assertCode(
        response.body,
        transition.successCode,
        `Dispatch ${transition.name}`
      );

      if (
        response.body?.alreadyApplied !== false ||
        response.body?.emergencyRequest?.status !==
          transition.status ||
        !response.body?.emergencyRequest?.[
          transition.timestampField
        ]
      ) {
        throw new VerificationFailure(
          `Dispatch ${transition.name} did not return the expected canonical state.`,
          {
            body: redact(response.body),
          }
        );
      }

      if (
        Number(response.body?.relationship?.id) !==
          relationshipId ||
        response.body?.relationship?.status !==
          "active" ||
        Number(response.body?.conversation?.id) !==
          conversationId ||
        response.body?.conversation?.status !==
          "active"
      ) {
        throw new VerificationFailure(
          `Dispatch ${transition.name} returned inconsistent relationship or conversation authority.`,
          {
            body: redact(response.body),
          }
        );
      }

      recordCheck(
        summary,
        `dispatch_${transition.name}`,
        true,
        {
          status: transition.status,
          timestamp:
            response.body.emergencyRequest[
              transition.timestampField
            ],
        }
      );

      const retry = await client.request({
        method: "POST",
        endpoint:
          transition.endpoint(emergencyRequestId),
        token: professionalToken,
        body: {},
      });

      assertStatus(
        retry,
        200,
        `Dispatch ${transition.name} retry`
      );

      assertCode(
        retry.body,
        transition.repeatCode,
        `Dispatch ${transition.name} retry`
      );

      if (retry.body?.alreadyApplied !== true) {
        throw new VerificationFailure(
          `Dispatch ${transition.name} retry was not reported as already applied.`,
          {
            body: redact(retry.body),
          }
        );
      }

      recordCheck(
        summary,
        `dispatch_${transition.name}_retry`,
        true,
        {
          code: retry.body.code,
          alreadyApplied: true,
        }
      );
    }

    const conversationResponse =
      await client.request({
        endpoint:
          `/conversations/${conversationId}`,
        token: homeownerToken,
      });

    assertStatus(
      conversationResponse,
      200,
      "Canonical conversation detail"
    );

    const conversationDetail =
      conversationResponse.body;

    if (
      Number(
        conversationDetail?.conversation?.id
      ) !== conversationId ||
      conversationDetail?.conversation?.type !==
        "emergency" ||
      Number(
        conversationDetail?.relationship?.id
      ) !== relationshipId ||
      Number(
        conversationDetail?.relationship
          ?.emergencyRequestId
      ) !== emergencyRequestId ||
      conversationDetail?.relationship?.source
        ?.type !== "emergency" ||
      Number(
        conversationDetail?.relationship?.source
          ?.id
      ) !== emergencyRequestId ||
      conversationDetail?.permissions?.canRead !==
        true
    ) {
      throw new VerificationFailure(
        "Canonical conversation detail did not resolve the selected Emergency conversation.",
        {
          body: redact(conversationDetail),
        }
      );
    }

    recordCheck(
      summary,
      "conversation_verified",
      true,
      {
        conversationId,
      }
    );

    const finalRequestResponse =
      await client.request({
        endpoint:
          `/emergency-requests/${emergencyRequestId}`,
        token: homeownerToken,
      });

    assertStatus(
      finalRequestResponse,
      200,
      "Final Emergency request"
    );

    assertCode(
      finalRequestResponse.body,
      "EMERGENCY_REQUEST_FOUND",
      "Final Emergency request"
    );

    const finalRequest =
      finalRequestResponse.body?.emergencyRequest;

    if (
      finalRequest?.status !== "completed" ||
      !finalRequest?.assignedAt ||
      !finalRequest?.enRouteAt ||
      !finalRequest?.arrivedAt ||
      !finalRequest?.workStartedAt ||
      !finalRequest?.completedAt
    ) {
      throw new VerificationFailure(
        "Final Emergency lifecycle state is incomplete.",
        {
          emergencyRequest: redact(finalRequest),
        }
      );
    }

    summary.finalState = {
      emergencyRequestId,
      relationshipId,
      conversationId,
      status: finalRequest.status,
      assignedAt: finalRequest.assignedAt,
      enRouteAt: finalRequest.enRouteAt,
      arrivedAt: finalRequest.arrivedAt,
      workStartedAt:
        finalRequest.workStartedAt,
      completedAt: finalRequest.completedAt,
    };

    recordCheck(
      summary,
      "final_emergency_state",
      true,
      summary.finalState
    );

    summary.success = true;
    summary.completedAt =
      new Date().toISOString();

    return summary;
  } catch (error) {
    summary.success = false;
    summary.completedAt =
      new Date().toISOString();

    summary.failure = redact({
      name: error?.name || "Error",
      message:
        error?.message ||
        "Emergency certification failed.",
      details: error?.details || {},
    });

    throw Object.assign(error, {
      certificationSummary: summary,
    });
  } finally {
    logger.error(
      JSON.stringify(redact(summary), null, 2)
    );
  }
}

async function main() {
  try {
    const summary =
      await runEmergencyCertification();

    process.stdout.write(
      `${JSON.stringify(redact(summary), null, 2)}\n`
    );

    // Retained staging records are intentional and
    // must prevent a misleading zero-risk exit.
    process.exitCode =
      summary.retainedRecords.length > 0
        ? 2
        : 0;
  } catch (error) {
    const summary =
      error?.certificationSummary || {
        success: false,
        failure: redact({
          name: error?.name || "Error",
          message:
            error?.message ||
            "Emergency certification failed.",
          details: error?.details || {},
        }),
      };

    process.stderr.write(
      `${JSON.stringify(redact(summary), null, 2)}\n`
    );

    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  EXPECTED_HOST,
  LIVE_GATE_ONE,
  LIVE_GATE_TWO,
  REQUIRED_CONFIRMATION,
  WORKFLOW,
  VerificationFailure,
  assertCode,
  assertPositiveInteger,
  assertStatus,
  authorizeLiveExecution,
  buildEmergencyDraft,
  buildSafeAssessment,
  createHttpClient,
  createRunId,
  redact,
  requireToken,
  runEmergencyCertification,
  validateTarget,
};
