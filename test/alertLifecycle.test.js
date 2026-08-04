"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ALERT_TRANSITION_MATRIX,
  canArchive,
  canDismiss,
  canExpire,
  canMarkRead,
  canResolve,
  isTerminalLifecycle,
} = require("../server/alerts/alertLifecycle");

test("alert lifecycle exposes the complete fail-closed transition matrix", () => {
  assert.deepEqual(ALERT_TRANSITION_MATRIX, {
    read: ["active", "dismissed", "resolved", "expired"],
    dismiss: ["active", "dismissed"],
    resolve: ["active", "dismissed", "resolved"],
    expire: ["active", "dismissed", "expired"],
    archive: ["resolved", "expired", "archived"],
  });
});

test("alert read semantics remain independent except after archival", () => {
  for (const lifecycle_state of ["active", "dismissed", "resolved", "expired"]) {
    assert.equal(canMarkRead({ id: 1, lifecycle_state }), true);
  }
  assert.equal(canMarkRead({ id: 1, lifecycle_state: "archived" }), false);
  assert.equal(canMarkRead({}), false);
});

test("alert dismiss policy rejects critical, terminal, and unknown states", () => {
  assert.equal(canDismiss({ id: 1, priority: "normal", lifecycle_state: "active" }), null);
  assert.equal(canDismiss({ id: 1, priority: "high", lifecycle_state: "dismissed" }), null);
  assert.equal(
    canDismiss({ id: 1, priority: "critical", lifecycle_state: "active" }).code,
    "ALERT_NOT_DISMISSIBLE"
  );
  for (const lifecycle_state of ["resolved", "expired", "archived", "unknown"]) {
    assert.equal(
      canDismiss({ id: 1, priority: "normal", lifecycle_state }).code,
      "ALERT_NOT_DISMISSIBLE"
    );
  }
});

test("alert resolution allows active, dismissed, and idempotent resolved only", () => {
  for (const lifecycle_state of ["active", "dismissed", "resolved"]) {
    assert.equal(canResolve({ id: 1, lifecycle_state }), null);
  }
  for (const lifecycle_state of ["expired", "archived", "unknown"]) {
    assert.equal(canResolve({ id: 1, lifecycle_state }).code, "ALERT_RESOLVE_FAILED");
  }
});

test("alert expiration requires a due timestamp and permitted state", () => {
  const due = {
    id: 1,
    lifecycle_state: "active",
    expires_at: "2026-08-03T12:00:00.000Z",
  };
  assert.equal(canExpire(due, { now: "2026-08-03T12:00:00.000Z" }), null);
  assert.equal(
    canExpire({ ...due, lifecycle_state: "dismissed" }, { now: "2026-08-04T00:00:00.000Z" }),
    null
  );
  assert.equal(
    canExpire({ ...due, lifecycle_state: "expired" }, { now: "2026-08-04T00:00:00.000Z" }),
    null
  );
  assert.equal(
    canExpire(due, { now: "2026-08-03T11:59:59.000Z" }).code,
    "ALERT_NOT_EXPIRABLE"
  );
  assert.equal(
    canExpire({ id: 1, lifecycle_state: "active" }, { now: "2026-08-04T00:00:00.000Z" }).code,
    "ALERT_NOT_EXPIRABLE"
  );
  for (const lifecycle_state of ["resolved", "archived", "unknown"]) {
    assert.equal(
      canExpire({ ...due, lifecycle_state }, { now: "2026-08-04T00:00:00.000Z" }).code,
      "ALERT_NOT_EXPIRABLE"
    );
  }
});

test("alert archival is limited to resolved, expired, and idempotent archived states", () => {
  for (const lifecycle_state of ["resolved", "expired", "archived"]) {
    assert.equal(canArchive({ id: 1, lifecycle_state }), null);
  }
  for (const lifecycle_state of ["active", "dismissed", "unknown"]) {
    assert.equal(canArchive({ id: 1, lifecycle_state }).code, "ALERT_NOT_ARCHIVABLE");
  }
  assert.equal(canArchive({}).code, "ALERT_NOT_FOUND");
});

test("terminal lifecycle detection remains explicit", () => {
  assert.equal(isTerminalLifecycle("resolved"), true);
  assert.equal(isTerminalLifecycle("expired"), true);
  assert.equal(isTerminalLifecycle("archived"), true);
  assert.equal(isTerminalLifecycle("dismissed"), false);
});
