"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  cancelEmergencyRequest,
  createEmergencyDraft,
  deriveSafetyDisposition,
  getOwnedEmergencyRequest,
  parsePositiveInteger,
  prepareEmergencyRequest,
  saveEmergencySafetyAssessment,
  serializeEmergencyRequest,
  updateEmergencyDraft,
  validateEmergencyDraftPayload,
  validateSafetyAssessmentPayload,
} = require("../server/emergency/emergencyRequestService");

function safeAssessment(overrides = {}) {
  return {
    immediateDanger: false,
    medicalEmergency: false,
    fireOrSmoke: false,
    gasOdorOrSuspectedLeak: false,
    activeCrimeOrThreat: false,
    electricalImmediateHazard: false,
    structuralCollapseRisk: false,
    floodingOrWaterDamage: false,
    occupantsUnableToExit: false,
    emergencyServicesContacted: false,
    safeToRemainAtLocation: true,
    additionalSafetyContext: "",
    ...overrides,
  };
}

test("Emergency identifiers accept only safe positive integers", () => {
  assert.equal(parsePositiveInteger(12), 12);
  assert.equal(parsePositiveInteger("7"), 7);

  for (const value of [0, -1, "", "1.2", "1x", null, undefined]) {
    assert.equal(parsePositiveInteger(value), null);
  }
});

test("Emergency draft validation allowlists and normalizes fields", () => {
  const result = validateEmergencyDraftPayload({
    category: "Home Repair",
    serviceDomain: "Electrical",
    serviceSpecialty: "Emergency Wiring",
    title: "Power issue",
    description: "Partial outage in the home.",
    locationText: "Cape Coral, FL",
    unitNumber: "",
    accessNotes: "Call before arrival.",
  });

  assert.equal(result.valid, true);
  assert.deepEqual(result.value, {
    category: "home_repair",
    serviceDomain: "electrical",
    serviceSpecialty: "emergency_wiring",
    title: "Power issue",
    description: "Partial outage in the home.",
    locationText: "Cape Coral, FL",
    unitNumber: "",
    accessNotes: "Call before arrival.",
  });

  assert.equal(
    validateEmergencyDraftPayload({
      category: "repair",
      serviceDomain: "electrical",
      serviceSpecialty: "wiring",
      title: "Issue",
      description: "",
      locationText: "Cape Coral",
      unitNumber: "",
      accessNotes: "",
      status: "active",
    }).code,
    "UNSUPPORTED_EMERGENCY_FIELDS"
  );
});

test("Emergency partial updates require at least one editable field", () => {
  assert.equal(
    validateEmergencyDraftPayload({}, { partial: true }).code,
    "EMERGENCY_UPDATE_REQUIRED"
  );

  const result = validateEmergencyDraftPayload(
    { title: "Updated title" },
    { partial: true }
  );

  assert.equal(result.valid, true);
  assert.deepEqual(result.value, { title: "Updated title" });
});

test("Safety assessment requires every governed boolean answer", () => {
  const incomplete = safeAssessment();
  delete incomplete.fireOrSmoke;

  assert.equal(
    validateSafetyAssessmentPayload(incomplete).code,
    "INCOMPLETE_SAFETY_ASSESSMENT"
  );

  assert.equal(
    validateSafetyAssessmentPayload({
      ...safeAssessment(),
      disposition: "continue",
    }).code,
    "UNSUPPORTED_SAFETY_FIELDS"
  );
});

test("Safety disposition is derived server-side", () => {
  assert.equal(deriveSafetyDisposition(safeAssessment()), "continue");

  assert.equal(
    deriveSafetyDisposition(safeAssessment({ medicalEmergency: true })),
    "contact_emergency_services"
  );

  assert.equal(
    deriveSafetyDisposition(safeAssessment({ fireOrSmoke: true })),
    "contact_emergency_services"
  );

  assert.equal(
    deriveSafetyDisposition(
      safeAssessment({ safeToRemainAtLocation: false })
    ),
    "leave_location"
  );

  assert.equal(
    deriveSafetyDisposition(
      safeAssessment({ structuralCollapseRisk: true })
    ),
    "leave_location"
  );

  assert.equal(
    deriveSafetyDisposition(
      safeAssessment({ electricalImmediateHazard: true })
    ),
    "manual_review"
  );
});

