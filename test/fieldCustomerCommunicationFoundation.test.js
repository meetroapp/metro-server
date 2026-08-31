"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  getFieldCustomerConversation,
  resolveFieldCustomerAlertDestination,
  sendFieldCustomerMessage,
  validateAlertDestinationPayload,
  validateReadPayload,
  validateSendPayload,
} = require("../server/team/fieldCustomerCommunicationService");
const {
  registerFieldCustomerCommunicationRoutes,
} = require("../server/team/fieldCustomerCommunication");
const { permissionForRole } = require("../server/team/teamService");
const { isConversationParticipant } = require("../server/conversations/conversations");

const root = path.join(__dirname, "..");
const migration = fs.readFileSync(
  path.join(root, "migrations", "202608310001_create_business_job_customer_message_authority.sql"),
  "utf8"
);
const serviceSource = fs.readFileSync(
  path.join(root, "server", "team", "fieldCustomerCommunicationService.js"),
  "utf8"
);
const fieldOperationsSource = fs.readFileSync(
  path.join(root, "server", "team", "fieldOperationsService.js"),
  "utf8"
);
const indexSource = fs.readFileSync(path.join(root, "index.js"), "utf8");

const JOB_ID = "072c8736-5d97-4253-ba3e-dd1bce281a20";
const OTHER_JOB_ID = "172c8736-5d97-4253-ba3e-dd1bce281a20";
const ASSIGNMENT_ID = "a7c9a660-c087-4af1-b139-8d77f8d69b33";
const MEMBERSHIP_ID = "b7c9a660-c087-4af1-b139-8d77f8d69b33";
const OTHER_MEMBERSHIP_ID = "c7c9a660-c087-4af1-b139-8d77f8d69b33";
const COMMAND_ID = "d7c9a660-c087-4af1-b139-8d77f8d69b33";

function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, " ").trim();
}

function communicationAlertRow(recipientUserId = 7) {
  return {
    id: 301,
    recipient_user_id: recipientUserId,
    source_domain: "communication",
    source_event_type: "conversation.message_created",
    source_entity_type: "conversation",
    source_entity_id: "91",
    source_event_id: "201",
    category: "communication",
    priority: "normal",
    title_key: "alerts.communication.newMessage.title",
    message_key: "alerts.communication.newMessage.message",
    safe_payload: { shortPreview: "I am on site.", unreadCount: 1 },
    destination_type: "conversation",
    destination_payload: { conversationId: 91 },
    dedupe_key: `communication:conversation:91:recipient:${recipientUserId}:after:0`,
    lifecycle_state: "active",
    available_at: "2026-08-31T12:00:00.000Z",
    expires_at: null,
    read_at: null,
    dismissed_at: null,
    resolved_at: null,
    archived_at: null,
    created_at: "2026-08-31T12:00:00.000Z",
    updated_at: "2026-08-31T12:00:00.000Z",
  };
}

function actor(overrides = {}) {
  return {
    id: MEMBERSHIP_ID,
    contractor_profile_id: 80,
    user_id: 14,
    username: "Assigned Employee",
    role: "FIELD_EMPLOYEE",
    status: "ACTIVE",
    ...overrides,
  };
}

function authority(overrides = {}) {
  return {
    id: ASSIGNMENT_ID,
    assignment_id: ASSIGNMENT_ID,
    contractor_profile_id: 80,
    job_id: JOB_ID,
    membership_id: MEMBERSHIP_ID,
    state: "ACTIVE",
    member_user_id: 14,
    member_role: "FIELD_EMPLOYEE",
    member_status: "ACTIVE",
    lifecycle_contract_version: 2,
    relationship_status: "active",
    selection_ended_at: null,
    conversation_id: 91,
    conversation_status: "active",
    homeowner_id: 7,
    professional_user_id: 9,
    contractor_id: 80,
    customer_name: "Customer Name",
    business_name: "Trusted Repairs",
    ...overrides,
  };
}

