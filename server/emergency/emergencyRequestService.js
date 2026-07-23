"use strict";

const EMERGENCY_REQUEST_STATUSES = Object.freeze([
  "draft",
  "ready_for_distribution",
  "active",
  "selection_pending",
  "assigned",
  "in_service",
  "resolved",
  "cancelled",
  "expired",
  "unable_to_match",
  "safety_blocked",
]);

const SAFETY_DISPOSITIONS = Object.freeze([
  "continue",
  "contact_emergency_services",
  "leave_location",
  "manual_review",
]);

const SAFETY_BOOLEAN_FIELDS = Object.freeze([
  "immediateDanger",
  "medicalEmergency",
  "fireOrSmoke",
  "gasOdorOrSuspectedLeak",
  "activeCrimeOrThreat",
  "electricalImmediateHazard",
  "structuralCollapseRisk",
  "floodingOrWaterDamage",
  "occupantsUnableToExit",
  "emergencyServicesContacted",
  "safeToRemainAtLocation",
]);

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parsePositiveInteger(value) {
  const normalized = String(value ?? "").trim();
  if (!/^[1-9]\d*$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function cleanText(value, limit, { required = false } = {}) {
  if (value === undefined || value === null) return required ? null : "";
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  if ((required && !cleaned) || cleaned.length > limit) return null;
  return cleaned;
}

function normalizeIdentifier(value) {
  return String(value ?? "")
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function validateEmergencyDraftPayload(body, { partial = false } = {}) {
  if (!isRecord(body)) {
    return {
      valid: false,
      code: "INVALID_EMERGENCY_REQUEST",
      message: "Emergency request details must be an object.",
    };
  }

  const allowed = new Set([
    "category",
    "serviceDomain",
    "serviceSpecialty",
    "title",
    "description",
    "locationText",
    "unitNumber",
    "accessNotes",
  ]);

  if (Object.keys(body).some((key) => !allowed.has(key))) {
    return {
      valid: false,
      code: "UNSUPPORTED_EMERGENCY_FIELDS",
      message: "One or more Emergency request fields are not supported.",
    };
  }

  if (partial && Object.keys(body).length === 0) {
    return {
      valid: false,
      code: "EMERGENCY_UPDATE_REQUIRED",
      message: "At least one editable Emergency field is required.",
    };
  }

  const fields = {
    category: cleanText(body.category, 100, {
      required: !partial || body.category !== undefined,
    }),
    serviceDomain: cleanText(body.serviceDomain, 100, {
      required: !partial || body.serviceDomain !== undefined,
    }),
    serviceSpecialty: cleanText(body.serviceSpecialty, 160, {
      required: !partial || body.serviceSpecialty !== undefined,
    }),
    title: cleanText(body.title, 160, {
      required: !partial || body.title !== undefined,
    }),
    description: cleanText(body.description, 5000),
    locationText: cleanText(body.locationText, 500, {
      required: !partial || body.locationText !== undefined,
    }),
    unitNumber: cleanText(body.unitNumber, 100),
    accessNotes: cleanText(body.accessNotes, 1000),
  };

  if (Object.values(fields).includes(null)) {
    return {
      valid: false,
      code: "INVALID_EMERGENCY_FIELD",
      message: "One or more Emergency request fields are invalid.",
    };
  }

  const value = {};
  for (const [key, fieldValue] of Object.entries(fields)) {
    if (!partial || body[key] !== undefined) {
      value[key] = ["category", "serviceDomain", "serviceSpecialty"].includes(key)
        ? normalizeIdentifier(fieldValue)
        : fieldValue;
    }
  }

  return { valid: true, value };
}

function deriveSafetyDisposition(assessment) {
  if (
    assessment.medicalEmergency ||
    assessment.fireOrSmoke ||
    assessment.gasOdorOrSuspectedLeak ||
    assessment.activeCrimeOrThreat
  ) {
    return "contact_emergency_services";
  }

  if (
    assessment.immediateDanger ||
    assessment.structuralCollapseRisk ||
    assessment.occupantsUnableToExit ||
    !assessment.safeToRemainAtLocation
  ) {
    return "leave_location";
  }

  if (
    assessment.electricalImmediateHazard ||
    assessment.floodingOrWaterDamage
  ) {
    return "manual_review";
  }

  return "continue";
}

function validateSafetyAssessmentPayload(body) {
  if (!isRecord(body)) {
    return {
      valid: false,
      code: "INVALID_SAFETY_ASSESSMENT",
      message: "Safety assessment details must be an object.",
    };
  }

  const allowed = new Set([
    ...SAFETY_BOOLEAN_FIELDS,
    "additionalSafetyContext",
  ]);

  if (Object.keys(body).some((key) => !allowed.has(key))) {
    return {
      valid: false,
      code: "UNSUPPORTED_SAFETY_FIELDS",
      message: "One or more safety assessment fields are not supported.",
    };
  }

  for (const field of SAFETY_BOOLEAN_FIELDS) {
    if (typeof body[field] !== "boolean") {
      return {
        valid: false,
        code: "INCOMPLETE_SAFETY_ASSESSMENT",
        message: "Every required safety question must be answered.",
      };
    }
  }

  const additionalSafetyContext = cleanText(
    body.additionalSafetyContext,
    2000
  );

  if (additionalSafetyContext === null) {
    return {
      valid: false,
      code: "INVALID_SAFETY_CONTEXT",
      message: "Additional safety context is invalid.",
    };
  }

  const value = {
    ...Object.fromEntries(
      SAFETY_BOOLEAN_FIELDS.map((field) => [field, body[field]])
    ),
    additionalSafetyContext,
  };

  return {
    valid: true,
    value: {
      ...value,
      disposition: deriveSafetyDisposition(value),
    },
  };
}

function serializeEmergencyRequest(row = {}, assessment = null) {
  return {
    id: row.id,
    category: row.category,
    serviceDomain: row.service_domain,
    serviceSpecialty: row.service_specialty,
    title: row.title,
    description: row.description,
    locationText: row.location_text,
    unitNumber: row.unit_number,
    accessNotes: row.access_notes,
    status: EMERGENCY_REQUEST_STATUSES.includes(row.status)
      ? row.status
      : "draft",
    requestedAt: row.requested_at,
    assignedAt: row.assigned_at,
    resolvedAt: row.resolved_at,
    cancelledAt: row.cancelled_at,
    expiredAt: row.expired_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    safetyAssessment: assessment
      ? {
          immediateDanger: assessment.immediate_danger,
          medicalEmergency: assessment.medical_emergency,
          fireOrSmoke: assessment.fire_or_smoke,
          gasOdorOrSuspectedLeak: assessment.gas_odor_or_suspected_leak,
          activeCrimeOrThreat: assessment.active_crime_or_threat,
          electricalImmediateHazard: assessment.electrical_immediate_hazard,
          structuralCollapseRisk: assessment.structural_collapse_risk,
          floodingOrWaterDamage: assessment.flooding_or_water_damage,
          occupantsUnableToExit: assessment.occupants_unable_to_exit,
          emergencyServicesContacted:
            assessment.emergency_services_contacted,
          safeToRemainAtLocation: assessment.safe_to_remain_at_location,
          additionalSafetyContext:
            assessment.additional_safety_context,
          disposition: SAFETY_DISPOSITIONS.includes(assessment.disposition)
            ? assessment.disposition
            : "manual_review",
          createdAt: assessment.created_at,
          updatedAt: assessment.updated_at,
        }
      : null,
  };
}

async function createEmergencyDraft({ pool, homeownerUserId, payload }) {
  const validation = validateEmergencyDraftPayload(payload);

  if (!validation.valid) {
    return {
      ok: false,
      status: 400,
      code: validation.code,
      message: validation.message,
    };
  }

  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("A database pool or client is required.");
  }

  const value = validation.value;
  const result = await pool.query(
    `
    INSERT INTO emergency_requests
    (
      homeowner_id,
      category,
      service_domain,
      service_specialty,
      title,
      description,
      location_text,
      unit_number,
      access_notes,
      status
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'draft')
    RETURNING *
    `,
    [
      homeownerUserId,
      value.category,
      value.serviceDomain,
      value.serviceSpecialty,
      value.title,
      value.description,
      value.locationText,
      value.unitNumber,
      value.accessNotes,
    ]
  );

  return {
    ok: true,
    status: 201,
    code: "EMERGENCY_DRAFT_CREATED",
    emergencyRequest: serializeEmergencyRequest(result.rows[0]),
  };
}

async function getOwnedEmergencyRequest({
  pool,
  homeownerUserId,
  emergencyRequestId: rawEmergencyRequestId,
  lock = false,
}) {
  const emergencyRequestId = parsePositiveInteger(rawEmergencyRequestId);

  if (!emergencyRequestId) {
    return {
      ok: false,
      status: 400,
      code: "INVALID_EMERGENCY_REQUEST_ID",
      message: "A valid Emergency request ID is required.",
    };
  }

  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("A database pool or client is required.");
  }

  const result = await pool.query(
    `
    SELECT
      emergency_requests.*,
      emergency_request_safety_assessments.id AS assessment_id,
      emergency_request_safety_assessments.immediate_danger,
      emergency_request_safety_assessments.medical_emergency,
      emergency_request_safety_assessments.fire_or_smoke,
      emergency_request_safety_assessments.gas_odor_or_suspected_leak,
      emergency_request_safety_assessments.active_crime_or_threat,
      emergency_request_safety_assessments.electrical_immediate_hazard,
      emergency_request_safety_assessments.structural_collapse_risk,
      emergency_request_safety_assessments.flooding_or_water_damage,
      emergency_request_safety_assessments.occupants_unable_to_exit,
      emergency_request_safety_assessments.emergency_services_contacted,
      emergency_request_safety_assessments.safe_to_remain_at_location,
      emergency_request_safety_assessments.additional_safety_context,
      emergency_request_safety_assessments.disposition,
      emergency_request_safety_assessments.created_at AS assessment_created_at,
      emergency_request_safety_assessments.updated_at AS assessment_updated_at
    FROM emergency_requests
    LEFT JOIN emergency_request_safety_assessments
      ON emergency_request_safety_assessments.emergency_request_id =
        emergency_requests.id
    WHERE emergency_requests.id = $1
      AND emergency_requests.homeowner_id = $2
    LIMIT 1
    ${lock ? "FOR UPDATE OF emergency_requests" : ""}
    `,
    [emergencyRequestId, homeownerUserId]
  );

  if (result.rows.length === 0) {
    return {
      ok: false,
      status: 404,
      code: "EMERGENCY_REQUEST_NOT_FOUND",
      message: "The Emergency request was not found.",
    };
  }

  const row = result.rows[0];
  const assessment = row.assessment_id
    ? {
        immediate_danger: row.immediate_danger,
        medical_emergency: row.medical_emergency,
        fire_or_smoke: row.fire_or_smoke,
        gas_odor_or_suspected_leak: row.gas_odor_or_suspected_leak,
        active_crime_or_threat: row.active_crime_or_threat,
        electrical_immediate_hazard: row.electrical_immediate_hazard,
        structural_collapse_risk: row.structural_collapse_risk,
        flooding_or_water_damage: row.flooding_or_water_damage,
        occupants_unable_to_exit: row.occupants_unable_to_exit,
        emergency_services_contacted: row.emergency_services_contacted,
        safe_to_remain_at_location: row.safe_to_remain_at_location,
        additional_safety_context: row.additional_safety_context,
        disposition: row.disposition,
        created_at: row.assessment_created_at,
        updated_at: row.assessment_updated_at,
      }
    : null;

  return {
    ok: true,
    status: 200,
    code: "EMERGENCY_REQUEST_FOUND",
    row,
    assessment,
    emergencyRequest: serializeEmergencyRequest(row, assessment),
  };
}

async function updateEmergencyDraft({
  pool,
  homeownerUserId,
  emergencyRequestId,
  payload,
}) {
  const validation = validateEmergencyDraftPayload(payload, { partial: true });

  if (!validation.valid) {
    return {
      ok: false,
      status: 400,
      code: validation.code,
      message: validation.message,
    };
  }

  const client =
    typeof pool?.connect === "function" ? await pool.connect() : pool;

  if (!client || typeof client.query !== "function") {
    throw new TypeError("A database pool or client is required.");
  }

  try {
    await client.query("BEGIN");

    const current = await getOwnedEmergencyRequest({
      pool: client,
      homeownerUserId,
      emergencyRequestId,
      lock: true,
    });

    if (!current.ok) {
      await client.query("ROLLBACK");
      return current;
    }

    if (current.row.status !== "draft") {
      await client.query("ROLLBACK");
      return {
        ok: false,
        status: 409,
        code: "EMERGENCY_REQUEST_NOT_EDITABLE",
        message: "Only draft Emergency requests can be edited.",
      };
    }

    const columns = {
      category: "category",
      serviceDomain: "service_domain",
      serviceSpecialty: "service_specialty",
      title: "title",
      description: "description",
      locationText: "location_text",
      unitNumber: "unit_number",
      accessNotes: "access_notes",
    };

    const assignments = [];
    const values = [];

    for (const [key, value] of Object.entries(validation.value)) {
      values.push(value);
      assignments.push(`${columns[key]} = $${values.length}`);
    }

    values.push(current.row.id);

    const result = await client.query(
      `
      UPDATE emergency_requests
      SET
        ${assignments.join(",\n        ")},
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $${values.length}
      RETURNING *
      `,
      values
    );

    await client.query("COMMIT");

    return {
      ok: true,
      status: 200,
      code: "EMERGENCY_DRAFT_UPDATED",
      emergencyRequest: serializeEmergencyRequest(
        result.rows[0],
        current.assessment
      ),
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    throw error;
  } finally {
    if (client !== pool && typeof client.release === "function") {
      client.release();
    }
  }
}

async function saveEmergencySafetyAssessment({
  pool,
  homeownerUserId,
  emergencyRequestId,
  payload,
}) {
  const validation = validateSafetyAssessmentPayload(payload);

  if (!validation.valid) {
    return {
      ok: false,
      status: 400,
      code: validation.code,
      message: validation.message,
    };
  }

  const client =
    typeof pool?.connect === "function" ? await pool.connect() : pool;

  if (!client || typeof client.query !== "function") {
    throw new TypeError("A database pool or client is required.");
  }

  try {
    await client.query("BEGIN");

    const current = await getOwnedEmergencyRequest({
      pool: client,
      homeownerUserId,
      emergencyRequestId,
      lock: true,
    });

    if (!current.ok) {
      await client.query("ROLLBACK");
      return current;
    }

    if (current.row.status !== "draft") {
      await client.query("ROLLBACK");
      return {
        ok: false,
        status: 409,
        code: "EMERGENCY_SAFETY_NOT_EDITABLE",
        message: "Safety answers can be changed only while the request is a draft.",
      };
    }

    const value = validation.value;

    const assessmentResult = await client.query(
      `
      INSERT INTO emergency_request_safety_assessments
      (
        emergency_request_id,
        immediate_danger,
        medical_emergency,
        fire_or_smoke,
        gas_odor_or_suspected_leak,
        active_crime_or_threat,
        electrical_immediate_hazard,
        structural_collapse_risk,
        flooding_or_water_damage,
        occupants_unable_to_exit,
        emergency_services_contacted,
        safe_to_remain_at_location,
        additional_safety_context,
        disposition
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10, $11, $12, $13, $14
      )
      ON CONFLICT (emergency_request_id)
      DO UPDATE SET
        immediate_danger = EXCLUDED.immediate_danger,
        medical_emergency = EXCLUDED.medical_emergency,
        fire_or_smoke = EXCLUDED.fire_or_smoke,
        gas_odor_or_suspected_leak = EXCLUDED.gas_odor_or_suspected_leak,
        active_crime_or_threat = EXCLUDED.active_crime_or_threat,
        electrical_immediate_hazard =
          EXCLUDED.electrical_immediate_hazard,
        structural_collapse_risk =
          EXCLUDED.structural_collapse_risk,
        flooding_or_water_damage =
          EXCLUDED.flooding_or_water_damage,
        occupants_unable_to_exit =
          EXCLUDED.occupants_unable_to_exit,
        emergency_services_contacted =
          EXCLUDED.emergency_services_contacted,
        safe_to_remain_at_location =
          EXCLUDED.safe_to_remain_at_location,
        additional_safety_context =
          EXCLUDED.additional_safety_context,
        disposition = EXCLUDED.disposition,
        updated_at = CURRENT_TIMESTAMP
      RETURNING *
      `,
      [
        current.row.id,
        value.immediateDanger,
        value.medicalEmergency,
        value.fireOrSmoke,
        value.gasOdorOrSuspectedLeak,
        value.activeCrimeOrThreat,
        value.electricalImmediateHazard,
        value.structuralCollapseRisk,
        value.floodingOrWaterDamage,
        value.occupantsUnableToExit,
        value.emergencyServicesContacted,
        value.safeToRemainAtLocation,
        value.additionalSafetyContext,
        value.disposition,
      ]
    );

    let requestRow = current.row;

    if (value.disposition !== "continue") {
      const blockedResult = await client.query(
        `
        UPDATE emergency_requests
        SET
          status = 'safety_blocked',
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        RETURNING *
        `,
        [current.row.id]
      );

      requestRow = blockedResult.rows[0];
    }

    await client.query("COMMIT");

    return {
      ok: true,
      status: 200,
      code:
        value.disposition === "continue"
          ? "EMERGENCY_SAFETY_ASSESSMENT_SAVED"
          : "EMERGENCY_REQUEST_SAFETY_BLOCKED",
      emergencyRequest: serializeEmergencyRequest(
        requestRow,
        assessmentResult.rows[0]
      ),
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    throw error;
  } finally {
    if (client !== pool && typeof client.release === "function") {
      client.release();
    }
  }
}

async function prepareEmergencyRequest({
  pool,
  homeownerUserId,
  emergencyRequestId,
}) {
  const client =
    typeof pool?.connect === "function" ? await pool.connect() : pool;

  if (!client || typeof client.query !== "function") {
    throw new TypeError("A database pool or client is required.");
  }

  try {
    await client.query("BEGIN");

    const current = await getOwnedEmergencyRequest({
      pool: client,
      homeownerUserId,
      emergencyRequestId,
      lock: true,
    });

    if (!current.ok) {
      await client.query("ROLLBACK");
      return current;
    }

    if (current.row.status === "safety_blocked") {
      await client.query("ROLLBACK");
      return {
        ok: false,
        status: 409,
        code: "EMERGENCY_REQUEST_SAFETY_BLOCKED",
        message: "This request cannot continue through Meetro.",
      };
    }

    if (current.row.status !== "draft") {
      await client.query("ROLLBACK");
      return {
        ok: false,
        status: 409,
        code: "EMERGENCY_REQUEST_NOT_PREPARABLE",
        message: "Only draft Emergency requests can be prepared.",
      };
    }

    const requiredFields = [
      current.row.category,
      current.row.service_domain,
      current.row.service_specialty,
      current.row.title,
      current.row.description,
      current.row.location_text,
      current.row.access_notes,
    ];

    if (
      requiredFields.some((value) => !String(value ?? "").trim()) ||
      !current.assessment
    ) {
      await client.query("ROLLBACK");
      return {
        ok: false,
        status: 409,
        code: "EMERGENCY_REQUEST_INCOMPLETE",
        message: "Complete request and safety details are required.",
      };
    }

    if (current.assessment.disposition !== "continue") {
      await client.query("ROLLBACK");
      return {
        ok: false,
        status: 409,
        code: "EMERGENCY_REQUEST_SAFETY_BLOCKED",
        message: "This request cannot continue through Meetro.",
      };
    }

    const result = await client.query(
      `
      UPDATE emergency_requests
      SET
        status = 'ready_for_distribution',
        requested_at = COALESCE(requested_at, CURRENT_TIMESTAMP),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *
      `,
      [current.row.id]
    );

    await client.query("COMMIT");

    return {
      ok: true,
      status: 200,
      code: "EMERGENCY_REQUEST_PREPARED",
      emergencyRequest: serializeEmergencyRequest(
        result.rows[0],
        current.assessment
      ),
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    throw error;
  } finally {
    if (client !== pool && typeof client.release === "function") {
      client.release();
    }
  }
}

async function cancelEmergencyRequest({
  pool,
  homeownerUserId,
  emergencyRequestId,
}) {
  const client =
    typeof pool?.connect === "function" ? await pool.connect() : pool;

  if (!client || typeof client.query !== "function") {
    throw new TypeError("A database pool or client is required.");
  }

  try {
    await client.query("BEGIN");

    const current = await getOwnedEmergencyRequest({
      pool: client,
      homeownerUserId,
      emergencyRequestId,
      lock: true,
    });

    if (!current.ok) {
      await client.query("ROLLBACK");
      return current;
    }

    if (current.row.status === "cancelled") {
      await client.query("ROLLBACK");
      return {
        ok: true,
        status: 200,
        code: "EMERGENCY_REQUEST_ALREADY_CANCELLED",
        emergencyRequest: current.emergencyRequest,
      };
    }

    if (["assigned", "in_service", "resolved"].includes(current.row.status)) {
      await client.query("ROLLBACK");
      return {
        ok: false,
        status: 409,
        code: "EMERGENCY_REQUEST_NOT_CANCELLABLE",
        message: "This Emergency request can no longer be cancelled.",
      };
    }

    const result = await client.query(
      `
      UPDATE emergency_requests
      SET
        status = 'cancelled',
        cancelled_at = COALESCE(cancelled_at, CURRENT_TIMESTAMP),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *
      `,
      [current.row.id]
    );

    await client.query("COMMIT");

    return {
      ok: true,
      status: 200,
      code: "EMERGENCY_REQUEST_CANCELLED",
      emergencyRequest: serializeEmergencyRequest(
        result.rows[0],
        current.assessment
      ),
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    throw error;
  } finally {
    if (client !== pool && typeof client.release === "function") {
      client.release();
    }
  }
}

module.exports = {
  EMERGENCY_REQUEST_STATUSES,
  SAFETY_BOOLEAN_FIELDS,
  SAFETY_DISPOSITIONS,
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
};
