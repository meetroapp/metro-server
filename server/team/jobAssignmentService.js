"use strict";

const { createHash } = require("node:crypto");
const {
  createCanonicalLifecycleAlertWithClient,
  resolveCanonicalLifecycleAlertsWithClient,
} = require("../alerts/lifecycleAlertService");
const { permissionForRole } = require("./teamService");

const ASSIGNABLE_ROLES = Object.freeze(["MANAGER", "FIELD_EMPLOYEE"]);
const ASSIGNMENT_MANAGER_ROLES = Object.freeze(["OWNER", "MANAGER"]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function failure(status, code, message) {
  return { ok: false, status, code, message };
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function uuid(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return UUID_PATTERN.test(normalized) ? normalized : null;
}

function normalizeIdempotencyKey(value) {
  const normalized = String(value || "").trim();
  return normalized && normalized.length <= 200 && !/[\u0000-\u001f\u007f]/.test(normalized)
    ? normalized
    : null;
}

function normalizeMembershipIds(value) {
  if (!Array.isArray(value) || value.length > 50) return null;
  const normalized = value.map(uuid);
  if (normalized.some((item) => !item)) return null;
  return [...new Set(normalized)].sort();
}

function assignmentFingerprint({ businessId, jobId, membershipIds }) {
  return createHash("sha256")
    .update(JSON.stringify({ businessId, jobId, membershipIds: [...membershipIds].sort() }))
    .digest("hex");
}

function iso(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function serializeAssignment(row = {}) {
  return {
    id: row.id,
    businessId: Number(row.contractor_profile_id),
    jobId: row.job_id,
    membershipId: row.membership_id,
    memberUserId: Number(row.member_user_id || row.user_id),
    memberName: row.member_name || row.username || "",
    memberEmail: row.member_email || row.email || "",
    memberRole: row.member_role || row.role || null,
    memberStatus: row.member_status || row.membership_status || null,
    state: row.state,
    version: Number(row.version),
    ...(row.activation_version != null ? { activationVersion: Number(row.activation_version) } : {}),
    assignedAt: iso(row.initial_assigned_at),
    changedAt: iso(row.last_state_changed_at),
  };
}

function serializeEvent(row = {}) {
  return {
    id: row.id,
    assignmentId: row.assignment_id,
    jobId: row.job_id,
    membershipId: row.membership_id,
    assignmentVersion: Number(row.assignment_version),
    type: row.event_type,
    occurredAt: iso(row.occurred_at),
  };
}

function safePhotos(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).flatMap((photo, index) => {
    if (!photo || typeof photo !== "object" || Array.isArray(photo)) return [];
    const url = typeof photo.secure_url === "string"
      ? photo.secure_url
      : typeof photo.media?.secure_url === "string"
        ? photo.media.secure_url
        : "";
    if (!url) return [];
    return [{
      publicId: typeof photo.public_id === "string"
        ? photo.public_id
        : typeof photo.media?.public_id === "string"
          ? photo.media.public_id
          : null,
      url,
      order: Number.isInteger(photo.display_order) ? photo.display_order : index,
    }];
  }).sort((left, right) => left.order - right.order);
}

function serviceLocation(row = {}) {
  if (["business_customer", "emergency_request"].includes(row.job_source_type) &&
      row.location_normalization_status !== "normalized") {
    return { serviceArea: row.discovery_area_label || null, address: null };
  }
  const normalized = row.location_normalization_status === "normalized";
  const exact = normalized && row.location_intake_mode === "exact_on_file";
  return {
    serviceArea: normalized ? row.discovery_area_label || null : null,
    address: exact ? {
      line1: row.service_address_line1 || null,
      city: row.service_city || null,
      region: row.service_region || null,
      postalCode: row.service_postal_code || null,
      countryCode: row.service_country_code || null,
    } : null,
  };
}

async function databaseClient(pool) {
  return typeof pool.connect === "function" ? pool.connect() : pool;
}

async function withTransaction(pool, action) {
  const client = await databaseClient(pool);
  let started = false;
  try {
    await client.query("BEGIN");
    started = true;
    const result = await action(client);
    if (result?.ok === false) {
      await client.query("ROLLBACK");
      started = false;
      return result;
    }
    await client.query("COMMIT");
    started = false;
    return result;
  } catch (error) {
    if (started) await client.query("ROLLBACK");
    throw error;
  } finally {
    if (client !== pool && typeof client.release === "function") client.release();
  }
}

async function withReadTransaction(pool, action) {
  const client = await databaseClient(pool);
  let started = false;
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    started = true;
    const result = await action(client);
    await client.query("COMMIT");
    started = false;
    return result;
  } catch (error) {
    if (started) await client.query("ROLLBACK");
    throw error;
  } finally {
    if (client !== pool && typeof client.release === "function") client.release();
  }
}

async function loadActorMembership(database, actorUserId, businessId) {
  const result = await database.query(
    `SELECT memberships.*, profiles.business_name, profiles.time_zone
       FROM business_team_memberships memberships
       JOIN contractor_profiles profiles
         ON profiles.id = memberships.contractor_profile_id
      WHERE memberships.user_id = $1
        AND memberships.contractor_profile_id = $2
        AND memberships.status = 'ACTIVE'
      LIMIT 1`,
    [actorUserId, businessId]
  );
  return result.rows[0] || null;
}

async function loadBusinessJob(database, businessId, jobId, { lock = false } = {}) {
  const result = await database.query(
    `SELECT source.*
       FROM contractor_profiles profiles
       JOIN LATERAL business_employee_job_sources(profiles.id, $2::uuid) source ON TRUE
       JOIN jobs ON jobs.id = source.job_id
      WHERE profiles.id = $1
      ${lock ? "FOR UPDATE OF jobs" : ""}`,
    [businessId, jobId]
  );
  return result.rows.length === 1 ? result.rows[0] : null;
}

async function loadJobRows(database, businessId, membershipId = null) {
  const result = await database.query(
    `SELECT source.* FROM contractor_profiles profiles
       JOIN LATERAL business_employee_job_sources(profiles.id) source ON TRUE
      WHERE profiles.id = $1
        AND ($2::uuid IS NULL OR EXISTS (
          SELECT 1 FROM business_job_assignments assignments
           WHERE assignments.contractor_profile_id = profiles.id
             AND assignments.job_id = source.job_id
             AND assignments.membership_id = $2
             AND assignments.state = 'ACTIVE'
        ))
      ORDER BY source.job_created_at DESC, source.job_id ASC
      LIMIT 100`,
    [businessId, membershipId]
  );
  return result.rows;
}

async function loadAssignments(database, businessId, jobIds) {
  if (jobIds.length === 0) return [];
  const result = await database.query(
    `SELECT assignments.*, (SELECT max(e.assignment_version) FROM business_job_assignment_events e
              WHERE e.assignment_id=assignments.id AND e.event_type IN ('ASSIGNED','REASSIGNED')) AS activation_version,
            memberships.user_id AS member_user_id,
            memberships.role AS member_role,
            memberships.status AS member_status,
            users.username AS member_name, users.email AS member_email
       FROM business_job_assignments assignments
       JOIN business_team_memberships memberships
         ON memberships.id = assignments.membership_id
        AND memberships.contractor_profile_id = assignments.contractor_profile_id
       JOIN users ON users.id = memberships.user_id
      WHERE assignments.contractor_profile_id = $1
        AND assignments.job_id = ANY($2::uuid[])
      ORDER BY assignments.created_at ASC, assignments.id ASC`,
    [businessId, jobIds]
  );
  return result.rows;
}

async function loadApprovedScope(database, jobIds) {
  if (jobIds.length === 0) return [];
  const result = await database.query(
    `SELECT decisions.job_id, decisions.quote_id,
            decisions.issued_quote_version AS quote_version,
            decisions.decided_at,
            snapshots.scope_item_id, snapshots.sequence,
            snapshots.description, snapshots.quantity,
            snapshots.classification
       FROM canonical_quote_customer_decisions decisions
       JOIN canonical_quote_scope_item_snapshots snapshots
         ON snapshots.quote_id = decisions.quote_id
        AND snapshots.quote_version = decisions.issued_quote_version
        AND snapshots.job_id = decisions.job_id
      WHERE decisions.job_id = ANY($1::uuid[])
        AND decisions.decision = 'APPROVED'
        AND snapshots.included_in_total = TRUE
      ORDER BY decisions.job_id, snapshots.sequence, snapshots.scope_item_id`,
    [jobIds]
  );
  return result.rows;
}

function projectJobs(rows, assignmentRows, scopeRows, { employeeMembershipId = null } = {}) {
  const assignmentsByJob = new Map();
  for (const row of assignmentRows) {
    const list = assignmentsByJob.get(row.job_id) || [];
    list.push(serializeAssignment(row));
    assignmentsByJob.set(row.job_id, list);
  }
  const scopeByJob = new Map();
  const documentsByJob = new Map();
  for (const row of scopeRows) {
    const list = scopeByJob.get(row.job_id) || [];
    list.push({
      id: row.scope_item_id,
      sequence: Number(row.sequence),
      description: row.description,
      quantity: Number(row.quantity),
      classification: row.classification,
    });
    scopeByJob.set(row.job_id, list);
    const documents = documentsByJob.get(row.job_id) || [];
    if (!documents.some((document) => document.id === row.quote_id)) {
      documents.push({
        type: "APPROVED_QUOTE",
        id: row.quote_id,
        version: Number(row.quote_version),
        status: "APPROVED",
        approvedAt: iso(row.decided_at),
      });
      documentsByJob.set(row.job_id, documents);
    }
  }
  return rows.map((row) => {
    const assignments = assignmentsByJob.get(row.job_id) || [];
    return {
      id: row.job_id,
      sourceType: row.job_source_type,
      source: { type: row.job_source_type, id: row.source_id,
        version: row.source_version == null ? null : Number(row.source_version) },
      title: row.job_title || "Job",
      category: row.job_category || null,
      instructions: row.job_description || "",
      customer: { displayName: row.customer_name || "Customer" },
      location: serviceLocation(row),
      photos: safePhotos(row.request_photos),
      approvedScope: scopeByJob.get(row.job_id) || [],
      documents: documentsByJob.get(row.job_id) || [],
      assignments: employeeMembershipId
        ? assignments.filter((assignment) => assignment.membershipId === employeeMembershipId)
        : assignments,
      createdAt: iso(row.job_created_at),
    };
  });
}

async function listManagedJobs({ pool, authenticatedActor, businessId }) {
  const actorId = positiveInteger(authenticatedActor?.id);
  const normalizedBusinessId = positiveInteger(businessId);
  if (!pool || !actorId) return failure(401, "AUTHENTICATION_REQUIRED", "Authentication required.");
  if (!normalizedBusinessId) return failure(400, "TEAM_BUSINESS_INVALID", "Business Team identity is invalid.");
  return withReadTransaction(pool, async (client) => {
    const actor = await loadActorMembership(client, actorId, normalizedBusinessId);
    if (!actor || !permissionForRole(actor.role, "JOB_ASSIGNMENT_VIEW")) {
      return failure(403, "JOB_ASSIGNMENT_PERMISSION_REQUIRED", "Only an Owner or Manager can view business Job assignments.");
    }
    const rows = await loadJobRows(client, normalizedBusinessId);
    const jobIds = rows.map((row) => row.job_id);
    const [assignments, scope] = await Promise.all([
      loadAssignments(client, normalizedBusinessId, jobIds),
      loadApprovedScope(client, jobIds),
    ]);
    return {
      ok: true,
      status: 200,
      code: "BUSINESS_JOB_ASSIGNMENTS_LOADED",
      business: { id: normalizedBusinessId, name: actor.business_name || "" },
      actorRole: actor.role,
      jobs: projectJobs(rows, assignments, scope),
    };
  });
}

async function listEmployeeJobs({ pool, authenticatedActor, businessId }) {
  const actorId = positiveInteger(authenticatedActor?.id);
  const normalizedBusinessId = positiveInteger(businessId);
  if (!pool || !actorId) return failure(401, "AUTHENTICATION_REQUIRED", "Authentication required.");
  if (!normalizedBusinessId) return failure(400, "TEAM_BUSINESS_INVALID", "Business Team identity is invalid.");
  return withReadTransaction(pool, async (client) => {
    const actor = await loadActorMembership(client, actorId, normalizedBusinessId);
    if (!actor || !permissionForRole(actor.role, "ASSIGNED_WORK")) {
      return failure(403, "ASSIGNED_WORK_PERMISSION_REQUIRED", "This Team role cannot access field work.");
    }
    const rows = await loadJobRows(client, normalizedBusinessId, actor.id);
    const jobIds = rows.map((row) => row.job_id);
    const [assignments, scope] = await Promise.all([
      loadAssignments(client, normalizedBusinessId, jobIds),
      loadApprovedScope(client, jobIds),
    ]);
    return {
      ok: true,
      status: 200,
      code: "EMPLOYEE_ASSIGNED_JOBS_LOADED",
      business: { id: normalizedBusinessId, name: actor.business_name || "" },
      membershipId: actor.id,
      jobs: projectJobs(rows, assignments, scope, { employeeMembershipId: actor.id }),
    };
  });
}

async function listEmployeeSchedule({ pool, authenticatedActor, businessId }) {
  const actorId = positiveInteger(authenticatedActor?.id);
  const normalizedBusinessId = positiveInteger(businessId);
  if (!pool || !actorId) return failure(401, "AUTHENTICATION_REQUIRED", "Authentication required.");
  if (!normalizedBusinessId) return failure(400, "TEAM_BUSINESS_INVALID", "Business Team identity is invalid.");
  return withReadTransaction(pool, async (client) => {
    const actor = await loadActorMembership(client, actorId, normalizedBusinessId);
    if (!actor || !permissionForRole(actor.role, "EMPLOYEE_SCHEDULE")) {
      return failure(403, "ASSIGNED_WORK_PERMISSION_REQUIRED", "This Team role cannot access the employee Schedule.");
    }
    const result = await client.query(
      `SELECT visits.id AS visit_id, visits.job_id, visits.purpose,
              versions.version, versions.state,
              versions.scheduled_start_at, versions.scheduled_end_at,
              versions.time_zone, versions.location_mode, source.*
         FROM business_job_assignments assignments
         JOIN LATERAL business_employee_job_sources(assignments.contractor_profile_id,
           assignments.job_id) source ON TRUE
         JOIN canonical_visits visits ON visits.job_id = assignments.job_id
         JOIN LATERAL (
           SELECT versions.* FROM canonical_visit_versions versions
            WHERE versions.visit_id = visits.id AND versions.job_id = visits.job_id
            ORDER BY versions.version DESC LIMIT 1
         ) versions ON TRUE
        WHERE assignments.contractor_profile_id = $1
          AND assignments.membership_id = $2
          AND assignments.state = 'ACTIVE'
          AND versions.state IN ('PROPOSED', 'SCHEDULED', 'STARTED')
        ORDER BY versions.scheduled_start_at ASC, visits.id ASC
        LIMIT 100`,
      [normalizedBusinessId, actor.id]
    );
    return {
      ok: true,
      status: 200,
      code: "EMPLOYEE_ASSIGNED_SCHEDULE_LOADED",
      business: { id: normalizedBusinessId, name: actor.business_name || "" },
      membershipId: actor.id,
      timeZone: actor.time_zone || null,
      schedule: result.rows.map((row) => ({
        visitId: row.visit_id,
        jobId: row.job_id,
        jobTitle: row.job_title || "Job",
        sourceType: row.job_source_type,
        source: { type: row.job_source_type, id: row.source_id,
          version: row.source_version == null ? null : Number(row.source_version) },
        purpose: row.purpose,
        state: row.state,
        version: Number(row.version),
        startsAt: iso(row.scheduled_start_at),
        endsAt: iso(row.scheduled_end_at),
        timeZone: row.time_zone,
        location: row.location_mode === "REMOTE"
          ? { serviceArea: null, address: null, remote: true }
          : { ...serviceLocation(row), remote: false },
      })),
    };
  });
}

async function emitAssignmentAlert(client, event, assignment, jobTitle) {
  const eventName = event.event_type.toLowerCase();
  const sourceEventType = `job.assignment.${eventName}`;
  if (event.event_type === "UNASSIGNED") {
    await resolveCanonicalLifecycleAlertsWithClient({
      client,
      sourceDomain: "business",
      sourceEntityType: "business_job_assignment",
      sourceEntityId: assignment.id,
      sourceEventTypes: [
        "job.assignment.assigned",
        "job.assignment.changed",
        "job.assignment.reassigned",
      ],
      recipientUserId: assignment.member_user_id,
    });
  } else {
    await resolveCanonicalLifecycleAlertsWithClient({
      client,
      sourceDomain: "business",
      sourceEntityType: "business_job_assignment",
      sourceEntityId: assignment.id,
      sourceEventTypes: ["job.assignment.unassigned"],
      recipientUserId: assignment.member_user_id,
    });
  }
  const copyName = event.event_type === "ASSIGNED"
    ? "jobAssigned"
    : event.event_type === "CHANGED"
      ? "jobAssignmentChanged"
    : event.event_type === "REASSIGNED"
      ? "jobReassigned"
      : "jobUnassigned";
  await createCanonicalLifecycleAlertWithClient({
    client,
    recipientUserId: assignment.member_user_id,
    sourceDomain: "business",
    sourceEventType,
    sourceEntityType: "business_job_assignment",
    sourceEntityId: assignment.id,
    sourceEventId: event.id,
    category: "work",
    titleKey: `alerts.work.${copyName}.title`,
    messageKey: `alerts.work.${copyName}.message`,
    safePayload: {
      jobTitle: String(jobTitle || "Job").slice(0, 160),
      shortPreview: String(jobTitle || "Job").slice(0, 160),
    },
    destination: event.event_type === "UNASSIGNED"
      ? { type: "notifications", payload: {} }
      : { type: "job", payload: { jobId: assignment.job_id } },
  });
}

async function setJobAssignments({
  pool,
  authenticatedActor,
  businessId,
  jobId,
  membershipIds,
  idempotencyKey,
}) {
  const actorId = positiveInteger(authenticatedActor?.id);
  const normalizedBusinessId = positiveInteger(businessId);
  const normalizedJobId = uuid(jobId);
  const normalizedMembershipIds = normalizeMembershipIds(membershipIds);
  const normalizedIdempotencyKey = normalizeIdempotencyKey(idempotencyKey);
  if (!pool || !actorId) return failure(401, "AUTHENTICATION_REQUIRED", "Authentication required.");
  if (!normalizedBusinessId || !normalizedJobId || !normalizedMembershipIds || !normalizedIdempotencyKey) {
    return failure(400, "JOB_ASSIGNMENT_COMMAND_INVALID", "Exact business, Job, Team members, and idempotency identity are required.");
  }
  const fingerprint = assignmentFingerprint({
    businessId: normalizedBusinessId,
    jobId: normalizedJobId,
    membershipIds: normalizedMembershipIds,
  });
  return withTransaction(pool, async (client) => {
    const actor = await loadActorMembership(client, actorId, normalizedBusinessId);
    if (!actor || !permissionForRole(actor.role, "JOB_ASSIGNMENT_MANAGE")) {
      return failure(403, "JOB_ASSIGNMENT_PERMISSION_REQUIRED", "Only an Owner or Manager can change Job assignments.");
    }
    const job = await loadBusinessJob(client, normalizedBusinessId, normalizedJobId, { lock: true });
    if (!job) return failure(404, "BUSINESS_JOB_NOT_FOUND", "Job not found for this exact business.");

    const commandInsert = await client.query(
      `INSERT INTO business_job_assignment_commands
         (contractor_profile_id, job_id, actor_membership_id,
          idempotency_key, request_fingerprint)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (actor_membership_id, job_id, idempotency_key) DO NOTHING
       RETURNING *`,
      [normalizedBusinessId, normalizedJobId, actor.id,
        normalizedIdempotencyKey, fingerprint]
    );
    let command = commandInsert.rows[0];
    if (!command) {
      const replay = await client.query(
        `SELECT * FROM business_job_assignment_commands
          WHERE actor_membership_id = $1 AND job_id = $2 AND idempotency_key = $3
          FOR UPDATE`,
        [actor.id, normalizedJobId, normalizedIdempotencyKey]
      );
      command = replay.rows[0];
      if (!command || command.request_fingerprint !== fingerprint) {
        return failure(409, "JOB_ASSIGNMENT_IDEMPOTENCY_CONFLICT", "This idempotency key belongs to a different assignment command.");
      }
      if (!command.completed_at || !command.result_reference) {
        return failure(409, "JOB_ASSIGNMENT_COMMAND_IN_PROGRESS", "This assignment command is still in progress.");
      }
      return {
        ok: true,
        status: 200,
        code: "BUSINESS_JOB_ASSIGNMENTS_REPLAYED",
        replayed: true,
        ...command.result_reference,
      };
    }

    if (normalizedMembershipIds.length > 0) {
      const targets = await client.query(
        `SELECT memberships.id
           FROM business_team_memberships memberships
          WHERE memberships.contractor_profile_id = $1
            AND memberships.id = ANY($2::uuid[])
            AND memberships.status = 'ACTIVE'
            AND memberships.role IN ('MANAGER', 'FIELD_EMPLOYEE')
          ORDER BY memberships.id
          FOR UPDATE`,
        [normalizedBusinessId, normalizedMembershipIds]
      );
      if (targets.rows.length !== normalizedMembershipIds.length) {
        return failure(400, "JOB_ASSIGNMENT_TARGET_INVALID", "Every assignment target must be an active field-authorized member of this exact business.");
      }
    }

    const current = await client.query(
      `SELECT assignments.*, (SELECT max(e.assignment_version) FROM business_job_assignment_events e
              WHERE e.assignment_id=assignments.id AND e.event_type IN ('ASSIGNED','REASSIGNED')) AS activation_version,
            memberships.user_id AS member_user_id,
              memberships.role AS member_role,
              memberships.status AS member_status,
              users.username AS member_name, users.email AS member_email
         FROM business_job_assignments assignments
         JOIN business_team_memberships memberships
           ON memberships.id = assignments.membership_id
         JOIN users ON users.id = memberships.user_id
        WHERE assignments.contractor_profile_id = $1
          AND assignments.job_id = $2
        ORDER BY assignments.created_at, assignments.id
        FOR UPDATE OF assignments`,
      [normalizedBusinessId, normalizedJobId]
    );
    const existingByMember = new Map(current.rows.map((row) => [row.membership_id, row]));
    const targetSet = new Set(normalizedMembershipIds);
    const activeCurrentIds = current.rows
      .filter((row) => row.state === "ACTIVE")
      .map((row) => row.membership_id)
      .sort();
    const assignmentSetChanged =
      JSON.stringify(activeCurrentIds) !== JSON.stringify(normalizedMembershipIds);
    const createdEvents = [];

    for (const row of current.rows) {
      if (row.state === "ACTIVE" && !targetSet.has(row.membership_id)) {
        const updated = await client.query(
          `UPDATE business_job_assignments
              SET state = 'UNASSIGNED', version = version + 1
            WHERE id = $1 AND version = $2
            RETURNING *`,
          [row.id, row.version]
        );
        const assignment = { ...row, ...updated.rows[0] };
        const eventResult = await client.query(
          `INSERT INTO business_job_assignment_events
             (assignment_id, contractor_profile_id, job_id, membership_id,
              assignment_version, event_type, actor_membership_id, command_id)
           VALUES ($1, $2, $3, $4, $5, 'UNASSIGNED', $6, $7)
           RETURNING *`,
          [assignment.id, normalizedBusinessId, normalizedJobId,
            assignment.membership_id, assignment.version, actor.id, command.id]
        );
        createdEvents.push({ event: eventResult.rows[0], assignment });
      }
    }

    for (const membershipId of normalizedMembershipIds) {
      const existing = existingByMember.get(membershipId);
      if (existing?.state === "ACTIVE") continue;
      let assignment;
      let eventType;
      if (existing) {
        const updated = await client.query(
          `UPDATE business_job_assignments
              SET state = 'ACTIVE', version = version + 1
            WHERE id = $1 AND version = $2
            RETURNING *`,
          [existing.id, existing.version]
        );
        assignment = { ...existing, ...updated.rows[0] };
        eventType = "REASSIGNED";
      } else {
        const inserted = await client.query(
          `INSERT INTO business_job_assignments
             (contractor_profile_id, job_id, membership_id,
              assigned_by_membership_id, initial_command_id)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING *`,
          [normalizedBusinessId, normalizedJobId, membershipId, actor.id, command.id]
        );
        const identity = await client.query(
          `SELECT memberships.user_id AS member_user_id,
                  memberships.role AS member_role,
                  memberships.status AS member_status,
                  users.username AS member_name, users.email AS member_email
             FROM business_team_memberships memberships
             JOIN users ON users.id = memberships.user_id
            WHERE memberships.id = $1`,
          [membershipId]
        );
        assignment = { ...inserted.rows[0], ...identity.rows[0] };
        eventType = "ASSIGNED";
      }
      const eventResult = await client.query(
        `INSERT INTO business_job_assignment_events
           (assignment_id, contractor_profile_id, job_id, membership_id,
            assignment_version, event_type, actor_membership_id, command_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [assignment.id, normalizedBusinessId, normalizedJobId, membershipId,
          assignment.version, eventType, actor.id, command.id]
      );
      createdEvents.push({ event: eventResult.rows[0], assignment });
    }

    if (assignmentSetChanged) {
      for (const row of current.rows) {
        if (row.state !== "ACTIVE" || !targetSet.has(row.membership_id)) continue;
        const updated = await client.query(
          `UPDATE business_job_assignments
              SET state = 'ACTIVE', version = version + 1
            WHERE id = $1 AND version = $2
            RETURNING *`,
          [row.id, row.version]
        );
        const assignment = { ...row, ...updated.rows[0] };
        const eventResult = await client.query(
          `INSERT INTO business_job_assignment_events
             (assignment_id, contractor_profile_id, job_id, membership_id,
              assignment_version, event_type, actor_membership_id, command_id)
           VALUES ($1, $2, $3, $4, $5, 'CHANGED', $6, $7)
           RETURNING *`,
          [assignment.id, normalizedBusinessId, normalizedJobId,
            assignment.membership_id, assignment.version, actor.id, command.id]
        );
        createdEvents.push({ event: eventResult.rows[0], assignment });
      }
    }

    for (const item of createdEvents) {
      await emitAssignmentAlert(client, item.event, item.assignment, job.job_title);
    }

    const finalRows = await loadAssignments(client, normalizedBusinessId, [normalizedJobId]);
    const resultReference = {
      businessId: normalizedBusinessId,
      jobId: normalizedJobId,
      assignments: finalRows.map(serializeAssignment),
      events: createdEvents.map(({ event }) => serializeEvent(event)),
    };
    await client.query(
      `UPDATE business_job_assignment_commands
          SET result_reference = $2::jsonb, completed_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND completed_at IS NULL`,
      [command.id, JSON.stringify(resultReference)]
    );
    return {
      ok: true,
      status: 200,
      code: "BUSINESS_JOB_ASSIGNMENTS_UPDATED",
      replayed: false,
      ...resultReference,
    };
  });
}

module.exports = {
  ASSIGNABLE_ROLES,
  ASSIGNMENT_MANAGER_ROLES,
  assignmentFingerprint,
  listEmployeeJobs,
  listEmployeeSchedule,
  listManagedJobs,
  normalizeIdempotencyKey,
  normalizeMembershipIds,
  projectJobs,
  safePhotos,
  serializeAssignment,
  serviceLocation,
  setJobAssignments,
  uuid,
};
