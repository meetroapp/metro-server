"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ACTIVE_EMERGENCY_REQUEST_STATUSES,
  DEFAULT_EMERGENCY_REQUEST_LIST_LIMIT,
  EMERGENCY_REQUEST_LIST_VIEWS,
  HISTORY_EMERGENCY_REQUEST_STATUSES,
  MAX_EMERGENCY_REQUEST_LIST_LIMIT,
  listOwnedEmergencyRequests,
  serializeEmergencyRequestSummary,
  validateEmergencyRequestListOptions,
} = require("../server/emergency/emergencyRequestService");
const {
  RELATIONSHIP_STATUSES,
} = require("../server/relationships/requestRelationships");

function summaryRow(overrides = {}) {
  return {
    id: 41,
    title: "Active pipe leak",
    service_specialty: "emergency_plumbing",
    status: "ready_for_distribution",
    created_at: "2026-07-29T14:00:00.000Z",
    requested_at: "2026-07-29T14:02:00.000Z",
    assigned_at: null,
    en_route_at: null,
    arrived_at: null,
    work_started_at: null,
    completed_at: null,
    cancelled_at: null,
    expired_at: null,
    available_response_count: 0,
    has_selected_professional: false,
    ...overrides,
  };
}

function createPool(rows = []) {
  const calls = [];
  return {
    calls,
    async query(text, values) {
      calls.push({ text, values });
      return { rows };
    },
  };
}

test("Emergency list options default and remain bounded", () => {
  assert.deepEqual(validateEmergencyRequestListOptions({}), {
    valid: true,
    value: {
      view: "active",
      limit: DEFAULT_EMERGENCY_REQUEST_LIST_LIMIT,
    },
  });

  assert.deepEqual(
    validateEmergencyRequestListOptions({
      view: "history",
      limit: String(MAX_EMERGENCY_REQUEST_LIST_LIMIT),
    }),
    {
      valid: true,
      value: {
        view: "history",
        limit: MAX_EMERGENCY_REQUEST_LIST_LIMIT,
      },
    }
  );

  for (const options of [
    { view: "unknown" },
    { view: ["active", "history"] },
    { limit: 0 },
    { limit: -1 },
    { limit: 51 },
    { limit: "1.5" },
    { limit: ["25", "50"] },
    { homeownerId: 7 },
    null,
  ]) {
    const result = validateEmergencyRequestListOptions(options);
    assert.equal(result.valid, false);
    assert.equal(result.status, 400);
    assert.equal(result.code, "EMERGENCY_REQUEST_LIST_INVALID");
  }
});

test("Emergency summary serializer exposes only the approved projection", () => {
  const serialized = serializeEmergencyRequestSummary(
    summaryRow({
      available_response_count: 2,
      has_selected_professional: true,
      homeowner_id: 7,
      location_text: "Private address",
      unit_number: "2A",
      access_notes: "Private access",
      additional_safety_context: "Private safety context",
      contractor_id: 99,
      relationship_id: 151,
      conversation_id: 201,
      professional_email: "private@example.com",
    })
  );

  assert.deepEqual(Object.keys(serialized), [
    "emergencyRequestId",
    "title",
    "serviceSpecialty",
    "status",
    "createdAt",
    "requestedAt",
    "assignedAt",
    "enRouteAt",
    "arrivedAt",
    "workStartedAt",
    "completedAt",
    "cancelledAt",
    "expiredAt",
    "availableResponseCount",
    "hasSelectedProfessional",
  ]);
  assert.equal(serialized.availableResponseCount, 2);
  assert.equal(serialized.hasSelectedProfessional, true);
  assert.doesNotMatch(
    JSON.stringify(serialized),
    /Private|homeowner|contractor|relationship|conversation|email/i
  );
});

test("Emergency summary rejects invalid aggregate counts", () => {
  for (const value of [-1, 1.5, "not-a-count"]) {
    assert.throws(
      () =>
        serializeEmergencyRequestSummary(
          summaryRow({ available_response_count: value })
        ),
      /non-negative integer/
    );
  }
});

