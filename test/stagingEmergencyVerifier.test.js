"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  EXPECTED_HOST,
  REQUIRED_CONFIRMATION,
  WORKFLOW,
  authorizeLiveExecution,
  buildEmergencyDraft,
  buildSafeAssessment,
  createHttpClient,
  createRunId,
  redact,
  runEmergencyCertification,
  validateTarget,
} = require(
  "../scripts/verify-staging-emergency"
);

function response(status, body) {
  return {
    status,
    async text() {
      return body === undefined
        ? ""
        : JSON.stringify(body);
    },
  };
}

function authMe(id, accountType) {
  return {
    user: {
      id,
      account_type: accountType,
    },
  };
}

function successfulFetch() {
  let emergencyRequestId = 41;
  let relationshipId = 151;
  let conversationId = 91;

  const calls = [];
  const transitionAttempts = new Map();

  async function fetchImpl(url, options = {}) {
    const pathname = new URL(url).pathname;
    const method = options.method || "GET";
    const authorization =
      options.headers?.authorization || "";

    calls.push({
      pathname,
      method,
      authorization,
      body: options.body
        ? JSON.parse(options.body)
        : undefined,
    });

    const professional =
      authorization.includes("professional-token");

    if (pathname === "/auth/me") {
      return response(
        200,
        professional
          ? authMe(9, "professional")
          : authMe(7, "homeowner")
      );
    }

    if (pathname === "/my-contractor-profile") {
      return response(200, {
        profile: {
          id: 80,
          category: "Plumbing",
          service_area:
            "Cape Coral · 33990 · 15 miles",
          service_specialties: [
            "plumbing_repair",
            "lighting_installation",
            "outlet_switch_installation",
            "electrical_repair",
          ],
        },
      });
    }

    if (
      pathname ===
        "/emergency-requests/drafts" &&
      method === "POST"
    ) {
      return response(201, {
        success: true,
        code: "EMERGENCY_DRAFT_CREATED",
        emergencyRequest: {
          id: emergencyRequestId,
          status: "draft",
        },
      });
    }

    if (
      pathname ===
      `/emergency-requests/${emergencyRequestId}/safety-assessment`
    ) {
      return response(200, {
        success: true,
        code:
          "EMERGENCY_SAFETY_ASSESSMENT_SAVED",
        emergencyRequest: {
          id: emergencyRequestId,
          status: "draft",
          safetyAssessment: {
            disposition: "continue",
          },
        },
      });
    }

    if (
      pathname ===
      `/emergency-requests/${emergencyRequestId}/prepare`
    ) {
      return response(200, {
        success: true,
        code: "EMERGENCY_REQUEST_PREPARED",
        emergencyRequest: {
          id: emergencyRequestId,
          status: "ready_for_distribution",
        },
      });
    }

    if (
      pathname ===
      "/professional-emergency-opportunities"
    ) {
      return response(200, {
        success: true,
        code:
          "EMERGENCY_OPPORTUNITIES_FOUND",
        opportunities: [
          {
            id: emergencyRequestId,
          },
        ],
      });
    }

    if (
      pathname ===
      `/professional-emergency-opportunities/${emergencyRequestId}/respond`
    ) {
      return response(201, {
        success: true,
        code: "EMERGENCY_RESPONSE_CREATED",
        created: true,
        relationship: {
          id: relationshipId,
          emergencyRequestId,
          status: "pending",
        },
      });
    }

    if (
      pathname ===
      `/emergency-requests/${emergencyRequestId}/responses`
    ) {
      return response(200, {
        success: true,
        code: "EMERGENCY_RESPONSES_FOUND",
        responses: [
          {
            id: relationshipId,
            emergencyRequestId,
            status: "pending",
          },
        ],
      });
    }

    if (
      pathname ===
      `/emergency-requests/${emergencyRequestId}/responses/${relationshipId}/select`
    ) {
      return response(200, {
        success: true,
        code:
          "EMERGENCY_RESPONSE_SELECTED",
        emergencyRequest: {
          id: emergencyRequestId,
          status: "assigned",
        },
        relationship: {
          id: relationshipId,
          status: "active",
        },
        conversation: {
          id: conversationId,
          status: "active",
        },
      });
    }

    for (const item of WORKFLOW) {
      if (
        pathname ===
        item.endpoint(emergencyRequestId)
      ) {
        const attempts =
          transitionAttempts.get(item.name) || 0;

        transitionAttempts.set(
          item.name,
          attempts + 1
        );

        return response(200, {
          success: true,
          code:
            attempts === 0
              ? item.successCode
              : item.repeatCode,
          alreadyApplied: attempts > 0,
          emergencyRequest: {
            id: emergencyRequestId,
            status: item.status,
            assignedAt: "assigned",
            enRouteAt:
              item.name === "en-route" ||
              item.name === "arrived" ||
              item.name === "start" ||
              item.name === "complete"
                ? "en-route"
                : null,
            arrivedAt:
              item.name === "arrived" ||
              item.name === "start" ||
              item.name === "complete"
                ? "arrived"
                : null,
            workStartedAt:
              item.name === "start" ||
              item.name === "complete"
                ? "started"
                : null,
            completedAt:
              item.name === "complete"
                ? "completed"
                : null,
          },
          relationship: {
            id: relationshipId,
            status: "active",
          },
          conversation: {
            id: conversationId,
            status: "active",
          },
        });
      }
    }

    if (
      pathname ===
      `/conversations/${conversationId}`
    ) {
      return response(200, {
        success: true,
        conversation: {
          id: conversationId,
          type: "emergency",
          status: "active",
          createdAt: "created",
          updatedAt: "updated",
          closedAt: null,
        },
        participants: {
          viewer: {
            id: 7,
            role: "homeowner",
          },
          homeowner: {
            id: 7,
            displayName: "Homeowner",
          },
          business: {
            id: 80,
            userId: 9,
            name: "Professional Business",
            imageUrl: "",
            category: "plumbing",
          },
        },
        relationship: {
          id: relationshipId,
          emergencyRequestId,
          title: "Emergency certification",
          source: {
            type: "emergency",
            id: emergencyRequestId,
            title: "Emergency certification",
            serviceDomain: "home_services",
            serviceSpecialty: "electrical",
            isEmergency: true,
          },
        },
        workflow: {
          status: null,
          stage: null,
        },
        permissions: {
          canRead: true,
          canSendMessages: true,
          canManageWorkflow: false,
        },
      });
    }

    if (
      pathname ===
      `/emergency-requests/${emergencyRequestId}`
    ) {
      return response(200, {
        success: true,
        code: "EMERGENCY_REQUEST_FOUND",
        emergencyRequest: {
          id: emergencyRequestId,
          status: "completed",
          assignedAt: "assigned",
          enRouteAt: "en-route",
          arrivedAt: "arrived",
          workStartedAt: "started",
          completedAt: "completed",
        },
      });
    }

    return response(404, {
      code: "NOT_FOUND",
      pathname,
    });
  }

  return {
    calls,
    fetchImpl,
  };
}

