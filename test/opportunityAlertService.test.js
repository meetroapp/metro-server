"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  projectEmergencyRequestAlertsWithClient,
  projectEmergencyResponseAlertWithClient,
  projectNewLeadAlertsWithClient,
} = require("../server/alerts/opportunityAlertService");

function profile(id, userId, specialty = "painting") {
  return {
    id,
    user_id: userId,
    category: specialty,
    profile_details: {
      service_specialties: [specialty],
      service_area: "Cape Coral",
    },
  };
}

function clientWithProfiles(rows) {
  const calls = [];
  return {
    calls,
    client: {
      async query(sql, values) {
        calls.push({ sql: String(sql), values });
        return { rows };
      },
    },
  };
}

test("new Lead Alerts use existing eligibility, exact recipients, and exact request destination", async () => {
  const fake = clientWithProfiles([
    profile(80, 9),
    profile(81, 10, "plumbing"),
    profile(82, 9),
  ]);
  const projected = [];
  const result = await projectNewLeadAlertsWithClient({
    client: fake.client,
    request: {
      id: 41,
      user_id: 7,
      status: "open",
      created_at: "2026-08-29T12:00:00.000Z",
    },
    sourceEventId: "11111111-1111-4111-8111-111111111111",
    professionalCanSeeRequest: (candidate) =>
      candidate.category === "painting",
    createAlert: async (input) => {
      projected.push(input);
      return { alertId: projected.length, created: true };
    },
  });

  assert.deepEqual(result.recipients, [9]);
  assert.equal(projected.length, 1);
  assert.equal(projected[0].recipientUserId, 9);
  assert.equal(projected[0].sourceEventType, "request.created");
  assert.equal(projected[0].sourceEventId, "11111111-1111-4111-8111-111111111111");
  assert.deepEqual(projected[0].destination, {
    type: "request",
    payload: { requestId: 41 },
  });
  assert.doesNotMatch(JSON.stringify(projected[0].safePayload), /address|location/i);
  assert.deepEqual(fake.calls[0].values, [7]);
});

test("Emergency request Alerts exclude unrelated professionals and preserve exact request identity", async () => {
  const fake = clientWithProfiles([
    profile(80, 9, "electrical"),
    profile(81, 10, "plumbing"),
  ]);
  const projected = [];
  const result = await projectEmergencyRequestAlertsWithClient({
    client: fake.client,
    emergencyRequest: {
      id: 51,
      homeowner_id: 7,
      status: "ready_for_distribution",
      requested_at: "2026-08-29T12:00:00.000Z",
    },
    professionalCanSeeEmergencyOpportunity: (candidate) =>
      candidate.category === "electrical",
    createAlert: async (input) => {
      projected.push(input);
      return { alertId: projected.length, created: true };
    },
  });

  assert.deepEqual(result.recipients, [9]);
  assert.equal(projected[0].recipientUserId, 9);
  assert.equal(projected[0].sourceEventType, "emergency.request_ready");
  assert.equal(projected[0].priority, "critical");
  assert.deepEqual(projected[0].destination, {
    type: "emergency_request",
    payload: { emergencyRequestId: 51 },
  });
});

test("Emergency response Alert goes only to the governed homeowner and replay returns existing Alert", async () => {
  const calls = [];
  const createAlert = async (input) => {
    calls.push(input);
    return { alertId: 701, created: calls.length === 1 };
  };
  const input = {
    client: { query: async () => ({ rows: [] }) },
    emergencyRequest: { id: 51, homeowner_id: 7 },
    relationship: {
      id: 151,
      emergency_request_id: 51,
      homeowner_id: 7,
      professional_user_id: 9,
      responded_at: "2026-08-29T12:05:00.000Z",
    },
    createAlert,
  };

  const first = await projectEmergencyResponseAlertWithClient(input);
  const replay = await projectEmergencyResponseAlertWithClient(input);
  assert.equal(first.created, true);
  assert.equal(replay.created, false);
  assert.equal(calls[0].recipientUserId, 7);
  assert.equal(calls[0].sourceEventId, "151:created");
  assert.deepEqual(calls[0].destination, {
    type: "emergency_request",
    payload: { emergencyRequestId: 51 },
  });
  assert.notEqual(calls[0].recipientUserId, 9);
});