function projectedRows() {
  return [
    {
      id: 101,
      sender_id: 7,
      message_text: "Gate code is 1234.",
      created_at: "2026-08-31T11:00:00.000Z",
      delegated_membership_id: null,
      delegated_employee_name: null,
    },
    {
      id: 102,
      sender_id: 9,
      message_text: "The business is on the way.",
      created_at: "2026-08-31T11:30:00.000Z",
      delegated_membership_id: null,
      delegated_employee_name: null,
    },
    {
      id: 201,
      sender_id: 9,
      message_text: "I am on site.",
      created_at: "2026-08-31T12:00:00.000Z",
      delegated_membership_id: MEMBERSHIP_ID,
      delegated_employee_name: "Assigned Employee",
    },
  ];
}

function createPool({
  actorRows = [actor()],
  alertRows = [communicationAlertRow(14)],
  candidateRows = [{ assignment_id: ASSIGNMENT_ID, job_id: JOB_ID }],
  authorityRows = [authority()],
  activationRows = [{ assignment_version: 3 }],
  safeRows = projectedRows(),
  existingCommand = null,
  insertCommand = null,
  failOn = null,
} = {}) {
  const calls = [];
  let released = 0;
  let commandSelects = 0;
  const defaultCommand = {
    id: COMMAND_ID,
    contractor_profile_id: 80,
    job_id: JOB_ID,
    assignment_id: ASSIGNMENT_ID,
    membership_id: MEMBERSHIP_ID,
    assignment_activation_version: 3,
    actor_user_id: 14,
    idempotency_key: "customer-message-1",
    request_fingerprint: null,
    result_message_id: null,
    completed_at: null,
  };

  const client = {
    async query(text, params = []) {
      const sql = normalizeSql(text);
      calls.push({ sql, params });
      if (failOn && sql.includes(failOn)) {
        throw new Error("simulated delegated message failure");
      }
      if (
        sql === "BEGIN" ||
        sql === "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY" ||
        sql === "COMMIT" ||
        sql === "ROLLBACK"
      ) return { rows: [] };

      if (sql.includes("FROM business_team_memberships memberships") && sql.includes("memberships.user_id = $1")) {
        return { rows: actorRows };
      }
      if (sql.includes("field_customer_communication:owned_alert")) {
        return { rows: alertRows };
      }
      if (sql.includes("field_customer_communication:alert_assignment_candidates")) {
        return { rows: candidateRows };
      }
      if (sql.includes("field_customer_communication:exact_authority")) {
        return { rows: authorityRows };
      }
      if (sql.includes("FROM business_job_assignment_events")) {
        return { rows: activationRows };
      }
      if (sql.includes("field_customer_communication:safe_text_projection")) {
        return { rows: safeRows };
      }
      if (sql.startsWith("SELECT * FROM business_job_customer_message_commands")) {
        commandSelects += 1;
        return { rows: commandSelects === 1 && existingCommand ? [existingCommand] : [] };
      }
      if (sql.includes("INSERT INTO business_job_customer_message_commands")) {
        const row = insertCommand || { ...defaultCommand, request_fingerprint: params[7] };
        return { rows: [row] };
      }
      if (sql.includes("WITH participant_rows AS") && sql.includes("INSERT INTO conversation_participant_state")) {
        return { rows: [], rowCount: 2 };
      }
      if (sql.includes("FROM conversation_participant_state") && sql.includes("last_read_message_id")) {
        return { rows: [{ last_read_message_id: null }] };
      }
      if (sql.includes("field_customer_communication:delegated_canonical_text")) {
        return {
          rows: [{
            id: 201,
            conversation_id: params[0],
            sender_id: params[1],
            receiver_id: params[2],
            message_text: params[3],
            image_url: null,
            message_type: "text",
            workflow_type: null,
            workflow_status: null,
            workflow_payload: {},
            created_at: "2026-08-31T12:00:00.000Z",
          }],
        };
      }
      if (sql.includes("INSERT INTO conversation_participant_state AS participant_state")) {
        return { rows: [{ conversation_id: params[0] }], rowCount: 1 };
      }
      if (sql.startsWith("UPDATE conversations SET updated_at")) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("COUNT(*)::bigint AS unread_count")) {
        return { rows: [{ unread_count: "1" }] };
      }
      if (sql.includes("INSERT INTO alerts")) {
        return { rows: [communicationAlertRow(params[0])], rowCount: 1 };
      }
      if (sql.startsWith("UPDATE business_job_customer_message_commands")) {
        return {
          rows: [{ ...defaultCommand, result_message_id: params[1], completed_at: "2026-08-31T12:00:00.000Z" }],
          rowCount: 1,
        };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    release() { released += 1; },
  };

  return {
    calls,
    pool: { async connect() { return client; } },
    get released() { return released; },
  };
}

function readRequest(overrides = {}) {
  return {
    pool: overrides.pool,
    authenticatedActor: { id: 14 },
    jobId: JOB_ID,
    payload: { businessId: 80, assignmentId: ASSIGNMENT_ID },
    ...overrides,
  };
}

function sendRequest(overrides = {}) {
  return {
    pool: overrides.pool,
    authenticatedActor: { id: 14 },
    jobId: JOB_ID,
    payload: {
      businessId: 80,
      assignmentId: ASSIGNMENT_ID,
      message: "I am on site.",
      idempotencyKey: "customer-message-1",
    },
    ...overrides,
  };
}

function alertDestinationRequest(overrides = {}) {
  return {
    pool: overrides.pool,
    authenticatedActor: { id: 14 },
    alertId: 301,
    payload: { businessId: 80 },
    ...overrides,
  };
}

test("migration creates immutable delegated authorship evidence with no backfill", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS business_job_customer_message_commands/);
  assert.match(migration, /UNIQUE \(membership_id, assignment_id, idempotency_key\)/);
  assert.match(migration, /UNIQUE \(result_message_id\)/);
  assert.match(migration, /assignment_activation_version/);
  assert.match(migration, /Completed delegated customer message evidence cannot be deleted/);
  assert.match(migration, /Delegated customer message command identity is immutable/);
  assert.match(migration, /messages\.sender_id = conversations\.professional_user_id/);
  assert.match(migration, /messages\.receiver_id = conversations\.homeowner_id/);
  assert.doesNotMatch(migration, /INSERT INTO\s+(?:messages|business_job_assignments|conversation_participant_state)/i);
  assert.doesNotMatch(migration, /participant_role\s+IN\s*\([^)]*FIELD_EMPLOYEE/is);
});