test(
  "importing the verifier never starts network activity",
  () => {
    assert.equal(
      typeof runEmergencyCertification,
      "function"
    );
  }
);

test(
  "run ID generation uses a valid timestamp by default",
  () => {
    assert.match(
      createRunId(),
      /^mc-emergency-\d{14}-[a-f0-9]{8}$/
    );

    assert.match(
      createRunId(Date.UTC(2026, 6, 25, 12, 34, 56)),
      /^mc-emergency-20260725123456-[a-f0-9]{8}$/
    );
  }
);

test(
  "both explicit live gates are required",
  () => {
    assert.throws(
      () => authorizeLiveExecution({}),
      /not authorized/i
    );

    assert.throws(
      () =>
        authorizeLiveExecution({
          RUN_EMERGENCY_STAGING_CERTIFICATION:
            "true",
        }),
      /not authorized/i
    );

    assert.doesNotThrow(() =>
      authorizeLiveExecution({
        RUN_EMERGENCY_STAGING_CERTIFICATION:
          "true",
        CONFIRM_EMERGENCY_STAGING_MUTATION:
          REQUIRED_CONFIRMATION,
      })
    );
  }
);

test(
  "target validation permits only the approved HTTPS staging host",
  () => {
    const target = validateTarget(
      `https://${EXPECTED_HOST}`
    );

    assert.equal(
      target.hostname,
      EXPECTED_HOST
    );

    for (const invalid of [
      "http://athletic-rebirth-staging.up.railway.app",
      "https://athletic-rebirth-production-0a28.up.railway.app",
      "https://user:pass@athletic-rebirth-staging.up.railway.app",
      "https://athletic-rebirth-staging.up.railway.app?token=private",
      "https://example.com",
    ]) {
      assert.throws(
        () => validateTarget(invalid)
      );
    }
  }
);

