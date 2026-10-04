"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createHomeownerProfessionalsHandlers,
  registerHomeownerProfessionalsRoutes,
} = require(
  "../server/relationships/homeownerProfessionals"
);

function response() {
  return {
    statusCode: null,
    payload: null,
    headers: {},

    setHeader(name, value) {
      this.headers[name] = value;
    },

    status(value) {
      this.statusCode = value;
      return this;
    },

    json(value) {
      this.payload = value;
      return this;
    },
  };
}

test("registers authenticated Save and Remove routes", () => {
  const routes = [];

  const app = {
    get(...args) {
      routes.push([
        "GET",
        ...args,
      ]);
    },

    post(...args) {
      routes.push([
        "POST",
        ...args,
      ]);
    },
  };

  const authMiddleware = () => {};

  registerHomeownerProfessionalsRoutes({
    app,
    authMiddleware,
    getPool: () => ({
      query() {},
    }),
    sendPublicDatabaseError() {},
    directoryService: {
      async listHomeownerProfessionals() {
        return {
          ok: true,
          status: 200,
          code:
            "HOMEOWNER_PROFESSIONALS_LISTED",
          saved: [],
          workedWith: [],
        };
      },
    },
    mutationService: {
      async saveHomeownerProfessional() {},
      async removeHomeownerSavedProfessional() {},
    },
  });

  const save = routes.find(
    ([method, route]) =>
      method === "POST" &&
      route ===
        "/my-professionals/:contractorProfileId/save"
  );

  const remove = routes.find(
    ([method, route]) =>
      method === "POST" &&
      route ===
        "/my-professionals/:contractorProfileId/remove"
  );

  assert.ok(save);
  assert.ok(remove);

  assert.equal(
    save[2],
    authMiddleware
  );

  assert.equal(
    remove[2],
    authMiddleware
  );
});

test("Save receives exact authenticated actor, route professional, and idempotency key", async () => {
  const expectedPool = {
    query() {},
  };

  let received = null;

  const handlers =
    createHomeownerProfessionalsHandlers({
      getPool: () => expectedPool,

      sendPublicDatabaseError() {},

      directoryService: {
        async listHomeownerProfessionals() {},
      },

      mutationService: {
        async saveHomeownerProfessional(input) {
          received = input;

          return {
            ok: true,
            status: 201,
            code:
              "HOMEOWNER_PROFESSIONAL_SAVED",
            savedProfessional: {
              contractorProfileId: 21,
              status: "SAVED",
            },
          };
        },

        async removeHomeownerSavedProfessional() {
          throw new Error(
            "Unexpected remove."
          );
        },
      },
    });

  const res = response();

  await handlers.save(
    {
      user: {
        id: 77,
      },

      params: {
        contractorProfileId: "21",
      },

      headers: {
        "idempotency-key":
          "11111111-1111-4111-8111-111111111111",
      },
    },
    res
  );

  assert.deepEqual(received, {
    pool: expectedPool,

    authenticatedActor: {
      id: 77,
    },

    contractorProfileId: "21",

    idempotencyKey:
      "11111111-1111-4111-8111-111111111111",
  });

  assert.equal(
    res.statusCode,
    201
  );

  assert.equal(
    res.payload.success,
    true
  );

  assert.equal(
    res.payload.code,
    "HOMEOWNER_PROFESSIONAL_SAVED"
  );

  assert.deepEqual(
    res.payload.savedProfessional,
    {
      contractorProfileId: 21,
      status: "SAVED",
    }
  );

  assert.equal(
    res.headers["Cache-Control"],
    "private, no-store"
  );
});

test("Remove uses the same authenticated mutation boundary", async () => {
  let received = null;

  const handlers =
    createHomeownerProfessionalsHandlers({
      getPool: () => ({
        query() {},
      }),

      sendPublicDatabaseError() {},

      directoryService: {
        async listHomeownerProfessionals() {},
      },

      mutationService: {
        async saveHomeownerProfessional() {
          throw new Error(
            "Unexpected save."
          );
        },

        async removeHomeownerSavedProfessional(input) {
          received = input;

          return {
            ok: true,
            status: 200,
            code:
              "HOMEOWNER_PROFESSIONAL_REMOVED",
            savedProfessional: {
              contractorProfileId: 21,
              status: "REMOVED",
            },
          };
        },
      },
    });

  const res = response();

  await handlers.remove(
    {
      user: {
        id: 77,
      },

      params: {
        contractorProfileId: "21",
      },

      headers: {
        "idempotency-key":
          "22222222-2222-4222-8222-222222222222",
      },
    },
    res
  );

  assert.equal(
    received.authenticatedActor.id,
    77
  );

  assert.equal(
    received.contractorProfileId,
    "21"
  );

  assert.equal(
    received.idempotencyKey,
    "22222222-2222-4222-8222-222222222222"
  );

  assert.equal(
    res.payload.code,
    "HOMEOWNER_PROFESSIONAL_REMOVED"
  );
});

test("mutation exceptions stay behind the public database error boundary", async () => {
  const expectedError =
    new Error("database unavailable");

  let publicError = null;

  const handlers =
    createHomeownerProfessionalsHandlers({
      getPool: () => ({
        query() {},
      }),

      sendPublicDatabaseError(input) {
        publicError = input;
        return "public-error";
      },

      directoryService: {
        async listHomeownerProfessionals() {},
      },

      mutationService: {
        async saveHomeownerProfessional() {
          throw expectedError;
        },

        async removeHomeownerSavedProfessional() {
          throw expectedError;
        },
      },
    });

  const result =
    await handlers.save(
      {
        user: {
          id: 77,
        },
        params: {
          contractorProfileId: "21",
        },
        headers: {
          "idempotency-key":
            "33333333-3333-4333-8333-333333333333",
        },
      },
      response()
    );

  assert.equal(
    result,
    "public-error"
  );

  assert.equal(
    publicError.error,
    expectedError
  );

  assert.equal(
    publicError.operation,
    "save_homeowner_professional"
  );

  assert.equal(
    publicError.code,
    "HOMEOWNER_PROFESSIONALS_FAILED"
  );
});
