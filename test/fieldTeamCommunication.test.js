"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  acknowledgeFieldMessageAttention,
  fingerprint,
  listManagedFieldCommunications,
  resolveFieldTeamAlertDestination,
  sendFieldMessage,
} = require("../server/team/fieldOperationsService");

const JOB_ID = "072c8736-5d97-4253-ba3e-dd1bce281a20";
const ASSIGNMENT_ID = "a7c9a660-c087-4af1-b139-8d77f8d69b33";
const MEMBERSHIP_ID = "b7c9a660-c087-4af1-b139-8d77f8d69b33";
const OWNER_MEMBERSHIP_ID = "c7c9a660-c087-4af1-b139-8d77f8d69b33";
const MESSAGE_ID = "d7c9a660-c087-4af1-b139-8d77f8d69b33";

function normalizeSql(value) {
  return String(value).replace(/\s+/g, " ").trim();
}

function actor(role = "OWNER", overrides = {}) {
  return {
    id: role === "FIELD_EMPLOYEE" ? MEMBERSHIP_ID : OWNER_MEMBERSHIP_ID,
    user_id: role === "FIELD_EMPLOYEE" ? 14 : 9,
    contractor_profile_id: 7,
    username: role === "FIELD_EMPLOYEE" ? "Liam Field" : "Business Owner",
    role,
    status: "ACTIVE",
    ...overrides,
  };
}

function assignment(overrides = {}) {
  return {
    id: ASSIGNMENT_ID,
    contractor_profile_id: 7,
    job_id: JOB_ID,
    membership_id: MEMBERSHIP_ID,
    state: "ACTIVE",
    member_user_id: 14,
    member_role: "FIELD_EMPLOYEE",
    member_status: "ACTIVE",
    member_name: "Liam Field",
    job_title: "Kitchen repair",
    ...overrides,
  };
}

function messageRow(overrides = {}) {
  return {
    id: MESSAGE_ID,
    assignment_id: ASSIGNMENT_ID,
    sender_membership_id: OWNER_MEMBERSHIP_ID,
    sender_user_id: 9,
    sender_name: "Business Owner",
    sender_role: "OWNER",
    message_text: "Please check the side entrance.",
    created_at: "2026-08-31T14:00:00.000Z",
    request_fingerprint: "",
    ...overrides,
  };
}

function alertRow(recipientUserId, params) {
  return {
    id: 801,
    recipient_user_id: recipientUserId,
    source_domain: params[1],
    source_event_type: params[2],
    source_entity_type: params[3],
    source_entity_id: params[4],
    source_event_id: params[5],
    canonical_event_key: params[6],
    category: params[7],
    priority: params[8],
    title_key: params[9],
    message_key: params[10],
    safe_payload: JSON.parse(params[11]),
    destination_type: params[12],
    destination_payload: JSON.parse(params[13]),
    dedupe_key: params[14],
    lifecycle_state: "active",
    available_at: "2026-08-31T14:00:00.000Z",
    expires_at: null,
    read_at: null,
    dismissed_at: null,
    resolved_at: null,
    archived_at: null,
    created_at: "2026-08-31T14:00:00.000Z",
    updated_at: "2026-08-31T14:00:00.000Z",
  };
}