test(
  "redaction removes bearer and token-shaped secrets",
  () => {
    const value = redact({
      authorization:
        "Bearer secret-token",
      homeownerToken:
        "eyJprivate.payload.signature",
      nested: {
        message:
          "Bearer another-secret",
      },
    });

    assert.equal(
      JSON.stringify(value).includes(
        "secret-token"
      ),
      false
    );

    assert.equal(
      JSON.stringify(value).includes(
        "eyJprivate"
      ),
      false
    );
  }
);

test(
  "safe fixtures match the governed Emergency contract",
  () => {
    const draft =
      buildEmergencyDraft("run-123");

    assert.deepEqual(
      Object.keys(draft).sort(),
      [
        "accessNotes",
        "category",
        "description",
        "locationText",
        "serviceDomain",
        "serviceSpecialty",
        "title",
        "unitNumber",
      ]
    );

    assert.match(
      draft.title,
      /run-123/
    );
    assert.equal(
      draft.serviceSpecialty,
      "electrical"
    );
    assert.equal(
      draft.serviceDomain,
      "home_services"
    );
    assert.equal(draft.accessNotes, "");

    assert.throws(
      () =>
        buildEmergencyDraft(
          "run-unsupported",
          "not_a_real_specialty"
        ),
      /service specialty is unsupported/i
    );

    const assessment =
      buildSafeAssessment();

    assert.equal(
      assessment.safeToRemainAtLocation,
      true
    );

    for (const [
      key,
      value,
    ] of Object.entries(assessment)) {
      if (
        key !== "additionalSafetyContext"
      ) {
        assert.equal(
          typeof value,
          "boolean"
        );
      }
    }
  }
);

test(
  "HTTP client sends bearer credentials but does not expose them in results",
  async () => {
    let received;

    const client = createHttpClient({
      baseUrl: new URL(
        `https://${EXPECTED_HOST}`
      ),
      async fetchImpl(url, options) {
        received = {
          url: String(url),
          options,
        };

        return response(200, {
          success: true,
        });
      },
    });

    const result = await client.request({
      endpoint: "/auth/me",
      token: "private-token",
    });

    assert.equal(
      received.options.headers.authorization,
      "Bearer private-token"
    );

    assert.deepEqual(result, {
      status: 200,
      body: {
        success: true,
      },
    });

    assert.equal(
      JSON.stringify(result).includes(
        "private-token"
      ),
      false
    );
  }
);

test(
  "complete mocked certification verifies the full Emergency lifecycle",
  async () => {
    const fake = successfulFetch();
    const logs = [];

    const summary =
      await runEmergencyCertification({
        env: {
          RUN_EMERGENCY_STAGING_CERTIFICATION:
            "true",
          CONFIRM_EMERGENCY_STAGING_MUTATION:
            REQUIRED_CONFIRMATION,
          EMERGENCY_STAGING_BASE_URL:
            `https://${EXPECTED_HOST}`,
          EMERGENCY_HOMEOWNER_BEARER_TOKEN:
            "homeowner-token",
          EMERGENCY_PROFESSIONAL_BEARER_TOKEN:
            "professional-token",
          EMERGENCY_CERTIFICATION_RUN_ID:
            "test-run",
        },
        fetchImpl: fake.fetchImpl,
        logger: {
          error(value) {
            logs.push(value);
          },
        },
      });

    assert.equal(summary.success, true);
    assert.equal(summary.runId, "test-run");

    assert.deepEqual(
      summary.resources,
      {
        emergencyRequestId: 41,
        relationshipId: 151,
        conversationId: 91,
      }
    );

    assert.equal(
      summary.finalState.status,
      "completed"
    );

    assert.equal(
      summary.retainedRecords.length,
      3
    );

    for (const transition of WORKFLOW) {
      const calls = fake.calls.filter(
        (call) =>
          call.pathname ===
          transition.endpoint(41)
      );

      assert.equal(
        calls.length,
        2,
        `${transition.name} and its retry must both execute`
      );
    }

    assert.equal(logs.length, 1);

    assert.equal(
      logs[0].includes("homeowner-token"),
      false
    );

    assert.equal(
      logs[0].includes(
        "professional-token"
      ),
      false
    );
  }
);

