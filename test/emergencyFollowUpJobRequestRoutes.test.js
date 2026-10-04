"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  MediaValidationError,
} = require("../server/media/cloudinary");
const {
  createEmergencyRequestHandlers,
  registerEmergencyRequestRoutes,
} = require("../server/emergency/emergencyRequests");

const ROUTE =
  "/emergency-requests/:emergencyRequestId/follow-up-job-request";

function response() {
  return {
    statusCode: 200,
    payload: null,
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
}

function baseServices(overrides = {}) {
  return {
    service: {
      async cancelEmergencyRequest() {},
      async createEmergencyDraft() {},
      async getOwnedEmergencyRequest() {},
      async listOwnedEmergencyRequests() {},
      async prepareEmergencyRequest() {},
      async saveEmergencySafetyAssessment() {},
      async updateEmergencyDraft() {},
      validateEmergencyRequestListOptions() {
        return { valid: true, value: {} };
      },
    },
    opportunityService: {
      async listHomeownerAvailableEmergencyProfessionals() {
        return {
          ok: true,
          emergencyRequest: { id: 41, status: "active" },
          professionals: [],
        };
      },
      async listProfessionalEmergencyOpportunities() {
        return { ok: true, opportunities: [] };
      },
      professionalCanSeeEmergencyOpportunity() {
        return true;
      },
    },
    relationshipService: {
      async createProfessionalEmergencyResponse() {},
      async listHomeownerEmergencyResponses() {
        return {
          ok: true,
          emergencyRequest: { id: 41, status: "active" },
          responses: [],
        };
      },
    },
    selectionService: {
      async selectHomeownerAvailableEmergencyProfessional() {},
      async selectHomeownerEmergencyResponse() {},
    },
    dispatchService: {
      async completeEmergencyWork() {},
      async markEmergencyArrived() {},
      async markEmergencyEnRoute() {},
      async startEmergencyWork() {},
    },
    followUpJobRequestService: {
      async createEmergencyFollowUpJobRequest() {
        return {
          ok: true,
          status: 201,
          code:
            "EMERGENCY_FOLLOW_UP_JOB_REQUEST_CREATED",
          replayed: false,
          emergencyRequestId: 41,
          emergencyJobId:
            "11111111-1111-4111-8111-111111111111",
          linkageId:
            "22222222-2222-4222-8222-222222222222",
          post: {
            id: 9001,
            title: "Replace damaged plumbing",
          },
          reportedConcern: {
            id: "concern",
          },
        };
      },
      ...overrides,
    },
  };
}

test(
  "Emergency follow-up Job Request route is registered with authentication first",
  () => {
    const calls = [];
    const authMiddleware = () => {};
    const services = baseServices();

    const app = {
      get(path, ...handlers) {
        calls.push({ method: "GET", path, handlers });
      },
      patch(path, ...handlers) {
        calls.push({
          method: "PATCH",
          path,
          handlers,
        });
      },
      post(path, ...handlers) {
        calls.push({
          method: "POST",
          path,
          handlers,
        });
      },
    };

    registerEmergencyRequestRoutes({
      app,
      authMiddleware,
      getPool() {
        return {};
      },
      sendPublicDatabaseError() {},
      ...services,
    });

    const route = calls.find(
      (item) =>
        item.method === "POST" &&
        item.path === ROUTE
    );

    assert.ok(route);
    assert.equal(
      route.handlers[0],
      authMiddleware
    );
    assert.equal(
      typeof route.handlers[1],
      "function"
    );
  }
);

test(
  "follow-up handler derives homeowner authority from authentication and forwards ordinary request payload",
  async () => {
    let captured = null;

    const services = baseServices({
      async createEmergencyFollowUpJobRequest(input) {
        captured = input;
        return {
          ok: true,
          status: 201,
          code:
            "EMERGENCY_FOLLOW_UP_JOB_REQUEST_CREATED",
          replayed: false,
          emergencyRequestId: 41,
          emergencyJobId:
            "11111111-1111-4111-8111-111111111111",
          linkageId:
            "22222222-2222-4222-8222-222222222222",
          post: { id: 9001 },
          reportedConcern: null,
        };
      },
    });

    const handlers = createEmergencyRequestHandlers({
      getPool(req) {
        return req.pool;
      },
      sendPublicDatabaseError() {
        throw new Error(
          "unexpected public database error"
        );
      },
      ...services,
    });

    const pool = { query() {} };
    const body = {
      title: "Replace damaged plumbing",
      description:
        "Larger scheduled repair.",
      homeowner_id: 999999,
    };

    const req = {
      pool,
      user: { id: 7 },
      params: {
        emergencyRequestId: "41",
      },
      body,
      headers: {
        "idempotency-key":
          "44444444-4444-4444-8444-444444444444",
      },
    };
    const res = response();

    await handlers.createFollowUpJobRequest(
      req,
      res
    );

    assert.ok(captured);
    assert.equal(captured.pool, pool);
    assert.deepEqual(
      captured.authenticatedActor,
      { id: 7 }
    );
    assert.equal(
      captured.emergencyRequestId,
      "41"
    );
    assert.equal(captured.payload, body);
    assert.equal(
      captured.idempotencyKey,
      "44444444-4444-4444-8444-444444444444"
    );

    assert.equal(res.statusCode, 201);
    assert.deepEqual(res.payload, {
      success: true,
      code:
        "EMERGENCY_FOLLOW_UP_JOB_REQUEST_CREATED",
      replayed: false,
      emergencyRequestId: 41,
      emergencyJobId:
        "11111111-1111-4111-8111-111111111111",
      linkageId:
        "22222222-2222-4222-8222-222222222222",
      post: { id: 9001 },
      reportedConcern: null,
    });
    assert.equal(
      res.headers["Cache-Control"],
      "private, no-store"
    );
  }
);

test(
  "follow-up handler exposes only stable failure status code and message",
  async () => {
    const services = baseServices({
      async createEmergencyFollowUpJobRequest() {
        return {
          ok: false,
          status: 409,
          code:
            "EMERGENCY_FOLLOW_UP_NOT_READY",
          message:
            "The Emergency must be completed before a Standard follow-up Job Request is created.",
          cause: new Error("private"),
          secret: "do-not-leak",
        };
      },
    });

    const handlers =
      createEmergencyRequestHandlers({
        getPool() {
          return { query() {} };
        },
        sendPublicDatabaseError() {
          throw new Error(
            "unexpected public database error"
          );
        },
        ...services,
      });

    const res = response();

    await handlers.createFollowUpJobRequest(
      {
        user: { id: 7 },
        params: {
          emergencyRequestId: "41",
        },
        body: {
          title: "Later work",
          description:
            "Scheduled follow-up.",
        },
        headers: {
          "idempotency-key":
            "44444444-4444-4444-8444-444444444444",
        },
      },
      res
    );

    assert.equal(res.statusCode, 409);
    assert.deepEqual(res.payload, {
      success: false,
      code:
        "EMERGENCY_FOLLOW_UP_NOT_READY",
      message:
        "The Emergency must be completed before a Standard follow-up Job Request is created.",
    });
    assert.doesNotMatch(
      JSON.stringify(res.payload),
      /private|secret|cause|cleanupPhotos/i
    );
  }
);

test(
  "follow-up route preserves governed request-photo validation errors",
  async () => {
    const services = baseServices({
      async createEmergencyFollowUpJobRequest() {
        throw new MediaValidationError(
          "MEDIA_ASSET_OWNERSHIP_INVALID"
        );
      },
    });

    const handlers =
      createEmergencyRequestHandlers({
        getPool() {
          return { query() {} };
        },
        sendPublicDatabaseError() {
          throw new Error(
            "database normalizer must not run"
          );
        },
        ...services,
      });

    const res = response();

    await handlers.createFollowUpJobRequest(
      {
        user: { id: 7 },
        params: {
          emergencyRequestId: "41",
        },
        body: {
          title: "Later work",
          description:
            "Scheduled follow-up.",
        },
        headers: {
          "idempotency-key":
            "44444444-4444-4444-8444-444444444444",
        },
      },
      res
    );

    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.payload, {
      success: false,
      code:
        "MEDIA_ASSET_OWNERSHIP_INVALID",
      message:
        "The media request is invalid.",
    });
  }
);

