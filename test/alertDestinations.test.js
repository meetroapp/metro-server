"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  normalizeDestination,
} = require("../server/alerts/alertDestinations");

function destination(type, payload) {
  return { type, payload };
}

function invalid(value) {
  return normalizeDestination(value).error?.code === "INVALID_ALERT_DESTINATION";
}

test("alert destinations accept only the exact nested canonical shape", () => {
  assert.deepEqual(
    normalizeDestination(destination("conversation", { conversationId: 91 })).value.public,
    { type: "conversation", conversationId: 91 }
  );
  assert.equal(invalid({ type: "conversation", conversationId: 91 }), true);
  assert.equal(invalid(destination("conversation", { requestId: 91 })), true);
  assert.equal(invalid(destination("conversation", { emergencyRequestId: 91 })), true);
});

test("alert destinations accept each proven Phase A canonical identity", () => {
  assert.equal(
    normalizeDestination(destination("emergency_request", { emergencyRequestId: 7 })).value.payload.emergencyRequestId,
    7
  );
  assert.equal(normalizeDestination(destination("request", { requestId: 8 })).value.payload.requestId, 8);
  assert.equal(normalizeDestination(destination("project", { requestId: 9 })).value.payload.requestId, 9);
  assert.equal(
    normalizeDestination(destination("business_profile", { businessProfileId: 10 })).value.payload.businessProfileId,
    10
  );
  assert.equal(
    normalizeDestination(destination("evaluation", {
      evaluationId: "123E4567-E89B-12D3-A456-426614174000",
    })).value.payload.evaluationId,
    "123e4567-e89b-12d3-a456-426614174000"
  );
  assert.equal(normalizeDestination(destination("review", { reviewId: 12 })).value.payload.reviewId, 12);
  assert.deepEqual(normalizeDestination(destination("notifications", {})).value.payload, {});
});

test("alert destinations reject every extra top-level authority field", () => {
  for (const field of [
    "route",
    "hash",
    "url",
    "href",
    "pathname",
    "query",
    "search",
    "requestId",
    "conversationId",
    "emergencyRequestId",
    "state",
    "replace",
    "returnPage",
    "shell",
  ]) {
    assert.equal(
      invalid({
        type: "conversation",
        payload: { conversationId: 1 },
        [field]: "ignored-authority",
      }),
      true
    );
  }
});

test("alert destinations reject extra payload fields and unsupported identities", () => {
  for (const value of [
    destination("conversation", { conversationId: 1, requestId: 2 }),
    destination("request", { requestId: 1, route: "requests" }),
    destination("request", { requestId: 0 }),
    destination("request", { requestId: 1.5 }),
    destination("request", { requestId: "1" }),
    destination("evaluation", { evaluationId: "not-a-uuid" }),
    destination("review", { reviewReference: "review:contractor:12" }),
    destination("review", { reviewId: "12" }),
    destination("invoice", { invoiceId: 1 }),
    destination("proposal", { proposalId: 1 }),
    destination("notifications", { anything: true }),
  ]) {
    assert.equal(invalid(value), true);
  }
});

test("alert destination validation never executes coercion hooks or accessors", () => {
  let executions = 0;
  const identity = {
    toString() {
      executions += 1;
      return "123e4567-e89b-12d3-a456-426614174000";
    },
    valueOf() {
      executions += 1;
      return 12;
    },
  };
  const accessorPayload = {};
  Object.defineProperty(accessorPayload, "conversationId", {
    enumerable: true,
    get() {
      executions += 1;
      return 1;
    },
  });
  const proxied = new Proxy({ conversationId: 1 }, {
    getPrototypeOf() {
      executions += 1;
      return Object.prototype;
    },
  });

  assert.equal(invalid(destination("evaluation", { evaluationId: identity })), true);
  assert.equal(invalid(destination("review", { reviewId: identity })), true);
  assert.equal(invalid(destination("conversation", { conversationId: new Number(1) })), true);
  assert.equal(invalid(destination("conversation", accessorPayload)), true);
  assert.equal(invalid(destination("conversation", proxied)), true);
  assert.equal(executions, 0);
});