test("validated safety assessment returns only the derived disposition", () => {
  const result = validateSafetyAssessmentPayload(
    safeAssessment({ gasOdorOrSuspectedLeak: true })
  );

  assert.equal(result.valid, true);
  assert.equal(result.value.disposition, "contact_emergency_services");
});

test("Emergency serializer excludes homeowner and persistence authority", () => {
  const serialized = serializeEmergencyRequest(
    {
      id: 8,
      homeowner_id: 91,
      category: "home_repair",
      service_domain: "electrical",
      service_specialty: "emergency_wiring",
      title: "Power issue",
      description: "Partial outage.",
      location_text: "Cape Coral",
      unit_number: "",
      access_notes: "Call first.",
      status: "draft",
      requested_at: null,
      assigned_at: null,
      resolved_at: null,
      cancelled_at: null,
      expired_at: null,
      created_at: "created",
      updated_at: "updated",
    },
    {
      immediate_danger: false,
      medical_emergency: false,
      fire_or_smoke: false,
      gas_odor_or_suspected_leak: false,
      active_crime_or_threat: false,
      electrical_immediate_hazard: false,
      structural_collapse_risk: false,
      flooding_or_water_damage: false,
      occupants_unable_to_exit: false,
      emergency_services_contacted: false,
      safe_to_remain_at_location: true,
      additional_safety_context: "",
      disposition: "continue",
      created_at: "assessment-created",
      updated_at: "assessment-updated",
    }
  );

  assert.equal(serialized.id, 8);
  assert.equal(serialized.homeowner_id, undefined);
  assert.equal(serialized.status, "draft");
  assert.equal(serialized.safetyAssessment.disposition, "continue");
});


function createEmergencyMockPool(handler) {
  const calls = [];
  let released = false;

  const client = {
    async query(text, params = []) {
      const sql = String(text).replace(/\s+/g, " ").trim();
      calls.push({ sql, params });
      return handler({ sql, params });
    },
    release() {
      released = true;
    },
  };

  return {
    calls,
    get released() {
      return released;
    },
    async connect() {
      return client;
    },
    async query(text, params = []) {
      return client.query(text, params);
    },
  };
}

function persistedEmergencyRow(overrides = {}) {
  return {
    id: 41,
    homeowner_id: 7,
    category: "home_repair",
    service_domain: "electrical",
    service_specialty: "emergency_wiring",
    title: "Power issue",
    description: "Partial outage.",
    location_text: "Cape Coral",
    unit_number: "",
    access_notes: "Call first.",
    status: "draft",
    requested_at: null,
    assigned_at: null,
    resolved_at: null,
    cancelled_at: null,
    expired_at: null,
    created_at: "created",
    updated_at: "updated",
    assessment_id: null,
    ...overrides,
  };
}

function persistedAssessmentRow(overrides = {}) {
  return {
    immediate_danger: false,
    medical_emergency: false,
    fire_or_smoke: false,
    gas_odor_or_suspected_leak: false,
    active_crime_or_threat: false,
    electrical_immediate_hazard: false,
    structural_collapse_risk: false,
    flooding_or_water_damage: false,
    occupants_unable_to_exit: false,
    emergency_services_contacted: false,
    safe_to_remain_at_location: true,
    additional_safety_context: "",
    disposition: "continue",
    created_at: "assessment-created",
    updated_at: "assessment-updated",
    ...overrides,
  };
}

