"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createProfessionalScheduleHandlers,
  registerProfessionalScheduleRoutes,
} = require("../server/workflow/professionalSchedule");

function response() {
  return {
    headers: {},
    statusCode: null,
    body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
  };
}

test("professional Schedule registers one authenticated read-only aggregate", () => {
  const routes = [];
  const app = {
    get(path, ...handlers) { routes.push({ method: "GET", path, handlers }); },
    post() { throw new Error("Schedule read projection must not register commands"); },
  };
  const authMiddleware = () => {};
  registerProfessionalScheduleRoutes({
    app,
    authMiddleware,
    getPool: () => ({}),
    sendPublicDatabaseError: () => {},
  });
  assert.deepEqual(routes.map(({ method, path }) => `${method} ${path}`), [
    "GET /professional/schedule",
  ]);
  assert.equal(routes[0].handlers[0], authMiddleware);
});

test("handler derives professional identity from authentication and accepts only read controls", async () => {
  const calls = [];
  const handlers = createProfessionalScheduleHandlers({
    getPool: () => "pool",
    sendPublicDatabaseError: () => {},
    service: {
      async getProfessionalSchedule(input) {
        calls.push(input);
        return {
          ok: true,
          status: 200,
          code: "PROFESSIONAL_SCHEDULE_LOADED",
          schedule: { view: input.view, opportunities: [], visits: [] },
        };
      },
    },
  });
  const res = response();
  await handlers.getSchedule({
    user: { id: 41 },
    query: { view: "active", limit: "25", cursor: "opaque" },
    body: { professionalUserId: 999, capability: "visit.read" },
  }, res);
  assert.deepEqual(calls, [{
    pool: "pool",
    authenticatedActor: { id: 41 },
    view: "active",
    limit: "25",
    cursor: "opaque",
  }]);
  assert.equal(res.headers["Cache-Control"], "private, no-store");
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.code, "PROFESSIONAL_SCHEDULE_LOADED");
});

test("handler preserves a bounded public failure contract", async () => {
  const handlers = createProfessionalScheduleHandlers({
    getPool: () => ({}),
    sendPublicDatabaseError: () => {},
    service: {
      async getProfessionalSchedule() {
        return { ok: false, status: 400, code: "INVALID_SCHEDULE_VIEW", message: "Invalid." };
      },
    },
  });
  const res = response();
  await handlers.getSchedule({ user: { id: 1 }, query: {} }, res);
  assert.deepEqual(res.body, {
    success: false,
    code: "INVALID_SCHEDULE_VIEW",
    message: "Invalid.",
  });
});
