"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  getOwnedEmergencyRequest,
} = require(
  "../server/emergency/emergencyRequestService"
);

function row(overrides = {}) {
  return {
    id: 41,
    homeowner_id: 7,
    category: "home_repair",
    service_domain: "home_services",
    service_specialty: "electrical",
    title: "Partial power outage",
    description: "Several rooms lost power.",
    location_text: "Cape Coral, FL",
    unit_number: null,
    access_notes: null,
    status: "assigned",
    requested_at: "requested",
    assigned_at: "assigned",
    en_route_at: null,
    arrived_at: null,
    work_started_at: null,
    completed_at: null,
    resolved_at: null,
    cancelled_at: null,
    expired_at: null,
    created_at: "created",
    updated_at: "updated",
    assessment_id: null,
    has_selected_professional: true,
    selected_professional_business_name:
      "Cape Electrical",
    canonical_conversation_id: 91,
    ...overrides,
  };
}

function poolWithRow(value) {
  const calls = [];

  return {
    calls,

    async query(sql, values) {
      calls.push({
        sql: String(sql)
          .replace(/\s+/g, " ")
          .trim(),
        values,
      });

      return {
        rows: value ? [value] : [],
      };
    },
  };
}

test(
  "owned Emergency detail projects direct-selected professional and canonical Conversation truth",
  async () => {
    const pool = poolWithRow(row());

    const result =
      await getOwnedEmergencyRequest({
        pool,
        homeownerUserId: 7,
        emergencyRequestId: 41,
      });

    assert.equal(result.ok, true);

    assert.equal(
      result.emergencyRequest
        .hasSelectedProfessional,
      true
    );

    assert.equal(
      result.emergencyRequest
        .selectedProfessionalBusinessName,
      "Cape Electrical"
    );

    assert.equal(
      result.emergencyRequest
        .conversationAvailable,
      true
    );

    assert.equal(
      result.emergencyRequest
        .conversationId,
      91
    );

    assert.equal(pool.calls.length, 1);

    assert.deepEqual(
      pool.calls[0].values,
      [41, 7, "active"]
    );

    assert.match(
      pool.calls[0].sql,
      /FROM request_relationships/
    );

    assert.match(
      pool.calls[0].sql,
      /request_relationships\.status = \$3/
    );

    assert.match(
      pool.calls[0].sql,
      /contractor_profiles\.business_name/
    );

    assert.match(
      pool.calls[0].sql,
      /conversations\.id AS canonical_conversation_id/
    );
  }
);

test(
  "owned Emergency detail returns explicit no-selection truth before assignment",
  async () => {
    const pool = poolWithRow(
      row({
        status: "ready_for_distribution",
        assigned_at: null,
        has_selected_professional: false,
        selected_professional_business_name:
          null,
        canonical_conversation_id: null,
      })
    );

    const result =
      await getOwnedEmergencyRequest({
        pool,
        homeownerUserId: 7,
        emergencyRequestId: 41,
      });

    assert.equal(result.ok, true);

    assert.equal(
      result.emergencyRequest
        .hasSelectedProfessional,
      false
    );

    assert.equal(
      result.emergencyRequest
        .selectedProfessionalBusinessName,
      null
    );

    assert.equal(
      result.emergencyRequest
        .conversationAvailable,
      false
    );

    assert.equal(
      result.emergencyRequest
        .conversationId,
      null
    );
  }
);

test(
  "selection projection remains absent for serializer callers that did not request relationship truth",
  () => {
    const {
      serializeEmergencyRequest,
    } = require(
      "../server/emergency/emergencyRequestService"
    );

    const serialized =
      serializeEmergencyRequest({
        id: 41,
        status: "draft",
      });

    assert.equal(
      Object.hasOwn(
        serialized,
        "hasSelectedProfessional"
      ),
      false
    );

    assert.equal(
      Object.hasOwn(
        serialized,
        "conversationId"
      ),
      false
    );
  }
);