test("only FIELD_EMPLOYEE receives delegated customer communication permission", () => {
  assert.equal(permissionForRole("FIELD_EMPLOYEE", "FIELD_CUSTOMER_COMMUNICATION"), true);
  assert.equal(permissionForRole("BOOKKEEPER_FINANCE", "FIELD_CUSTOMER_COMMUNICATION"), false);
  assert.equal(permissionForRole("OWNER", "FIELD_CUSTOMER_COMMUNICATION"), false);
  assert.equal(permissionForRole("MANAGER", "FIELD_CUSTOMER_COMMUNICATION"), false);
});

test("employee payloads reject every caller-controlled canonical and commercial authority field", () => {
  const forbidden = [
    "conversationId", "conversation_id", "sender", "sender_id", "receiver",
    "receiver_id", "homeowner_id", "professional_user_id", "contractor_id",
    "relationship_id", "workflow_type", "workflow_payload", "quote_id",
    "invoice_id", "payment_id",
  ];
  for (const field of forbidden) {
    assert.equal(validateReadPayload({ businessId: 80, assignmentId: ASSIGNMENT_ID, [field]: 91 }).code, "FIELD_CUSTOMER_CONVERSATION_FIELDS_UNSUPPORTED");
    assert.equal(validateSendPayload({
      businessId: 80,
      assignmentId: ASSIGNMENT_ID,
      message: "Hello",
      idempotencyKey: "key-1",
      [field]: 91,
    }).code, "FIELD_CUSTOMER_MESSAGE_FIELDS_UNSUPPORTED");
  }
  assert.equal(validateSendPayload({
    businessId: 80,
    assignmentId: ASSIGNMENT_ID,
    message: "Hello\u0000customer",
    idempotencyKey: "key-1",
  }).code, "FIELD_CUSTOMER_MESSAGE_REQUEST_INVALID");
  for (const field of ["conversationId", "jobId", "assignmentId", "customerId"]) {
    assert.equal(
      validateAlertDestinationPayload({ businessId: 80, [field]: "caller-value" }).code,
      "FIELD_CUSTOMER_ALERT_DESTINATION_FIELDS_UNSUPPORTED"
    );
  }
});