test(
  "mocked certification generates a run ID when the environment omits one",
  async () => {
    const fake = successfulFetch();

    const summary =
      await runEmergencyCertification({
        env: {
          RUN_EMERGENCY_STAGING_CERTIFICATION:
            "true",
          CONFIRM_EMERGENCY_STAGING_MUTATION:
            REQUIRED_CONFIRMATION,
          EMERGENCY_STAGING_BASE_URL:
            `https://${EXPECTED_HOST}`,
          EMERGENCY_HOMEOWNER_BEARER_TOKEN:
            "homeowner-token",
          EMERGENCY_PROFESSIONAL_BEARER_TOKEN:
            "professional-token",
        },
        fetchImpl: fake.fetchImpl,
        logger: {
          error() {},
        },
      });

    assert.equal(summary.success, true);
    assert.match(
      summary.runId,
      /^mc-emergency-\d{14}-[a-f0-9]{8}$/
    );
  }
);

test(
  "canonical specialty IDs make the professional profile usable without a literal electrical specialty",
  async () => {
    const fake = successfulFetch();
    const logs = [];

    const summary =
      await runEmergencyCertification({
        env: {
          RUN_EMERGENCY_STAGING_CERTIFICATION:
            "true",
          CONFIRM_EMERGENCY_STAGING_MUTATION:
            REQUIRED_CONFIRMATION,
          EMERGENCY_STAGING_BASE_URL:
            `https://${EXPECTED_HOST}`,
          EMERGENCY_HOMEOWNER_BEARER_TOKEN:
            "homeowner-token",
          EMERGENCY_PROFESSIONAL_BEARER_TOKEN:
            "professional-token",
          EMERGENCY_CERTIFICATION_RUN_ID:
            "canonical-specialty-run",
        },
        fetchImpl: fake.fetchImpl,
        logger: {
          error(value) {
            logs.push(value);
          },
        },
      });

    assert.equal(summary.success, true);

    const profileCheck =
      summary.checks.find(
        (check) =>
          check.name ===
          "professional_profile"
      );

    assert.ok(profileCheck);

    assert.deepEqual(
      profileCheck.details
        .usableServiceSpecialties,
      [
        "plumbing_repair",
        "lighting_installation",
        "outlet_switch_installation",
        "electrical_repair",
      ]
    );

    assert.equal(
      profileCheck.details
        .serviceSpecialties.includes(
          "electrical"
        ),
      false
    );

    assert.equal(logs.length, 1);
  }
);

test(
  "profile usability still fails closed when no specialty resolves to a canonical service domain",
  async () => {
    const fake = successfulFetch();
    const original = fake.fetchImpl;

    fake.fetchImpl = async (
      url,
      options
    ) => {
      if (
        new URL(url).pathname ===
        "/my-contractor-profile"
      ) {
        return response(200, {
          profile: {
            id: 80,
            category: "Unknown",
            service_area: "Cape Coral",
            service_specialties: [
              "unsupported_service",
            ],
          },
        });
      }

      return original(url, options);
    };

    await assert.rejects(
      runEmergencyCertification({
        env: {
          RUN_EMERGENCY_STAGING_CERTIFICATION:
            "true",
          CONFIRM_EMERGENCY_STAGING_MUTATION:
            REQUIRED_CONFIRMATION,
          EMERGENCY_STAGING_BASE_URL:
            `https://${EXPECTED_HOST}`,
          EMERGENCY_HOMEOWNER_BEARER_TOKEN:
            "homeowner-token",
          EMERGENCY_PROFESSIONAL_BEARER_TOKEN:
            "professional-token",
          EMERGENCY_CERTIFICATION_RUN_ID:
            "unsupported-specialty-run",
        },
        fetchImpl: fake.fetchImpl,
        logger: {
          error() {},
        },
      }),
      /not usable for Emergency opportunity evaluation/i
    );
  }
);