test("draft creation persists authenticated owner and governed fields", async () => {
  const pool = createEmergencyMockPool(({ sql, params }) => {
    assert.match(sql, /^INSERT INTO emergency_requests/i);
    assert.deepEqual(params, [
      7,
      "home_repair",
      "electrical",
      "emergency_wiring",
      "Power issue",
      "Partial outage.",
      "Cape Coral",
      "",
      "Call first.",
    ]);

    return { rows: [persistedEmergencyRow()] };
  });

  const result = await createEmergencyDraft({
    pool,
    homeownerUserId: 7,
    payload: {
      category: "Home Repair",
      serviceDomain: "Electrical",
      serviceSpecialty: "Emergency Wiring",
      title: "Power issue",
      description: "Partial outage.",
      locationText: "Cape Coral",
      unitNumber: "",
      accessNotes: "Call first.",
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 201);
  assert.equal(result.emergencyRequest.id, 41);
  assert.equal(result.emergencyRequest.homeowner_id, undefined);
});

test("owned read scopes request identity to homeowner identity", async () => {
  const pool = createEmergencyMockPool(({ sql, params }) => {
    assert.match(
      sql,
      /emergency_requests\.id = \$1.*emergency_requests\.homeowner_id = \$2/i
    );
    assert.deepEqual(params, [41, 7]);
    return { rows: [] };
  });

  const result = await getOwnedEmergencyRequest({
    pool,
    homeownerUserId: 7,
    emergencyRequestId: 41,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.equal(result.code, "EMERGENCY_REQUEST_NOT_FOUND");
});

test("draft update locks, commits, and releases the transaction client", async () => {
  const pool = createEmergencyMockPool(({ sql, params }) => {
    if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] };

    if (/SELECT emergency_requests\.\*/i.test(sql)) {
      assert.match(sql, /FOR UPDATE OF emergency_requests/i);
      return { rows: [persistedEmergencyRow()] };
    }

    if (/^UPDATE emergency_requests SET title = \$1/i.test(sql)) {
      assert.deepEqual(params, ["Updated title", 41]);
      return {
        rows: [persistedEmergencyRow({ title: "Updated title" })],
      };
    }

    throw new Error(`Unexpected SQL: ${sql}`);
  });

  const result = await updateEmergencyDraft({
    pool,
    homeownerUserId: 7,
    emergencyRequestId: 41,
    payload: { title: "Updated title" },
  });

  assert.equal(result.ok, true);
  assert.equal(result.emergencyRequest.title, "Updated title");
  assert.equal(pool.released, true);
});

test("unsafe assessment derives disposition and safety-blocks atomically", async () => {
  const pool = createEmergencyMockPool(({ sql, params }) => {
    if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] };

    if (/SELECT emergency_requests\.\*/i.test(sql)) {
      return { rows: [persistedEmergencyRow()] };
    }

    if (/^INSERT INTO emergency_request_safety_assessments/i.test(sql)) {
      assert.equal(params.at(-1), "contact_emergency_services");

      return {
        rows: [
          persistedAssessmentRow({
            fire_or_smoke: true,
            disposition: "contact_emergency_services",
          }),
        ],
      };
    }

    if (/^UPDATE emergency_requests SET status = 'safety_blocked'/i.test(sql)) {
      return {
        rows: [
          persistedEmergencyRow({
            status: "safety_blocked",
          }),
        ],
      };
    }

    throw new Error(`Unexpected SQL: ${sql}`);
  });

  const result = await saveEmergencySafetyAssessment({
    pool,
    homeownerUserId: 7,
    emergencyRequestId: 41,
    payload: safeAssessment({ fireOrSmoke: true }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.code, "EMERGENCY_REQUEST_SAFETY_BLOCKED");
  assert.equal(result.emergencyRequest.status, "safety_blocked");
});

test("complete safe draft prepares to ready_for_distribution only", async () => {
  const ownedRow = persistedEmergencyRow({
    assessment_id: 51,
    immediate_danger: false,
    medical_emergency: false,
    fire_or_smoke: false,
    gas_odor_or_suspected_leak: false,
    active_crime_or_threat: false,
    electrical_immediate_hazard: false,
    structural_collapse_risk: false,
    flooding_or_water_damage: false,
    occupants_unable_to_exit: false,
    emergency_services_contacted: false,
    safe_to_remain_at_location: true,
    additional_safety_context: "",
    disposition: "continue",
    assessment_created_at: "assessment-created",
    assessment_updated_at: "assessment-updated",
  });

  const pool = createEmergencyMockPool(({ sql }) => {
    if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] };

    if (/SELECT emergency_requests\.\*/i.test(sql)) {
      return { rows: [ownedRow] };
    }

    if (
      /^UPDATE emergency_requests SET status = 'ready_for_distribution'/i.test(
        sql
      )
    ) {
      assert.doesNotMatch(sql, /status = 'active'/i);

      return {
        rows: [
          persistedEmergencyRow({
            status: "ready_for_distribution",
            requested_at: "requested",
          }),
        ],
      };
    }

    throw new Error(`Unexpected SQL: ${sql}`);
  });

  const result = await prepareEmergencyRequest({
    pool,
    homeownerUserId: 7,
    emergencyRequestId: 41,
  });

  assert.equal(result.ok, true);
  assert.equal(result.code, "EMERGENCY_REQUEST_PREPARED");
  assert.equal(result.emergencyRequest.status, "ready_for_distribution");
});