test("owned communication Alert resolves the exact current Field customer destination", async () => {
  const fake = createPool();
  const result = await resolveFieldCustomerAlertDestination(
    alertDestinationRequest({ pool: fake.pool })
  );
  assert.deepEqual(result, {
    ok: true,
    status: 200,
    code: "FIELD_CUSTOMER_ALERT_DESTINATION_RESOLVED",
    destination: {
      businessId: 80,
      jobId: JOB_ID,
      audience: "customer",
    },
  });
  assert.equal("assignmentId" in result.destination, false);
  const alertLoad = fake.calls.find((call) =>
    call.sql.includes("field_customer_communication:owned_alert")
  );
  assert.deepEqual(alertLoad.params, [301, 14]);
  const candidateLookup = fake.calls.find((call) =>
    call.sql.includes("field_customer_communication:alert_assignment_candidates")
  );
  assert.deepEqual(candidateLookup.params, [80, MEMBERSHIP_ID, 91]);
  assert.match(candidateLookup.sql, /assignments\.state = 'ACTIVE'/);
  assert.match(candidateLookup.sql, /memberships\.role = 'FIELD_EMPLOYEE'/);
  assert.match(candidateLookup.sql, /jobs\.lifecycle_contract_version = 2/);
  assert.match(candidateLookup.sql, /relationships\.status = 'active'/);
  assert.match(candidateLookup.sql, /selections\.ended_at IS NULL/);
  assert.match(candidateLookup.sql, /business_job_assignment_events/);
  assert.match(candidateLookup.sql, /LIMIT 2/);
  assert.equal(fake.calls.at(-1).sql, "COMMIT");
});

test("revoked or inactive assignment makes historical Alert routing unavailable", async () => {
  const fake = createPool({ candidateRows: [] });
  const result = await resolveFieldCustomerAlertDestination(
    alertDestinationRequest({ pool: fake.pool })
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "FIELD_CUSTOMER_ALERT_DESTINATION_UNAVAILABLE");
  assert.equal(fake.calls.some((call) => call.sql.includes("exact_authority")), false);
  assert.equal(fake.calls.at(-1).sql, "ROLLBACK");
});

test("wrong or inactive Field membership cannot resolve an Alert destination", async () => {
  for (const actorRows of [[], [actor({ role: "MANAGER" })], [actor({ status: "INACTIVE" })]]) {
    const fake = createPool({ actorRows });
    const result = await resolveFieldCustomerAlertDestination(
      alertDestinationRequest({ pool: fake.pool })
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, "FIELD_CUSTOMER_COMMUNICATION_PERMISSION_REQUIRED");
    assert.equal(fake.calls.some((call) => call.sql.includes("owned_alert")), false);
  }
});

test("Alert owned by another user cannot resolve a Field destination", async () => {
  const fake = createPool({ alertRows: [] });
  const result = await resolveFieldCustomerAlertDestination(
    alertDestinationRequest({ pool: fake.pool })
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "FIELD_CUSTOMER_ALERT_DESTINATION_UNAVAILABLE");
  const alertLoad = fake.calls.find((call) => call.sql.includes("owned_alert"));
  assert.match(alertLoad.sql, /id = \$1/);
  assert.match(alertLoad.sql, /recipient_user_id = \$2/);
  assert.deepEqual(alertLoad.params, [301, 14]);
});

test("Alert Conversation must exactly match the currently authorized Conversation", async () => {
  const alert = communicationAlertRow(14);
  alert.source_entity_id = "92";
  alert.destination_payload = { conversationId: 92 };
  const fake = createPool({ alertRows: [alert] });
  const result = await resolveFieldCustomerAlertDestination(
    alertDestinationRequest({ pool: fake.pool })
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "FIELD_CUSTOMER_ALERT_DESTINATION_UNAVAILABLE");
  assert.equal(fake.calls.at(-1).sql, "ROLLBACK");
});