test(
  "failed parent transaction cleans only service-provided newly created request photos",
  async () => {
    const deleted = [];

    const services = baseServices({
      async createEmergencyFollowUpJobRequest() {
        return {
          ok: false,
          status: 500,
          code:
            "EMERGENCY_FOLLOW_UP_JOB_REQUEST_FAILED",
          message:
            "The Standard follow-up Job Request could not be created.",
          cleanupPhotos: [
            {
              public_id:
                "meetro/users/7/request-photos/new-one",
            },
          ],
        };
      },
    });

    const handlers =
      createEmergencyRequestHandlers({
        getPool() {
          return { query() {} };
        },
        sendPublicDatabaseError() {
          throw new Error(
            "unexpected database normalizer"
          );
        },
        ...services,
      });

    const res = response();

    await handlers.createFollowUpJobRequest(
      {
        app: {
          locals: {
            cloudinaryMedia: {
              async deleteOwnedAsset(
                publicId,
                options
              ) {
                deleted.push({
                  publicId,
                  options,
                });
              },
            },
          },
        },
        user: { id: 7 },
        params: {
          emergencyRequestId: "41",
        },
        body: {
          title: "Later work",
          description:
            "Scheduled follow-up.",
        },
        headers: {
          "idempotency-key":
            "44444444-4444-4444-8444-444444444444",
        },
      },
      res
    );

    assert.equal(res.statusCode, 500);
    assert.equal(deleted.length, 1);
    assert.equal(
      deleted[0].publicId,
      "meetro/users/7/request-photos/new-one"
    );
    assert.deepEqual(
      deleted[0].options,
      {
        purpose: "request-photo",
        ownership: { userId: 7 },
        resourceType: "image",
      }
    );
  }
);

