"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createProfessionalJobPickerHandlers,
  registerProfessionalJobPickerRoutes,
} = require("../server/workflow/professionalJobPicker");

function responseRecorder() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
  };
}

test("GET /professional/jobs is authenticated and returns the bounded Job picker list", () => {
  const registrations = [];
  const authMiddleware = () => {};
  registerProfessionalJobPickerRoutes({
    app: { get: (...args) => registrations.push(args) },
    authMiddleware,
    getPool: () => ({ query() {} }),
    sendPublicDatabaseError: () => {},
  });
  assert.deepEqual(registrations.map(([route]) => route), ["/professional/jobs"]);
  assert.equal(registrations[0][1], authMiddleware);
});

test("professional Job picker handler forwards only authenticated actor and uses private no-store", async () => {
  const calls = [];
  const handlers = createProfessionalJobPickerHandlers({
    getPool: () => ({ id: "pool" }),
    sendPublicDatabaseError: () => {},
    service: {
      async listAuthorizedProfessionalJobs(input) {
        calls.push(input);
        return { ok: true, status: 200, code: "PROFESSIONAL_JOBS_LOADED", jobs: [] };
      },
    },
  });
  const res = responseRecorder();
  await handlers.listAuthorizedProfessionalJobs({ user: { id: 77 } }, res);
  assert.equal(res.headers["Cache-Control"], "private, no-store");
  assert.deepEqual(calls, [{ pool: { id: "pool" }, authenticatedActor: { id: 77 } }]);
  assert.deepEqual(res.body, {
    success: true,
    code: "PROFESSIONAL_JOBS_LOADED",
    jobs: [],
  });
});