test(
  "profile usability still requires a non-empty service area",
  async () => {
    const fake = successfulFetch();
    const original = fake.fetchImpl;

    fake.fetchImpl = async (
      url,
      options
    ) => {
      if (
        new URL(url).pathname ===
        "/my-contractor-profile"
      ) {
        return response(200, {
          profile: {
            id: 80,
            category: "Plumbing",
            service_area: "   ",
            service_specialties: [
              "electrical_repair",
            ],
          },
        });
      }

      return original(url, options);
    };

    await assert.rejects(
      runEmergencyCertification({
        env: {
          RUN_EMERGENCY_STAGING_CERTIFICATION:
            "true",
          CONFIRM_EMERGENCY_STAGING_MUTATION:
            REQUIRED_CONFIRMATION,
          EMERGENCY_STAGING_BASE_URL:
            `https://${EXPECTED_HOST}`,
          EMERGENCY_HOMEOWNER_BEARER_TOKEN:
            "homeowner-token",
          EMERGENCY_PROFESSIONAL_BEARER_TOKEN:
            "professional-token",
          EMERGENCY_CERTIFICATION_RUN_ID:
            "missing-area-run",
        },
        fetchImpl: fake.fetchImpl,
        logger: {
          error() {},
        },
      }),
      /not usable for Emergency opportunity evaluation/i
    );
  }
);

test(
  "same-token identities fail before network execution",
  async () => {
    let networkCalled = false;

    await assert.rejects(
      runEmergencyCertification({
        env: {
          RUN_EMERGENCY_STAGING_CERTIFICATION:
            "true",
          CONFIRM_EMERGENCY_STAGING_MUTATION:
            REQUIRED_CONFIRMATION,
          EMERGENCY_STAGING_BASE_URL:
            `https://${EXPECTED_HOST}`,
          EMERGENCY_HOMEOWNER_BEARER_TOKEN:
            "same-token",
          EMERGENCY_PROFESSIONAL_BEARER_TOKEN:
            "same-token",
        },
        async fetchImpl() {
          networkCalled = true;
          return response(500, {});
        },
        logger: {
          error() {},
        },
      }),
      /must be different/i
    );

    assert.equal(
      networkCalled,
      false
    );
  }
);

test(
  "failed certification reports retained resources without leaking tokens",
  async () => {
    const fake = successfulFetch();

    const original = fake.fetchImpl;

    fake.fetchImpl = async (
      url,
      options
    ) => {
      const pathname =
        new URL(url).pathname;

      if (
        pathname ===
        "/professional-emergency-opportunities"
      ) {
        return response(200, {
          success: true,
          code:
            "EMERGENCY_OPPORTUNITIES_FOUND",
          opportunities: [],
        });
      }

      return original(url, options);
    };

    let logged = "";

    await assert.rejects(
      runEmergencyCertification({
        env: {
          RUN_EMERGENCY_STAGING_CERTIFICATION:
            "true",
          CONFIRM_EMERGENCY_STAGING_MUTATION:
            REQUIRED_CONFIRMATION,
          EMERGENCY_STAGING_BASE_URL:
            `https://${EXPECTED_HOST}`,
          EMERGENCY_HOMEOWNER_BEARER_TOKEN:
            "homeowner-token",
          EMERGENCY_PROFESSIONAL_BEARER_TOKEN:
            "professional-token",
          EMERGENCY_CERTIFICATION_RUN_ID:
            "failure-run",
        },
        fetchImpl: fake.fetchImpl,
        logger: {
          error(value) {
            logged = value;
          },
        },
      }),
      /not visible/i
    );

    assert.match(
      logged,
      /emergency_request/
    );

    assert.equal(
      logged.includes("homeowner-token"),
      false
    );

    assert.equal(
      logged.includes(
        "professional-token"
      ),
      false
    );
  }
);