test("owner-scoped Emergency list returns an authoritative empty collection", async () => {
  const pool = createPool([]);
  const result = await listOwnedEmergencyRequests({
    pool,
    homeownerUserId: 7,
  });

  assert.deepEqual(result, {
    ok: true,
    status: 200,
    code: "EMERGENCY_REQUESTS_RETRIEVED",
    emergencyRequests: [],
  });
  assert.equal(pool.calls.length, 1);
  assert.deepEqual(pool.calls[0].values, [
    7,
    ACTIVE_EMERGENCY_REQUEST_STATUSES,
    25,
    RELATIONSHIP_STATUSES.PENDING,
    RELATIONSHIP_STATUSES.ACTIVE,
  ]);
});

test("Emergency list query is owner-scoped, read-only, and deterministically ordered", async () => {
  const pool = createPool([
    summaryRow({ id: 42, created_at: "later" }),
    summaryRow({ id: 41, created_at: "earlier" }),
  ]);
  const result = await listOwnedEmergencyRequests({
    pool,
    homeownerUserId: 7,
    options: {
      view: "active",
      limit: 25,
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    result.emergencyRequests.map((request) => request.emergencyRequestId),
    [42, 41]
  );

  const { text, values } = pool.calls[0];
  assert.deepEqual(values, [
    7,
    ACTIVE_EMERGENCY_REQUEST_STATUSES,
    25,
    RELATIONSHIP_STATUSES.PENDING,
    RELATIONSHIP_STATUSES.ACTIVE,
  ]);
  assert.match(
    text,
    /WHERE emergency_requests\.homeowner_id = \$1/i
  );
  assert.match(
    text,
    /emergency_requests\.status = ANY\(\$2::text\[\]\)/i
  );
  assert.match(
    text,
    /ORDER BY\s+emergency_requests\.created_at DESC,\s+emergency_requests\.id DESC/i
  );
  assert.match(text, /LIMIT \$3/i);
  assert.doesNotMatch(
    text,
    /\b(?:INSERT|UPDATE|DELETE|BEGIN|COMMIT|ROLLBACK)\b/i
  );
});

test("active, history, and all views use only their canonical status sets", async () => {
  for (const [view, statuses] of [
    ["active", ACTIVE_EMERGENCY_REQUEST_STATUSES],
    ["history", HISTORY_EMERGENCY_REQUEST_STATUSES],
    ["all", EMERGENCY_REQUEST_LIST_VIEWS.all],
  ]) {
    const pool = createPool([]);
    await listOwnedEmergencyRequests({
      pool,
      homeownerUserId: 7,
      options: { view, limit: 10 },
    });
    assert.deepEqual(pool.calls[0].values, [
      7,
      statuses,
      10,
      RELATIONSHIP_STATUSES.PENDING,
      RELATIONSHIP_STATUSES.ACTIVE,
    ]);
  }

  assert.equal(
    EMERGENCY_REQUEST_LIST_VIEWS.all.includes(
      "professional_selected"
    ),
    false
  );
});

test("response aggregates include only pending Emergency relationships and active selection", async () => {
  const pool = createPool([]);
  await listOwnedEmergencyRequests({
    pool,
    homeownerUserId: 7,
  });

  const query = pool.calls[0].text;
  assert.match(
    query,
    /COUNT\(request_relationships\.id\)[\s\S]*request_relationships\.status = \$4/i
  );
  assert.match(
    query,
    /BOOL_OR\([\s\S]*request_relationships\.status = \$5/i
  );
  assert.match(
    query,
    /request_relationships\.emergency_request_id =\s*emergency_requests\.id/i
  );
  assert.match(
    query,
    /request_relationships\.post_id IS NULL/i
  );
  assert.doesNotMatch(
    query,
    /conversations|contractor_profiles|professional_user_id/i
  );
});

test("invalid homeowner identity and options never query the database", async () => {
  for (const args of [
    { homeownerUserId: 0, options: {} },
    { homeownerUserId: 7, options: { view: "invalid" } },
    { homeownerUserId: 7, options: { limit: 51 } },
  ]) {
    const pool = createPool([]);
    const result = await listOwnedEmergencyRequests({
      pool,
      ...args,
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.equal(result.code, "EMERGENCY_REQUEST_LIST_INVALID");
    assert.equal(pool.calls.length, 0);
  }
});

test("Emergency list requires a database dependency", async () => {
  await assert.rejects(
    listOwnedEmergencyRequests({
      pool: null,
      homeownerUserId: 7,
    }),
    /database pool/
  );
});