test(
  "legacy image_url is rejected before follow-up service execution",
  async () => {
    let called = false;

    const services = baseServices({
      async createEmergencyFollowUpJobRequest() {
        called = true;
        throw new Error(
          "service must not run"
        );
      },
    });

    const handlers =
      createEmergencyRequestHandlers({
        getPool() {
          return { query() {} };
        },
        sendPublicDatabaseError() {
          throw new Error(
            "database normalizer must not run"
          );
        },
        ...services,
      });

    const res = response();

    await handlers.createFollowUpJobRequest(
      {
        user: { id: 7 },
        params: {
          emergencyRequestId: "41",
        },
        body: {
          title: "Later work",
          description:
            "Scheduled follow-up.",
          image_url:
            "https://example.test/ungoverned.jpg",
        },
        headers: {
          "idempotency-key":
            "44444444-4444-4444-8444-444444444444",
        },
      },
      res
    );

    assert.equal(called, false);
    assert.equal(res.statusCode, 400);
    assert.equal(
      res.payload.code,
      "GOVERNED_MEDIA_REFERENCE_REQUIRED"
    );
  }
);

test(
  "unexpected follow-up route failure uses the governed public database error path",
  async () => {
    const marker =
      new Error("simulated internal failure");
    let captured = null;

    const services = baseServices({
      async createEmergencyFollowUpJobRequest() {
        throw marker;
      },
    });

    const handlers =
      createEmergencyRequestHandlers({
        getPool() {
          return { query() {} };
        },
        sendPublicDatabaseError(args) {
          captured = args;
          return "sent";
        },
        ...services,
      });

    const res = response();
    const result =
      await handlers.createFollowUpJobRequest(
        {
          user: { id: 7 },
          params: {
            emergencyRequestId: "41",
          },
          body: {
            title: "Later work",
            description:
              "Scheduled follow-up.",
          },
          headers: {
            "idempotency-key":
              "44444444-4444-4444-8444-444444444444",
          },
        },
        res
      );

    assert.equal(result, "sent");
    assert.equal(captured.res, res);
    assert.equal(
      captured.error,
      marker
    );
    assert.equal(
      captured.operation,
      "create_emergency_follow_up_job_request"
    );
    assert.equal(
      captured.code,
      "EMERGENCY_FOLLOW_UP_JOB_REQUEST_FAILED"
    );
  }
);