test("malformed or non-communication Alert cannot resolve a Field destination", async () => {
  const malformedAlerts = [
    communicationAlertRow(14),
    communicationAlertRow(14),
    communicationAlertRow(14),
  ];
  malformedAlerts[0].source_domain = "workflow";
  malformedAlerts[1].destination_type = "request";
  malformedAlerts[2].destination_payload = { conversationId: 999 };
  for (const malformed of malformedAlerts) {
    const fake = createPool({ alertRows: [malformed] });
    const result = await resolveFieldCustomerAlertDestination(
      alertDestinationRequest({ pool: fake.pool })
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, "FIELD_CUSTOMER_ALERT_DESTINATION_UNAVAILABLE");
    assert.equal(fake.calls.some((call) => call.sql.includes("alert_assignment_candidates")), false);
  }
});

test("two current assignments for one Alert Conversation fail closed as ambiguous", async () => {
  const fake = createPool({
    candidateRows: [
      { assignment_id: ASSIGNMENT_ID, job_id: JOB_ID },
      { assignment_id: "e7c9a660-c087-4af1-b139-8d77f8d69b33", job_id: OTHER_JOB_ID },
    ],
  });
  const result = await resolveFieldCustomerAlertDestination(
    alertDestinationRequest({ pool: fake.pool })
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "FIELD_CUSTOMER_ALERT_DESTINATION_AMBIGUOUS");
  assert.equal(fake.calls.some((call) => call.sql.includes("exact_authority")), false);
});

test("exact active assigned employee loads bounded customer-safe ordinary text projection", async () => {
  const fake = createPool();
  const result = await getFieldCustomerConversation(readRequest({ pool: fake.pool }));
  assert.equal(result.ok, true);
  assert.equal(result.conversation.conversationId, 91);
  assert.equal(result.conversation.jobId, JOB_ID);
  assert.deepEqual(result.conversation.messages.map((message) => message.author.type), [
    "CUSTOMER", "BUSINESS", "FIELD_EMPLOYEE",
  ]);
  assert.equal(result.conversation.messages[2].author.displayName, "Assigned Employee");
  const projection = fake.calls.find((call) => call.sql.includes("safe_text_projection")).sql;
  assert.match(projection, /messages\.message_type = 'text'/);
  assert.match(projection, /messages\.quote_id IS NULL/);
  assert.match(projection, /messages\.invoice_id IS NULL/);
  assert.match(projection, /messages\.workflow_type IS NULL/);
  assert.match(projection, /LIMIT 500/);
  assert.doesNotMatch(JSON.stringify(result.conversation), /sender_id|receiver_id|quote|invoice|payment|workflow/i);
});

test("assignment, employee, membership, and activation mismatches fail closed", async () => {
  const cases = [
    [createPool({ authorityRows: [] }), "FIELD_CUSTOMER_CONVERSATION_NOT_FOUND", { jobId: OTHER_JOB_ID }],
    [createPool({ authorityRows: [authority({ membership_id: OTHER_MEMBERSHIP_ID })] }), "FIELD_CUSTOMER_ASSIGNMENT_REQUIRED", {}],
    [createPool({ authorityRows: [authority({ state: "UNASSIGNED" })] }), "FIELD_CUSTOMER_ASSIGNMENT_REQUIRED", {}],
    [createPool({ actorRows: [] }), "FIELD_CUSTOMER_COMMUNICATION_PERMISSION_REQUIRED", {}],
    [createPool({ activationRows: [] }), "FIELD_CUSTOMER_ASSIGNMENT_EVIDENCE_REQUIRED", {}],
  ];
  for (const [fake, code, overrides] of cases) {
    const result = await getFieldCustomerConversation(readRequest({ pool: fake.pool, ...overrides }));
    assert.equal(result.ok, false);
    assert.equal(result.code, code);
    assert.equal(fake.calls.at(-1).sql, "ROLLBACK");
  }
});

test("exact Job selection joins resolve canonical Conversation without caller identity", () => {
  assert.match(serviceSource, /jobs\.source_request_selection_id/);
  assert.match(serviceSource, /jobs\.source_request_relationship_id/);
  assert.match(serviceSource, /selections\.id = jobs\.source_request_selection_id/);
  assert.match(serviceSource, /conversations\.id = selections\.conversation_id/);
  assert.match(serviceSource, /conversations\.request_selection_id = selections\.id/);
  assert.doesNotMatch(serviceSource, /payload\.conversationId|payload\.sender|payload\.receiver/);
});

