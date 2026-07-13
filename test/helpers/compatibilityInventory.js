"use strict";

const ROUTE_INVENTORY = Object.freeze([
  ["GET", "/health", false],
  ["GET", "/test-db", false],
  ["POST", "/auth/signup", false],
  ["POST", "/auth/login", false],
  ["PUT", "/auth/profile-photo", true],
  ["GET", "/auth/me", true],
  ["POST", "/auth/request-2fa-code", false],
  ["POST", "/auth/verify-2fa-code", false],
  ["GET", "/auth/security-status", true],
  ["POST", "/auth/enable-2fa", true],
  ["POST", "/auth/disable-2fa", true],
  ["POST", "/auth/change-password", true],
  ["POST", "/posts", true],
  ["GET", "/posts", true],
  ["GET", "/posts/:id", true],
  ["POST", "/contractor-profiles", true],
  ["GET", "/contractor-profiles", false],
  ["GET", "/contractor-profiles/:id", false],
  ["GET", "/my-contractor-profile", true],
  ["PUT", "/contractor-profiles/:id", true],
  ["POST", "/quote-requests", true],
  ["GET", "/my-quote-requests", true],
  ["GET", "/contractor-quote-requests", true],
  ["POST", "/messages", true],
  ["GET", "/messages/:quoteRequestId", true],
  ["POST", "/workflow-events", true],
  ["GET", "/workflow-events/:quoteRequestId", true],
  ["POST", "/reviews", true],
  ["GET", "/reviews/:contractorId", false],
  ["POST", "/contractor-projects", true],
  ["PUT", "/contractor-projects/:id", true],
  ["GET", "/contractor-projects/:contractorId", false],
].map(([method, path, authenticated]) =>
  Object.freeze({ method, path, authenticated })
));

const LEGACY_FIELD_INVENTORY = Object.freeze([
  Object.freeze({
    table: "posts",
    field: "mage_url",
    status: "legacy_compatibility",
  }),
  Object.freeze({
    table: "posts",
    field: "image_url",
    status: "current_compatibility",
  }),
  Object.freeze({
    table: "messages",
    field: "workflow_type",
    status: "communication_embedded_workflow",
  }),
  Object.freeze({
    table: "messages",
    field: "workflow_status",
    status: "not_aggregate_lifecycle_authority",
  }),
  Object.freeze({
    table: "messages",
    field: "workflow_payload",
    status: "communication_embedded_workflow",
  }),
]);

const IDENTITY_COMPATIBILITY = Object.freeze({
  quote_requests: Object.freeze({
    identityRole: "source_compatibility_identity",
    canonicalServiceRequestAuthority: false,
    canonicalAggregateAuthority: false,
  }),
  contractor_projects: Object.freeze({
    identityRole: "portfolio_identity",
    canonicalServiceRequestAuthority: false,
    canonicalAggregateAuthority: false,
  }),
});

function validateCompatibilityInventory() {
  const blockers = [];
  const routeKeys = new Set();

  for (const route of ROUTE_INVENTORY) {
    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(route.method)) {
      blockers.push(`Unsupported route method: ${route.method}`);
    }
    if (typeof route.path !== "string" || !route.path.startsWith("/")) {
      blockers.push("Route path must start with /.");
    }
    if (typeof route.authenticated !== "boolean") {
      blockers.push(`Route authentication flag is invalid: ${route.path}`);
    }

    const key = `${route.method} ${route.path}`;
    if (routeKeys.has(key)) {
      blockers.push(`Duplicate route inventory entry: ${key}`);
    }
    routeKeys.add(key);
  }

  return {
    valid: blockers.length === 0,
    blockers,
    routeCount: ROUTE_INVENTORY.length,
  };
}

module.exports = {
  IDENTITY_COMPATIBILITY,
  LEGACY_FIELD_INVENTORY,
  ROUTE_INVENTORY,
  validateCompatibilityInventory,
};
