"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "explicit-test-jwt-secret-for-portfolio-route-tests";

const { app, authMiddleware } = require("../index");

function routeLayer(method, path) {
  return app.router.stack.find(
    (layer) => layer.route?.path === path && layer.route.methods[method]
  );
}

test("Portfolio lifecycle and command routes are registered with owner authentication", () => {
  for (const [method, path] of [
    ["post", "/contractor-projects"],
    ["put", "/contractor-projects/reorder"],
    ["put", "/contractor-projects/:id"],
    ["post", "/contractor-projects/:id/legacy-adoption"],
    ["post", "/contractor-projects/:id/publish"],
    ["post", "/contractor-projects/:id/archive"],
    ["post", "/contractor-projects/:id/feature"],
    ["post", "/contractor-projects/:id/unfeature"],
    ["get", "/my-contractor-projects"],
  ]) {
    const layer = routeLayer(method, path);
    assert.ok(layer, `${method.toUpperCase()} ${path} must be registered`);
    assert.equal(layer.route.stack[0].handle, authMiddleware);
  }
});

test("public Portfolio read remains unauthenticated and reorder precedes generic project update", () => {
  const publicLayer = routeLayer("get", "/contractor-projects/:contractorId");
  assert.ok(publicLayer);
  assert.notEqual(publicLayer.route.stack[0].handle, authMiddleware);

  const reorderIndex = app.router.stack.findIndex(
    (layer) => layer.route?.path === "/contractor-projects/reorder"
  );
  const updateIndex = app.router.stack.findIndex(
    (layer) => layer.route?.path === "/contractor-projects/:id"
  );
  assert.ok(reorderIndex >= 0 && updateIndex >= 0 && reorderIndex < updateIndex);
});
