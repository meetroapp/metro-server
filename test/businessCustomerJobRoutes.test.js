"use strict";

const assert =
  require("node:assert/strict");
const test =
  require("node:test");

const {
  createBusinessCustomerRelationshipHandlers,
  registerBusinessCustomerRelationshipRoutes,
} = require(
  "../server/relationships/businessCustomerRelationships"
);

test(
  "Customer Relationship router exposes governed New Job creation",
  () => {
    const routes = [];

    const app = {
      post(path, middleware, handler) {
        routes.push({
          method: "POST",
          path,
          middleware,
          handler,
        });
      },

      get(path, middleware, handler) {
        routes.push({
          method: "GET",
          path,
          middleware,
          handler,
        });
      },
    };

    const authMiddleware =
      function authMiddleware() {};

    registerBusinessCustomerRelationshipRoutes({
      app,
      authMiddleware,
      getPool() {
        return {};
      },
      sendPublicDatabaseError() {},
      relationshipService: {},
      customerJobService: {
        createBusinessCustomerJob() {},
      },
    });

    assert.equal(
      routes.some(
        (route) =>
          route.method === "POST" &&
          route.path ===
            "/business-customer-relationships/:relationshipId/jobs"
      ),
      true
    );
  }
);

test(
  "New Job handler forwards only relationship path project payload and idempotency key",
  async () => {
    let received = null;

    const handlers =
      createBusinessCustomerRelationshipHandlers({
        getPool() {
          return {
            query() {},
          };
        },
        sendPublicDatabaseError() {
          throw new Error(
            "unexpected database error"
          );
        },
        relationshipService: {},
        customerJobService: {
          async createBusinessCustomerJob(
            input
          ) {
            received = input;

            return {
              ok: true,
              status: 201,
              code:
                "BUSINESS_CUSTOMER_JOB_CREATED",
              job: {
                id:
                  "11111111-1111-4111-8111-111111111111",
              },
            };
          },
        },
      });

    const response = {
      statusCode: null,
      body: null,
      headers: {},

      setHeader(name, value) {
        this.headers[name] = value;
      },

      status(code) {
        this.statusCode = code;
        return this;
      },

      json(body) {
        this.body = body;
        return this;
      },
    };

    await handlers.createJob(
      {
        user: {
          id: 7,
        },
        params: {
          relationshipId:
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        },
        body: {
          projectTitle:
            "New external Job",
        },
        headers: {
          "idempotency-key":
            "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        },
      },
      response
    );

    assert.equal(
      response.statusCode,
      201
    );

    assert.equal(
      received.relationshipId,
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    );

    assert.deepEqual(
      received.payload,
      {
        projectTitle:
          "New external Job",
      }
    );

    assert.equal(
      Object.hasOwn(
        received.payload,
        "contractorProfileId"
      ),
      false
    );

    assert.equal(
      Object.hasOwn(
        received.payload,
        "professionalUserId"
      ),
      false
    );
  }
);
