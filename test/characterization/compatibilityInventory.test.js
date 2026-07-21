"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  IDENTITY_COMPATIBILITY,
  LEGACY_FIELD_INVENTORY,
  ROUTE_INVENTORY,
  validateCompatibilityInventory,
} = require("../helpers/compatibilityInventory");

test("route inventory is inert, valid data only", () => {
  const result = validateCompatibilityInventory();

  assert.deepEqual(result, {
    valid: true,
    blockers: [],
    routeCount: 39,
  });
  assert.equal(Object.isFrozen(ROUTE_INVENTORY), true);
  assert.equal(
    ROUTE_INVENTORY.every(
      (route) =>
        typeof route.method === "string" &&
        typeof route.path === "string" &&
        typeof route.authenticated === "boolean"
    ),
    true
  );
});

test("legacy compatibility fields remain explicitly inventoried", () => {
  const fieldKeys = LEGACY_FIELD_INVENTORY.map(
    ({ table, field }) => `${table}.${field}`
  );

  assert.deepEqual(fieldKeys, [
    "posts.mage_url",
    "posts.image_url",
    "messages.workflow_type",
    "messages.workflow_status",
    "messages.workflow_payload",
  ]);
});

test("messages preserve legacy identity while canonical identity remains nullable", () => {
  assert.deepEqual(IDENTITY_COMPATIBILITY.messages, {
    legacyIdentityField: "quote_request_id",
    canonicalConversationIdentityField: "conversation_id",
    legacyIdentityRetained: true,
    canonicalIdentityNullableDuringTransition: true,
    automaticBackfillAuthorized: false,
  });
});

test("quote requests remain source compatibility identity only", () => {
  assert.deepEqual(IDENTITY_COMPATIBILITY.quote_requests, {
    identityRole: "source_compatibility_identity",
    canonicalServiceRequestAuthority: false,
    canonicalAggregateAuthority: false,
  });
});

test("contractor projects remain portfolio identity only", () => {
  assert.deepEqual(IDENTITY_COMPATIBILITY.contractor_projects, {
    identityRole: "portfolio_identity",
    canonicalServiceRequestAuthority: false,
    canonicalAggregateAuthority: false,
  });
});

test("message workflow status is not aggregate lifecycle authority", () => {
  const workflowStatus = LEGACY_FIELD_INVENTORY.find(
    ({ table, field }) =>
      table === "messages" && field === "workflow_status"
  );

  assert.equal(workflowStatus.status, "not_aggregate_lifecycle_authority");
});


test("canonical and legacy message routes remain independently inventoried", () => {
  const routeKeys = ROUTE_INVENTORY.map(
    ({ method, path }) =>
      `${method} ${path}`
  );

  assert.equal(
    routeKeys.includes(
      "POST /messages"
    ),
    true
  );

  assert.equal(
    routeKeys.includes(
      "POST /conversations/:conversationId/messages"
    ),
    true
  );

  assert.equal(
    routeKeys.includes(
      "GET /messages/:quoteRequestId"
    ),
    true
  );

  assert.equal(
    routeKeys.includes(
      "GET /conversations/:conversationId/messages"
    ),
    true
  );
});
