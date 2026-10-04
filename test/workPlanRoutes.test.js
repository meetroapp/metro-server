"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createWorkPlanHandlers,
  registerWorkPlanRoutes,
} = require("../server/workflow/workPlans");

function response() {
  return {
    headers: {}, statusCode: null, body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
  };
}

test("Work Plan registers three authenticated read-only routes", () => {
  const routes = [];
  const authMiddleware = () => {};
  registerWorkPlanRoutes({
    app: { get(path, auth, handler) { routes.push({ path, auth, handler }); } },
    authMiddleware,
    getPool() {},
    sendPublicDatabaseError() {},
  });
  assert.deepEqual(routes.map((route) => route.path), [
    "/professional/work-plan",
    "/professional/jobs/:jobId/work-plan",
    "/customer/jobs/:jobId/work-plan",
  ]);
  assert.equal(routes.every((route) => route.auth === authMiddleware), true);
});

test("Work Plan handlers derive actor and Job only from authenticated route context", async () => {
  const calls = [];
  const service = {
    async getProfessionalWorkPlanSummary(input) {
      calls.push(["summary", input]);
      return { ok: true, status: 200, code: "SUMMARY", workPlanSummary: {} };
    },
    async getProfessionalJobWorkPlan(input) {
      calls.push(["professional", input]);
      return { ok: true, status: 200, code: "PLAN", workPlan: {} };
    },
    async getCustomerJobWorkPlan(input) {
      calls.push(["customer", input]);
      return { ok: true, status: 200, code: "PLAN", workPlan: {} };
    },
  };
  const handlers = createWorkPlanHandlers({
    getPool: () => "pool",
    sendPublicDatabaseError() {},
    service,
  });
  const request = {
    user: { id: 12 },
    params: { jobId: "job-from-path" },
    query: { jobId: "ignored", actorId: 999 },
  };
  for (const handler of [
    handlers.getProfessionalSummary,
    handlers.getProfessionalJobPlan,
    handlers.getCustomerJobPlan,
  ]) await handler(request, response());
  assert.deepEqual(calls, [
    ["summary", { pool: "pool", authenticatedActor: { id: 12 } }],
    ["professional", { pool: "pool", authenticatedActor: { id: 12 }, jobId: "job-from-path" }],
    ["customer", { pool: "pool", authenticatedActor: { id: 12 }, jobId: "job-from-path" }],
  ]);
});

test("Work Plan responses are private and fail closed", async () => {
  const handlers = createWorkPlanHandlers({
    getPool: () => "pool",
    sendPublicDatabaseError() {},
    service: {
      async getProfessionalWorkPlanSummary() {
        return { ok: false, status: 404, code: "PROFESSIONAL_WORK_PLAN_UNAVAILABLE", message: "Unavailable." };
      },
    },
  });
  const res = response();
  await handlers.getProfessionalSummary({ user: { id: 12 }, params: {} }, res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.headers["Cache-Control"], "private, no-store");
  assert.deepEqual(res.body, {
    success: false,
    code: "PROFESSIONAL_WORK_PLAN_UNAVAILABLE",
    message: "Unavailable.",
  });
});
