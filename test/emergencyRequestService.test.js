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
    serviceDomain: "Home Services",
    serviceSpecialty: "Electrical",
    title: "Power issue",
    description: "Partial outage in the home.",
    locationText: "Cape Coral, FL",
    unitNumber: "",
    accessNotes: "Call before arrival.",
  });

  assert.equal(result.valid, true);
  assert.deepEqual(result.value, {
    category: "home_repair",
    serviceDomain: "home_services",
    serviceSpecialty: "electrical",
    title: "Power issue",
    description: "Partial outage in the home.",
    locationText: "Cape Coral, FL",
    unitNumber: "",
    accessNotes: "Call before arrival.",
  });

  assert.equal(
    validateEmergencyDraftPayload({
      category: "repair",
      serviceDomain: "home_services",
      serviceSpecialty: "electrical",
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

test("Emergency taxonomy derives canonical domains and rejects invalid pairs", () => {
  const omittedDomain = validateEmergencyDraftPayload({
    category: "Home Repair",
    serviceSpecialty: "Electrical",
    title: "Power issue",
    description: "Partial outage in the home.",
    locationText: "Cape Coral, FL",
    unitNumber: "",
    accessNotes: "Call before arrival.",
  });

  assert.equal(omittedDomain.valid, true);
  assert.equal(
    omittedDomain.value.serviceDomain,
    "home_services"
  );
  assert.equal(
    omittedDomain.value.serviceSpecialty,
    "electrical"
  );

  const mismatch = validateEmergencyDraftPayload({
    category: "Home Repair",
    serviceDomain: "Electrical",
    serviceSpecialty: "Electrical",
    title: "Power issue",
    description: "Partial outage in the home.",
    locationText: "Cape Coral, FL",
    unitNumber: "",
    accessNotes: "Call before arrival.",
  });

  assert.equal(mismatch.valid, false);
  assert.equal(
    mismatch.code,
    "EMERGENCY_SERVICE_TAXONOMY_MISMATCH"
  );
  assert.equal(
    mismatch.message,
    "serviceDomain is not compatible with serviceSpecialty."
  );

  const unknown = validateEmergencyDraftPayload({
    category: "Home Repair",
    serviceDomain: "Home Services",
    serviceSpecialty: "not_a_real_specialty",
    title: "Power issue",
    description: "Partial outage in the home.",
    locationText: "Cape Coral, FL",
    unitNumber: "",
    accessNotes: "Call before arrival.",
  });

  assert.equal(unknown.valid, false);
  assert.equal(
    unknown.code,
    "INVALID_EMERGENCY_SERVICE_SPECIALTY"
  );

  const missing = validateEmergencyDraftPayload({
    category: "Home Repair",
    serviceDomain: "Home Services",
    title: "Power issue",
    description: "Partial outage in the home.",
    locationText: "Cape Coral, FL",
    unitNumber: "",
    accessNotes: "Call before arrival.",
  });

  assert.equal(missing.valid, false);
  assert.equal(missing.code, "INVALID_EMERGENCY_FIELD");
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
      service_domain: "home_services",
      service_specialty: "electrical",
      title: "Power issue",
      description: "Partial outage.",
      location_text: "Cape Coral",
      unit_number: "",
      access_notes: "Call first.",
      status: "draft",
      requested_at: null,
      assigned_at: null,
      en_route_at: null,
      arrived_at: null,
      work_started_at: null,
      completed_at: null,
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
  assert.deepEqual(
    {
      assignedAt: serialized.assignedAt,
      enRouteAt: serialized.enRouteAt,
      arrivedAt: serialized.arrivedAt,
      workStartedAt: serialized.workStartedAt,
      completedAt: serialized.completedAt,
    },
    {
      assignedAt: null,
      enRouteAt: null,
      arrivedAt: null,
      workStartedAt: null,
      completedAt: null,
    }
  );
  assert.equal(serialized.safetyAssessment.disposition, "continue");
});

test("Emergency serializer preserves canonical dispatch lifecycle state", () => {
  const stages = [
    {
      status: "professional_en_route",
      enRouteAt: "en-route",
      arrivedAt: null,
      workStartedAt: null,
      completedAt: null,
    },
    {
      status: "professional_arrived",
      enRouteAt: "en-route",
      arrivedAt: "arrived",
      workStartedAt: null,
      completedAt: null,
    },
    {
      status: "work_in_progress",
      enRouteAt: "en-route",
      arrivedAt: "arrived",
      workStartedAt: "work-started",
      completedAt: null,
    },
    {
      status: "completed",
      enRouteAt: "en-route",
      arrivedAt: "arrived",
      workStartedAt: "work-started",
      completedAt: "completed",
    },
  ];

  for (const stage of stages) {
    const serialized = serializeEmergencyRequest({
      status: stage.status,
      assigned_at: "assigned",
      en_route_at: stage.enRouteAt,
      arrived_at: stage.arrivedAt,
      work_started_at: stage.workStartedAt,
      completed_at: stage.completedAt,
      professional_email: "private@example.com",
      professional_phone: "private-phone",
    });

    assert.deepEqual(
      {
        status: serialized.status,
        assignedAt: serialized.assignedAt,
        enRouteAt: serialized.enRouteAt,
        arrivedAt: serialized.arrivedAt,
        workStartedAt: serialized.workStartedAt,
        completedAt: serialized.completedAt,
      },
      {
        status: stage.status,
        assignedAt: "assigned",
        enRouteAt: stage.enRouteAt,
        arrivedAt: stage.arrivedAt,
        workStartedAt: stage.workStartedAt,
        completedAt: stage.completedAt,
      }
    );
    assert.equal(serialized.professional_email, undefined);
    assert.equal(serialized.professional_phone, undefined);
  }
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
    service_domain: "home_services",
    service_specialty: "electrical",
    title: "Power issue",
    description: "Partial outage.",
    location_text: "Cape Coral",
    unit_number: "",
    access_notes: "Call first.",
    status: "draft",
    requested_at: null,
    assigned_at: null,
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

function persistedSafeOwnedEmergencyRow(overrides = {}) {
  return persistedEmergencyRow({
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
    ...overrides,
  });
}

test("draft creation persists authenticated owner and governed fields", async () => {
  const pool = createEmergencyMockPool(({ sql, params }) => {
    assert.match(sql, /^INSERT INTO emergency_requests/i);
    assert.deepEqual(params, [
      7,
      "home_repair",
      "home_services",
      "electrical",
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
      serviceDomain: "Home Services",
      serviceSpecialty: "Electrical",
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

test("draft creation derives an omitted canonical service domain", async () => {
  const pool = createEmergencyMockPool(({ sql, params }) => {
    assert.match(sql, /^INSERT INTO emergency_requests/i);
    assert.equal(params[2], "home_services");
    assert.equal(params[3], "electrical");

    return {
      rows: [
        persistedEmergencyRow({
          service_domain: params[2],
          service_specialty: params[3],
        }),
      ],
    };
  });

  const result = await createEmergencyDraft({
    pool,
    homeownerUserId: 7,
    payload: {
      category: "Home Repair",
      serviceSpecialty: "Electrical",
      title: "Power issue",
      description: "Partial outage.",
      locationText: "Cape Coral",
      unitNumber: "",
      accessNotes: "Call first.",
    },
  });

  assert.equal(result.ok, true);
  assert.equal(
    result.emergencyRequest.serviceDomain,
    "home_services"
  );
  assert.equal(
    result.emergencyRequest.serviceSpecialty,
    "electrical"
  );
});

test("invalid Emergency taxonomy performs no draft insert", async () => {
  for (const payload of [
    {
      serviceDomain: "Electrical",
      serviceSpecialty: "Electrical",
      expectedCode: "EMERGENCY_SERVICE_TAXONOMY_MISMATCH",
    },
    {
      serviceDomain: "Home Services",
      serviceSpecialty: "not_a_real_specialty",
      expectedCode: "INVALID_EMERGENCY_SERVICE_SPECIALTY",
    },
    {
      serviceDomain: "Home Services",
      expectedCode: "INVALID_EMERGENCY_FIELD",
    },
  ]) {
    let queryCount = 0;
    const result = await createEmergencyDraft({
      pool: {
        async query() {
          queryCount += 1;
          throw new Error("Database must not be reached.");
        },
      },
      homeownerUserId: 7,
      payload: {
        category: "Home Repair",
        serviceDomain: payload.serviceDomain,
        ...(payload.serviceSpecialty
          ? {
              serviceSpecialty:
                payload.serviceSpecialty,
            }
          : {}),
        title: "Power issue",
        description: "Partial outage.",
        locationText: "Cape Coral",
        unitNumber: "",
        accessNotes: "Call first.",
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.equal(result.code, payload.expectedCode);
    assert.equal(queryCount, 0);
  }
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

test("draft specialty updates persist the derived canonical domain", async () => {
  const pool = createEmergencyMockPool(({ sql, params }) => {
    if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] };

    if (/SELECT emergency_requests\.\*/i.test(sql)) {
      return { rows: [persistedEmergencyRow()] };
    }

    if (
      /^UPDATE emergency_requests SET service_specialty = \$1, service_domain = \$2/i.test(
        sql
      )
    ) {
      assert.deepEqual(params, [
        "electrical",
        "home_services",
        41,
      ]);
      return {
        rows: [
          persistedEmergencyRow({
            service_domain: "home_services",
            service_specialty: "electrical",
          }),
        ],
      };
    }

    throw new Error(`Unexpected SQL: ${sql}`);
  });

  const result = await updateEmergencyDraft({
    pool,
    homeownerUserId: 7,
    emergencyRequestId: 41,
    payload: {
      serviceSpecialty: "Electrical",
    },
  });

  assert.equal(result.ok, true);
  assert.equal(
    result.emergencyRequest.serviceDomain,
    "home_services"
  );
  assert.equal(
    result.emergencyRequest.serviceSpecialty,
    "electrical"
  );
});

test("draft domain-only updates reject a mismatch before persistence", async () => {
  let updated = false;
  const pool = createEmergencyMockPool(({ sql }) => {
    if (sql === "BEGIN" || sql === "ROLLBACK") {
      return { rows: [] };
    }

    if (/SELECT emergency_requests\.\*/i.test(sql)) {
      return { rows: [persistedEmergencyRow()] };
    }

    if (/^UPDATE emergency_requests/i.test(sql)) {
      updated = true;
    }

    throw new Error(`Unexpected SQL: ${sql}`);
  });

  const result = await updateEmergencyDraft({
    pool,
    homeownerUserId: 7,
    emergencyRequestId: 41,
    payload: {
      serviceDomain: "Electrical",
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.equal(
    result.code,
    "EMERGENCY_SERVICE_TAXONOMY_MISMATCH"
  );
  assert.equal(updated, false);
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

test("complete safe plumbing draft prepares with empty optional fields", async () => {
  const ownedRow = persistedSafeOwnedEmergencyRow({
    category: "home_repair",
    service_domain: "home_services",
    service_specialty: "emergency_plumbing",
    title: "Leak water",
    description: "main housepipe leaking water",
    location_text: "cape coral",
    unit_number: "",
    access_notes: "",
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
          {
            ...ownedRow,
            status: "ready_for_distribution",
            requested_at: "requested",
          },
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
  assert.equal(result.emergencyRequest.unitNumber, "");
  assert.equal(result.emergencyRequest.accessNotes, "");
  assert.equal(
    result.emergencyRequest.safetyAssessment.disposition,
    "continue"
  );
  assert.equal(
    result.emergencyRequest.safetyAssessment.emergencyServicesContacted,
    false
  );
  assert.equal(
    result.emergencyRequest.safetyAssessment.additionalSafetyContext,
    ""
  );
  for (const field of [
    "immediateDanger",
    "medicalEmergency",
    "fireOrSmoke",
    "gasOdorOrSuspectedLeak",
    "activeCrimeOrThreat",
    "electricalImmediateHazard",
    "structuralCollapseRisk",
    "floodingOrWaterDamage",
    "occupantsUnableToExit",
  ]) {
    assert.equal(
      result.emergencyRequest.safetyAssessment[field],
      false
    );
  }
});

test("prepare still rejects empty required details and missing safety", async () => {
  const incompleteRows = [
    persistedSafeOwnedEmergencyRow({ category: "" }),
    persistedSafeOwnedEmergencyRow({ service_domain: "" }),
    persistedSafeOwnedEmergencyRow({ service_specialty: "" }),
    persistedSafeOwnedEmergencyRow({ title: "" }),
    persistedSafeOwnedEmergencyRow({ description: "" }),
    persistedSafeOwnedEmergencyRow({ location_text: "" }),
    persistedEmergencyRow({
      unit_number: "",
      access_notes: "",
    }),
  ];

  for (const ownedRow of incompleteRows) {
    let updated = false;
    const pool = createEmergencyMockPool(({ sql }) => {
      if (sql === "BEGIN" || sql === "ROLLBACK") {
        return { rows: [] };
      }

      if (/SELECT emergency_requests\.\*/i.test(sql)) {
        return { rows: [ownedRow] };
      }

      if (/^UPDATE emergency_requests/i.test(sql)) {
        updated = true;
      }

      throw new Error(`Unexpected SQL: ${sql}`);
    });

    const result = await prepareEmergencyRequest({
      pool,
      homeownerUserId: 7,
      emergencyRequestId: 41,
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, 409);
    assert.equal(result.code, "EMERGENCY_REQUEST_INCOMPLETE");
    assert.equal(updated, false);
  }
});

test("prepare still safety-blocks a non-continue assessment", async () => {
  let updated = false;
  const pool = createEmergencyMockPool(({ sql }) => {
    if (sql === "BEGIN" || sql === "ROLLBACK") {
      return { rows: [] };
    }

    if (/SELECT emergency_requests\.\*/i.test(sql)) {
      return {
        rows: [
          persistedSafeOwnedEmergencyRow({
            access_notes: "",
            disposition: "manual_review",
          }),
        ],
      };
    }

    if (/^UPDATE emergency_requests/i.test(sql)) {
      updated = true;
    }

    throw new Error(`Unexpected SQL: ${sql}`);
  });

  const result = await prepareEmergencyRequest({
    pool,
    homeownerUserId: 7,
    emergencyRequestId: 41,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(result.code, "EMERGENCY_REQUEST_SAFETY_BLOCKED");
  assert.equal(updated, false);
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

test("cancellation allows only the canonical pre-selection states", async (t) => {
  const cancellableStatuses = [
    "draft",
    "ready_for_distribution",
    "active",
    "selection_pending",
  ];

  for (const status of cancellableStatuses) {
    await t.test(status, async () => {
      let updated = false;
      const pool = createEmergencyMockPool(({ sql }) => {
        if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] };

        if (/SELECT emergency_requests\.\*/i.test(sql)) {
          return { rows: [persistedEmergencyRow({ status })] };
        }

        if (/^UPDATE emergency_requests SET status = 'cancelled'/i.test(sql)) {
          updated = true;
          return {
            rows: [persistedEmergencyRow({ status: "cancelled" })],
          };
        }

        throw new Error(`Unexpected SQL: ${sql}`);
      });

      const result = await cancelEmergencyRequest({
        pool,
        homeownerUserId: 7,
        emergencyRequestId: 41,
      });

      assert.equal(result.ok, true);
      assert.equal(result.status, 200);
      assert.equal(result.code, "EMERGENCY_REQUEST_CANCELLED");
      assert.equal(updated, true);
    });
  }
});

test("cancellation rejects dispatch, terminal, and unknown states without writing", async (t) => {
  const nonCancellableStatuses = [
    "assigned",
    "professional_en_route",
    "professional_arrived",
    "in_service",
    "work_in_progress",
    "resolved",
    "completed",
    "expired",
    "unable_to_match",
    "safety_blocked",
    "unknown_future_state",
  ];

  for (const status of nonCancellableStatuses) {
    await t.test(status, async () => {
      let mutated = false;
      let rolledBack = false;
      const pool = createEmergencyMockPool(({ sql }) => {
        if (sql === "BEGIN") return { rows: [] };
        if (sql === "ROLLBACK") {
          rolledBack = true;
          return { rows: [] };
        }

        if (/SELECT emergency_requests\.\*/i.test(sql)) {
          return { rows: [persistedEmergencyRow({ status })] };
        }

        if (/^UPDATE emergency_requests/i.test(sql)) {
          mutated = true;
        }

        throw new Error(`Unexpected SQL: ${sql}`);
      });

      const result = await cancelEmergencyRequest({
        pool,
        homeownerUserId: 7,
        emergencyRequestId: 41,
      });

      assert.equal(result.ok, false);
      assert.equal(result.status, 409);
      assert.equal(result.code, "EMERGENCY_REQUEST_NOT_CANCELLABLE");
      assert.equal(mutated, false);
      assert.equal(rolledBack, true);
    });
  }
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