function createPool({
  actorRow = actor(),
  managedAssignments = [assignment()],
  teamAlertRows = [{ job_id: JOB_ID }],
  assignmentRow = assignment(),
  ownerRecipients = [{ user_id: 9 }, { user_id: 10 }],
  existingMessageRow = null,
  acknowledgedRows = [{ id: 801 }],
} = {}) {
  const calls = [];
  let insertedMessage = null;
  const client = {
    async query(text, params = []) {
      const sql = normalizeSql(text);
      calls.push({ sql, params });
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [] };
      if (sql.includes("FROM business_team_memberships memberships") && sql.includes("memberships.user_id = $1")) {
        return { rows: actorRow?.status === "ACTIVE" ? [actorRow] : [] };
      }
      if (sql.includes("field_operations:managed_communication_assignments")) {
        return { rows: managedAssignments };
      }
      if (sql.includes("field_operations:team_alert_destination")) {
        return { rows: teamAlertRows };
      }
      if (sql.includes("FROM business_job_assignment_events")) {
        return { rows: [{ assignment_version: 4 }] };
      }
      if (sql.includes("field_operations:acknowledge_message_attention")) {
        return { rows: acknowledgedRows };
      }
      if (sql.includes("FROM business_job_field_status_events")) {
        return { rows: [] };
      }
      if (sql.includes("FROM business_job_field_messages messages") && sql.includes("ORDER BY messages.created_at ASC")) {
        return { rows: [messageRow()] };
      }
      if (sql.includes("FROM business_job_assignments assignments") && sql.includes("assignments.id = $1")) {
        return { rows: assignmentRow ? [assignmentRow] : [] };
      }
      if (sql.includes("WHERE messages.sender_membership_id = $1")) {
        return { rows: existingMessageRow ? [existingMessageRow] : [] };
      }
      if (sql.includes("INSERT INTO business_job_field_messages")) {
        insertedMessage = messageRow({
          sender_membership_id: params[4],
          sender_user_id: params[5],
          message_text: params[6],
          request_fingerprint: params[8],
        });
        return { rows: [insertedMessage] };
      }
      if (sql.startsWith("SELECT user_id FROM business_team_memberships")) {
        return { rows: ownerRecipients };
      }
      if (sql.includes("INSERT INTO alerts")) {
        return { rows: [alertRow(params[0], params)], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    release() {},
  };
  return {
    calls,
    get insertedMessage() { return insertedMessage; },
    pool: { async connect() { return client; } },
  };
}

test("exact authorized Team load can acknowledge only its assignment attention", async () => {
  const fixture = createPool();
  const response = await acknowledgeFieldMessageAttention({
    pool: fixture.pool,
    authenticatedActor: { id: 9 },
    businessId: 7,
    jobId: JOB_ID,
    assignmentId: ASSIGNMENT_ID,
  });
  assert.equal(response.code, "FIELD_MESSAGE_ATTENTION_ACKNOWLEDGED");
  assert.equal(response.acknowledgedCount, 1);
  const update = fixture.calls.find(({ sql }) =>
    sql.includes("field_operations:acknowledge_message_attention")
  );
  assert.deepEqual(update.params.slice(0, 5), [9, 7, JOB_ID, ASSIGNMENT_ID, MEMBERSHIP_ID]);
  assert.match(update.sql, /alerts\.recipient_user_id = \$1/);
  assert.match(update.sql, /messages\.assignment_id = \$4/);

  const stale = createPool({ assignmentRow: null });
  const denied = await acknowledgeFieldMessageAttention({
    pool: stale.pool,
    authenticatedActor: { id: 9 },
    businessId: 7,
    jobId: JOB_ID,
    assignmentId: ASSIGNMENT_ID,
  });
  assert.equal(denied.code, "FIELD_ASSIGNMENT_NOT_FOUND");
  assert.equal(stale.calls.some(({ sql }) => sql.includes("acknowledge_message_attention")), false);
});

test("Owner and Manager load only current exact-assignment private Team history", async () => {
  for (const role of ["OWNER", "MANAGER"]) {
    const fixture = createPool({ actorRow: actor(role) });
    const response = await listManagedFieldCommunications({
      pool: fixture.pool,
      authenticatedActor: { id: role === "OWNER" ? 9 : 11 },
      businessId: 7,
      jobId: JOB_ID,
    });
    assert.equal(response.ok, true);
    assert.equal(response.communications.length, 1);
    assert.equal(response.communications[0].assignmentId, ASSIGNMENT_ID);
    assert.equal(response.communications[0].messages[0].message, "Please check the side entrance.");
    assert.equal(response.communications[0].messages[0].senderRole, "OWNER");
  }
});

test("Bookkeeper fails before assignments or private Team history are read", async () => {
  const fixture = createPool({ actorRow: actor("BOOKKEEPER_FINANCE") });
  const response = await listManagedFieldCommunications({
    pool: fixture.pool,
    authenticatedActor: { id: 12 },
    businessId: 7,
    jobId: JOB_ID,
  });
  assert.equal(response.code, "FIELD_COMMUNICATION_PERMISSION_REQUIRED");
  assert.equal(fixture.calls.some(({ sql }) => sql.includes("managed_communication_assignments")), false);
  assert.equal(fixture.calls.some(({ sql }) => sql.includes("business_job_field_messages messages")), false);
});

test("managed Team projection excludes inactive assignments and never substitutes another Job", async () => {
  const fixture = createPool({ managedAssignments: [] });
  const response = await listManagedFieldCommunications({
    pool: fixture.pool,
    authenticatedActor: { id: 9 },
    businessId: 7,
    jobId: JOB_ID,
  });
  assert.deepEqual(response.communications, []);
  const query = fixture.calls.find(({ sql }) => sql.includes("managed_communication_assignments"));
  assert.deepEqual(query.params, [7, JOB_ID]);
  assert.match(query.sql, /assignments\.state = 'ACTIVE'/);
  assert.match(query.sql, /memberships\.role = 'FIELD_EMPLOYEE'/);
  assert.match(query.sql, /jobs\.lifecycle_contract_version = 2/);
});

test("unrelated business inactive membership and unrelated Job fail before Team evidence is exposed", async () => {
  for (const actorRow of [null, actor("OWNER", { status: "INACTIVE" })]) {
    const fixture = createPool({ actorRow });
    const denied = await listManagedFieldCommunications({
      pool: fixture.pool,
      authenticatedActor: { id: 99 },
      businessId: 7,
      jobId: JOB_ID,
    });
    assert.equal(denied.code, "FIELD_COMMUNICATION_PERMISSION_REQUIRED");
    assert.equal(fixture.calls.some(({ sql }) => sql.includes("business_job_field_messages messages")), false);
  }

  const unrelatedJob = createPool({ assignmentRow: null });
  const denied = await sendFieldMessage({
    pool: unrelatedJob.pool,
    authenticatedActor: { id: 9 },
    businessId: 7,
    jobId: JOB_ID,
    assignmentId: ASSIGNMENT_ID,
    message: "Wrong Job must fail.",
    idempotencyKey: "wrong-job-1",
  });
  assert.equal(denied.code, "FIELD_ASSIGNMENT_NOT_FOUND");
  assert.equal(unrelatedJob.calls.some(({ sql }) => sql.includes("INSERT INTO business_job_field_messages")), false);
});

test("business Team send writes the existing private field table and alerts only the exact employee", async () => {
  const fixture = createPool();
  const response = await sendFieldMessage({
    pool: fixture.pool,
    authenticatedActor: { id: 9, username: "Business Owner" },
    businessId: 7,
    jobId: JOB_ID,
    assignmentId: ASSIGNMENT_ID,
    message: "Please check the side entrance.",
    idempotencyKey: "business-team-1",
  });
  assert.equal(response.code, "FIELD_MESSAGE_SENT");
  assert.equal(fixture.insertedMessage.message_text, "Please check the side entrance.");
  const insert = fixture.calls.find(({ sql }) => sql.includes("INSERT INTO business_job_field_messages"));
  assert.deepEqual(insert.params.slice(0, 7), [ASSIGNMENT_ID, 7, JOB_ID, MEMBERSHIP_ID, OWNER_MEMBERSHIP_ID, 9, "Please check the side entrance."]);
  const alertInsert = fixture.calls.find(({ sql }) => sql.includes("INSERT INTO alerts"));
  assert.equal(alertInsert.params[0], 14);
  assert.equal(alertInsert.params[1], "business");
  assert.equal(alertInsert.params[2], "job.field_message.received");
  assert.equal(alertInsert.params[3], "business_job_field_message");
  assert.equal(alertInsert.params[7], "work");
  assert.equal(alertInsert.params[12], "job");
  assert.deepEqual(JSON.parse(alertInsert.params[13]), { jobId: JOB_ID });
  assert.equal(fixture.calls.some(({ sql }) => /\bconversations\b|conversation_participants/.test(sql)), false);
});

test("Field employee reply alerts active Owner and Manager without customer recipients", async () => {
  const fixture = createPool({
    actorRow: actor("FIELD_EMPLOYEE"),
    ownerRecipients: [{ user_id: 9 }, { user_id: 10 }, { user_id: 14 }],
  });
  const response = await sendFieldMessage({
    pool: fixture.pool,
    authenticatedActor: { id: 14, username: "Liam Field" },
    businessId: 7,
    jobId: JOB_ID,
    assignmentId: ASSIGNMENT_ID,
    message: "Side entrance confirmed.",
    idempotencyKey: "field-team-1",
  });
  assert.equal(response.ok, true);
  const recipients = fixture.calls
    .filter(({ sql }) => sql.includes("INSERT INTO alerts"))
    .map(({ params }) => params[0]);
  assert.deepEqual(recipients, [9, 10]);
  assert.equal(recipients.includes(14), false);
});

test("replayed Team send is idempotent and creates neither a second message nor a duplicate Alert", async () => {
  const requestFingerprint = fingerprint({
    businessId: 7,
    jobId: JOB_ID,
    assignmentId: ASSIGNMENT_ID,
    message: "Please check the side entrance.",
  });
  const fixture = createPool({
    existingMessageRow: messageRow({ request_fingerprint: requestFingerprint }),
  });
  const response = await sendFieldMessage({
    pool: fixture.pool,
    authenticatedActor: { id: 9, username: "Business Owner" },
    businessId: 7,
    jobId: JOB_ID,
    assignmentId: ASSIGNMENT_ID,
    message: "Please check the side entrance.",
    idempotencyKey: "business-team-1",
  });
  assert.equal(response.replayed, true);
  assert.equal(fixture.calls.some(({ sql }) => sql.includes("INSERT INTO business_job_field_messages")), false);
  assert.equal(fixture.calls.some(({ sql }) => sql.includes("INSERT INTO alerts")), false);
});

test("managed assignment projection keeps retained history separate while reassignment selects only current authority", async () => {
  const replacementAssignmentId = "e7c9a660-c087-4af1-b139-8d77f8d69b33";
  const fixture = createPool({
    managedAssignments: [assignment({
      id: replacementAssignmentId,
      membership_id: "f7c9a660-c087-4af1-b139-8d77f8d69b33",
      member_user_id: 15,
      member_name: "Replacement Employee",
    })],
  });
  const response = await listManagedFieldCommunications({
    pool: fixture.pool,
    authenticatedActor: { id: 9 },
    businessId: 7,
    jobId: JOB_ID,
  });
  assert.equal(response.communications.length, 1);
  assert.equal(response.communications[0].assignmentId, replacementAssignmentId);
  assert.equal(response.communications[0].employee.name, "Replacement Employee");
  assert.equal(response.communications.some((item) => item.assignmentId === ASSIGNMENT_ID), false);
});

test("employee Team alert resolver returns exact route authority and fails closed when stale or ambiguous", async () => {
  const successFixture = createPool({ actorRow: actor("FIELD_EMPLOYEE") });
  const success = await resolveFieldTeamAlertDestination({
    pool: successFixture.pool,
    authenticatedActor: { id: 14 },
    businessId: 7,
    alertId: 801,
  });
  assert.equal(success.ok, true, JSON.stringify(success));
  assert.deepEqual(success.destination, { businessId: 7, jobId: JOB_ID, audience: "team" });
  assert.equal(Object.hasOwn(success.destination, "assignmentId"), false);
  const authorityQuery = successFixture.calls.find(({ sql }) => sql.includes("team_alert_destination"));
  assert.deepEqual(authorityQuery.params, [801, 14, 7, MEMBERSHIP_ID]);
  assert.match(authorityQuery.sql, /alerts\.recipient_user_id = \$2/);
  assert.match(authorityQuery.sql, /assignments\.state = 'ACTIVE'/);
  assert.match(authorityQuery.sql, /senders\.role IN \('OWNER', 'MANAGER'\)/);
  assert.match(authorityQuery.sql, /LIMIT 2/);

  for (const teamAlertRows of [[], [{ job_id: JOB_ID }, { job_id: JOB_ID }]]) {
    const fixture = createPool({ actorRow: actor("FIELD_EMPLOYEE"), teamAlertRows });
    const denied = await resolveFieldTeamAlertDestination({
      pool: fixture.pool,
      authenticatedActor: { id: 14 },
      businessId: 7,
      alertId: 801,
    });
    assert.equal(denied.code, "FIELD_TEAM_ALERT_DESTINATION_UNAVAILABLE");
  }
});

test("private Team storage remains isolated from canonical customer messaging", () => {
  const source = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "..", "server", "team", "fieldOperationsService.js"),
    "utf8"
  );
  assert.match(source, /business_job_field_messages/);
  assert.doesNotMatch(source, /INSERT INTO messages|INSERT INTO conversation_participants|UPDATE conversations/i);
  assert.doesNotMatch(source, /customer.*recipient|homeowner.*recipient/i);
});
