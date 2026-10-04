"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  createHomeownerProfessionalsHandlers,
  registerHomeownerProfessionalsRoutes,
} = require(
  "../server/relationships/homeownerProfessionals"
);

function createResponse() {
  return {
    statusCode: null,
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

test("registers authenticated GET /my-professionals", () => {
  const registrations = [];

  const app = {
    get(...args) {
      registrations.push(["GET", ...args]);
    },
    post(...args) {
      registrations.push(["POST", ...args]);
    },
  };

  const authMiddleware = () => {};
  const directoryService = {
    async listHomeownerProfessionals() {
      return {
        ok: true,
        status: 200,
        code: "HOMEOWNER_PROFESSIONALS_LISTED",
        saved: [],
        workedWith: [],
      };
    },
  };

  registerHomeownerProfessionalsRoutes({
    app,
    authMiddleware,
    getPool: () => ({ query() {} }),
    sendPublicDatabaseError() {},
    directoryService,
  });

  assert.equal(registrations.length, 3);

  const list = registrations.find(
    ([method, route]) =>
      method === "GET" &&
      route === "/my-professionals"
  );

  assert.ok(list);
  assert.equal(list[2], authMiddleware);
  assert.equal(typeof list[3], "function");
});

test("passes exact authenticated homeowner identity to the directory service", async () => {
  const expectedPool = {
    query() {},
  };

  let received = null;

  const directoryService = {
    async listHomeownerProfessionals(input) {
      received = input;

      return {
        ok: true,
        status: 200,
        code: "HOMEOWNER_PROFESSIONALS_LISTED",
        saved: [
          {
            contractorProfileId: 21,
            businessName: "Saved Plumbing",
          },
        ],
        workedWith: [
          {
            contractorProfileId: 22,
            businessName: "Repeat Electric",
          },
        ],
      };
    },
  };

  const handlers =
    createHomeownerProfessionalsHandlers({
      getPool: () => expectedPool,
      sendPublicDatabaseError() {},
      directoryService,
    });

  const req = {
    user: {
      id: 77,
    },
  };

  const res = createResponse();

  await handlers.list(req, res);

  assert.deepEqual(received, {
    pool: expectedPool,
    homeownerUserId: 77,
  });

  assert.equal(res.statusCode, 200);
  assert.equal(
    res.headers["Cache-Control"],
    "private, no-store"
  );

  assert.deepEqual(res.payload, {
    success: true,
    code: "HOMEOWNER_PROFESSIONALS_LISTED",
    saved: [
      {
        contractorProfileId: 21,
        businessName: "Saved Plumbing",
      },
    ],
    workedWith: [
      {
        contractorProfileId: 22,
        businessName: "Repeat Electric",
      },
    ],
  });
});

test("preserves bounded service failures without inventing data", async () => {
  const directoryService = {
    async listHomeownerProfessionals() {
      return {
        ok: false,
        status: 400,
        code: "HOMEOWNER_ID_INVALID",
        message:
          "A valid homeowner identity is required.",
      };
    },
  };

  const handlers =
    createHomeownerProfessionalsHandlers({
      getPool: () => ({ query() {} }),
      sendPublicDatabaseError() {},
      directoryService,
    });

  const res = createResponse();

  await handlers.list(
    {
      user: {},
    },
    res
  );

  assert.equal(res.statusCode, 400);

  assert.deepEqual(res.payload, {
    success: false,
    code: "HOMEOWNER_ID_INVALID",
    message:
      "A valid homeowner identity is required.",
  });

  assert.equal(
    res.headers["Cache-Control"],
    "private, no-store"
  );
});

test("database exceptions use the existing public database error boundary", async () => {
  const expectedError =
    new Error("database unavailable");

  let publicErrorInput = null;

  const handlers =
    createHomeownerProfessionalsHandlers({
      getPool: () => ({ query() {} }),

      sendPublicDatabaseError(input) {
        publicErrorInput = input;
        return "public-error-result";
      },

      directoryService: {
        async listHomeownerProfessionals() {
          throw expectedError;
        },
      },
    });

  const res = createResponse();

  const result = await handlers.list(
    {
      user: {
        id: 77,
      },
    },
    res
  );

  assert.equal(
    result,
    "public-error-result"
  );

  assert.equal(
    publicErrorInput.error,
    expectedError
  );

  assert.equal(
    publicErrorInput.res,
    res
  );

  assert.equal(
    publicErrorInput.operation,
    "list_homeowner_professionals"
  );

  assert.equal(
    publicErrorInput.code,
    "HOMEOWNER_PROFESSIONALS_FAILED"
  );
});

test("index registers the My Professionals route module", () => {
  const indexSource = fs.readFileSync(
    path.join(__dirname, "..", "index.js"),
    "utf8"
  );

  assert.match(
    indexSource,
    /require\("\.\/server\/relationships\/homeownerProfessionals"\)/
  );

  assert.match(
    indexSource,
    /registerHomeownerProfessionalsRoutes\(\{[\s\S]*?app,[\s\S]*?authMiddleware,[\s\S]*?getPool:\s*\(\)\s*=>\s*pool,[\s\S]*?sendPublicDatabaseError,[\s\S]*?\}\);/
  );
});
