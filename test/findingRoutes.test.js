"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createEvaluationHandlers } = require("../server/authorization/evaluations");

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test("Finding submit derives actor and Evaluation scope from authenticated route boundaries", async () => {
  let received;
  const handlers = createEvaluationHandlers({
    getPool: () => ({ query() {} }),
    sendPublicDatabaseError() { throw new Error("not expected"); },
    service: {},
    findingAuthority: {
      async submitFinding(input) {
        received = input;
        return {
          ok: true,
          status: 201,
          code: "FINDING_SUBMITTED",
          finding: { id: "finding-1" },
        };
      },
    },
  });
  const res = response();
  await handlers.submitFinding({
    user: { id: 17 },
    params: { evaluationId: "evaluation-from-path" },
    headers: { "idempotency-key": "finding-route-key" },
    body: {
      statement: "garbage disposal and drainage fault",
      jobId: "browser-job",
      actorUserId: 999,
      confirmationState: "CONFIRMED",
      resolutionState: "RESOLVED",
    },
  }, res);
  assert.equal(received.authenticatedActor.id, 17);
  assert.equal(received.evaluationId, "evaluation-from-path");
  assert.equal(received.statement, "garbage disposal and drainage fault");
  assert.equal(Object.hasOwn(received, "jobId"), false);
  assert.equal(Object.hasOwn(received, "confirmationState"), false);
  assert.equal(Object.hasOwn(received, "resolutionState"), false);
  assert.equal(res.statusCode, 201);
});

test("Finding confirmation accepts only expected version from the command body", async () => {
  let received;
  const handlers = createEvaluationHandlers({
    getPool: () => ({ query() {} }),
    sendPublicDatabaseError() { throw new Error("not expected"); },
    service: {},
    findingAuthority: {
      async confirmFinding(input) {
        received = input;
        return {
          ok: true,
          status: 200,
          code: "FINDING_CONFIRMED",
          finding: { id: input.findingId, confirmationState: "CONFIRMED" },
        };
      },
    },
  });
  const res = response();
  await handlers.confirmFinding({
    user: { id: 17 },
    params: { findingId: "finding-from-path" },
    headers: { "idempotency-key": "finding-confirm-key" },
    body: {
      expectedVersion: 1,
      statement: "browser overwrite",
      resolutionState: "RESOLVED",
    },
  }, res);
  assert.equal(received.findingId, "finding-from-path");
  assert.equal(received.expectedVersion, 1);
  assert.equal(Object.hasOwn(received, "statement"), false);
  assert.equal(Object.hasOwn(received, "resolutionState"), false);
});