test("cancellation is timestamped and idempotent", async () => {
  const firstPool = createEmergencyMockPool(({ sql }) => {
    if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] };

    if (/SELECT emergency_requests\.\*/i.test(sql)) {
      return { rows: [persistedEmergencyRow()] };
    }

    if (/^UPDATE emergency_requests SET status = 'cancelled'/i.test(sql)) {
      assert.match(
        sql,
        /cancelled_at = COALESCE\(cancelled_at, CURRENT_TIMESTAMP\)/i
      );

      return {
        rows: [
          persistedEmergencyRow({
            status: "cancelled",
            cancelled_at: "cancelled",
          }),
        ],
      };
    }

    throw new Error(`Unexpected SQL: ${sql}`);
  });

  const first = await cancelEmergencyRequest({
    pool: firstPool,
    homeownerUserId: 7,
    emergencyRequestId: 41,
  });

  assert.equal(first.code, "EMERGENCY_REQUEST_CANCELLED");

  let mutated = false;

  const secondPool = createEmergencyMockPool(({ sql }) => {
    if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [] };

    if (/SELECT emergency_requests\.\*/i.test(sql)) {
      return {
        rows: [
          persistedEmergencyRow({
            status: "cancelled",
            cancelled_at: "cancelled",
          }),
        ],
      };
    }

    if (/^UPDATE emergency_requests/i.test(sql)) mutated = true;

    throw new Error(`Unexpected SQL: ${sql}`);
  });

  const second = await cancelEmergencyRequest({
    pool: secondPool,
    homeownerUserId: 7,
    emergencyRequestId: 41,
  });

  assert.equal(second.code, "EMERGENCY_REQUEST_ALREADY_CANCELLED");
  assert.equal(mutated, false);
});

test("persistence failure rolls back and releases the client", async () => {
  let rolledBack = false;

  const pool = createEmergencyMockPool(({ sql }) => {
    if (sql === "BEGIN") return { rows: [] };

    if (/SELECT emergency_requests\.\*/i.test(sql)) {
      return { rows: [persistedEmergencyRow()] };
    }

    if (/^UPDATE emergency_requests/i.test(sql)) {
      throw new Error("simulated persistence failure");
    }

    if (sql === "ROLLBACK") {
      rolledBack = true;
      return { rows: [] };
    }

    throw new Error(`Unexpected SQL: ${sql}`);
  });

  await assert.rejects(
    updateEmergencyDraft({
      pool,
      homeownerUserId: 7,
      emergencyRequestId: 41,
      payload: { title: "Updated title" },
    }),
    /simulated persistence failure/
  );

  assert.equal(rolledBack, true);
  assert.equal(pool.released, true);
});