test("write authority locks every mutable authority row while GET remains read-only and nonlocking", async () => {
  const read = createPool();
  const loaded = await getFieldCustomerConversation(readRequest({ pool: read.pool }));
  assert.equal(loaded.ok, true);
  assert.equal(
    read.calls[0].sql,
    "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"
  );
  const readAuthority = read.calls.find((call) =>
    call.sql.includes("field_customer_communication:exact_authority")
  ).sql;
  assert.doesNotMatch(readAuthority, /FOR UPDATE/i);

  const write = createPool();
  const sent = await sendFieldCustomerMessage(sendRequest({ pool: write.pool }));
  assert.equal(sent.ok, true);
  assert.equal(write.calls[0].sql, "BEGIN");
  const writeAuthority = write.calls.find((call) =>
    call.sql.includes("field_customer_communication:exact_authority")
  ).sql;
  assert.match(
    writeAuthority,
    /FOR UPDATE OF assignments, memberships, jobs, relationships, selections, conversations/
  );
  for (const alias of [
    "assignments",
    "memberships",
    "jobs",
    "relationships",
    "selections",
    "conversations",
  ]) {
    assert.match(writeAuthority, new RegExp(`\\b${alias}\\b`));
  }

  assert.match(writeAuthority, /assignments\.id = \$1/);
  assert.match(writeAuthority, /memberships\.id = assignments\.membership_id/);
  assert.match(writeAuthority, /relationships\.status = 'active'/);
  assert.match(writeAuthority, /selections\.ended_at IS NULL/);
  assert.match(writeAuthority, /conversations\.id = selections\.conversation_id/);
  assert.match(serviceSource, /authority\.state !== "ACTIVE"/);
  assert.match(serviceSource, /authority\.member_status !== "ACTIVE"/);
  assert.match(serviceSource, /authority\.member_role !== "FIELD_EMPLOYEE"/);
});

test("Field Employee remains denied by canonical participant authority", () => {
  assert.equal(isConversationParticipant({ homeowner_id: 7, professional_user_id: 9 }, 14), false);
  assert.match(indexSource, /getConversation\([\s\S]*participantUserId: req\.user\.id/);
  assert.doesNotMatch(indexSource, /getConversation\([\s\S]{0,500}assignmentId/);
});

test("successful delegated send writes canonical business identity and durable employee provenance", async () => {
  const fake = createPool();
  const result = await sendFieldCustomerMessage(sendRequest({ pool: fake.pool }));
  assert.equal(result.ok, true);
  assert.equal(result.status, 201);
  assert.equal(result.replayed, false);
  assert.equal(result.message.author.type, "FIELD_EMPLOYEE");

  const messageInsert = fake.calls.find((call) => call.sql.includes("delegated_canonical_text"));
  assert.deepEqual(messageInsert.params, [91, 9, 7, "I am on site."]);
  assert.notEqual(messageInsert.params[1], 14);

  const provenanceInsert = fake.calls.find((call) => call.sql.includes("INSERT INTO business_job_customer_message_commands"));
  assert.deepEqual(provenanceInsert.params.slice(0, 7), [
    80, JOB_ID, ASSIGNMENT_ID, MEMBERSHIP_ID, 3, 14, "customer-message-1",
  ]);
  const participantAdvance = fake.calls.find((call) => call.sql.includes("INSERT INTO conversation_participant_state AS participant_state"));
  assert.equal(participantAdvance.params[1], 9);
  assert.notEqual(participantAdvance.params[1], 14);
  const commandCompletion = fake.calls.find((call) => call.sql.startsWith("UPDATE business_job_customer_message_commands"));
  assert.deepEqual(commandCompletion.params, [COMMAND_ID, 201]);
  const alertInsert = fake.calls.find((call) => call.sql.includes("INSERT INTO alerts"));
  assert.equal(alertInsert.params[0], 7);
  assert.equal(
    fake.calls.some((call) =>
      call.sql.includes(
        "field_customer_communication:customer_reply_alert_recipients"
      )
    ),
    false
  );
  assert.equal(fake.calls.at(-1).sql, "COMMIT");
  assert.equal(fake.released, 1);
});

test("same idempotency key replays once and different fingerprint conflicts", async () => {
  const base = createPool();
  const first = await sendFieldCustomerMessage(sendRequest({ pool: base.pool }));
  const commandInsert = base.calls.find((call) => call.sql.includes("INSERT INTO business_job_customer_message_commands"));
  const requestFingerprint = commandInsert.params[7];

  const replayCommand = {
    id: COMMAND_ID,
    request_fingerprint: requestFingerprint,
    result_message_id: 201,
    completed_at: "2026-08-31T12:00:00.000Z",
  };
  const replay = createPool({ existingCommand: replayCommand });
  const replayed = await sendFieldCustomerMessage(sendRequest({ pool: replay.pool }));
  assert.equal(first.ok, true);
  assert.equal(replayed.ok, true);
  assert.equal(replayed.replayed, true);
  assert.equal(replay.calls.some((call) => call.sql.includes("INSERT INTO messages")), false);

  const conflict = createPool({ existingCommand: { ...replayCommand, request_fingerprint: "0".repeat(64) } });
  const conflicted = await sendFieldCustomerMessage(sendRequest({ pool: conflict.pool }));
  assert.equal(conflicted.code, "FIELD_CUSTOMER_MESSAGE_IDEMPOTENCY_CONFLICT");
  assert.equal(conflict.calls.some((call) => call.sql.includes("INSERT INTO messages")), false);
});

test("incomplete command and closed Conversation prevent canonical insertion", async () => {
  const first = createPool();
  await sendFieldCustomerMessage(sendRequest({ pool: first.pool }));
  const requestFingerprint = first.calls.find((call) => call.sql.includes("INSERT INTO business_job_customer_message_commands")).params[7];

  const incomplete = createPool({ existingCommand: {
    id: COMMAND_ID,
    request_fingerprint: requestFingerprint,
    result_message_id: null,
    completed_at: null,
  } });
  const pending = await sendFieldCustomerMessage(sendRequest({ pool: incomplete.pool }));
  assert.equal(pending.code, "FIELD_CUSTOMER_MESSAGE_COMMAND_IN_PROGRESS");
  assert.equal(incomplete.calls.some((call) => call.sql.includes("INSERT INTO messages")), false);

  const closed = createPool({ authorityRows: [authority({ conversation_status: "closed" })] });
  const denied = await sendFieldCustomerMessage(sendRequest({ pool: closed.pool }));
  assert.equal(denied.code, "FIELD_CUSTOMER_CONVERSATION_CLOSED");
  assert.equal(closed.calls.some((call) => call.sql.includes("INSERT INTO messages")), false);
});

test("transaction failure rolls back both canonical message and provenance", async () => {
  const fake = createPool({ failOn: "UPDATE business_job_customer_message_commands" });
  await assert.rejects(
    sendFieldCustomerMessage(sendRequest({ pool: fake.pool })),
    /simulated delegated message failure/
  );
  assert.equal(fake.calls.some((call) => call.sql.includes("INSERT INTO messages")), true);
  assert.equal(fake.calls.at(-1).sql, "ROLLBACK");
  assert.equal(fake.released, 1);
});

test("new routes are separate and private Team messaging remains isolated", () => {
  const routes = [];
  registerFieldCustomerCommunicationRoutes({
    app: {
      get(pathname, ...handlers) { routes.push(["GET", pathname, handlers.length]); },
      post(pathname, ...handlers) { routes.push(["POST", pathname, handlers.length]); },
    },
    authMiddleware() {},
    getPool() {},
    sendPublicDatabaseError() {},
  });
  assert.deepEqual(routes.map(([method, pathname]) => [method, pathname]), [
    ["GET", "/employee/alerts/:alertId/customer-conversation-destination"],
    ["GET", "/employee/jobs/:jobId/customer-conversation"],
    ["POST", "/employee/jobs/:jobId/customer-conversation/messages"],
  ]);
  assert.doesNotMatch(fieldOperationsSource, /\bconversations\b|conversation_participants|quote_request_id/i);
  assert.match(fieldOperationsSource, /business_job_field_messages/);
  assert.doesNotMatch(serviceSource, /business_job_field_messages/);
});
