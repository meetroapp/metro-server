"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  DEFAULT_MESSAGE_PAGE_SIZE,
  MAX_MESSAGE_PAGE_SIZE,
  MAX_MESSAGE_TEXT_LENGTH,
  createConversationMessage,
  decodeMessageCursor,
  encodeMessageCursor,
  listConversationMessages,
  parseMessagePageSize,
  validateConversationMessageInput,
} = require("../server/conversations/conversationMessageService");

function normalizeSql(sql) {
  return String(sql)
    .replace(/\s+/g, " ")
    .trim();
}

function communicationAlertRow(recipientUserId = 9) {
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
    safe_payload: { shortPreview: "Hello", unreadCount: 1 },
    destination_type: "conversation",
    destination_payload: { conversationId: 91 },
    dedupe_key: `communication:conversation:91:recipient:${recipientUserId}:after:0`,
    lifecycle_state: "active",
    available_at: "2026-07-21T12:00:00.000Z",
    expires_at: null,
    read_at: null,
    dismissed_at: null,
    resolved_at: null,
    archived_at: null,
    created_at: "2026-07-21T12:00:00.000Z",
    updated_at: "2026-07-21T12:00:00.000Z",
  };
}

function createPool(rows = []) {
  const calls = [];

  return {
    calls,
    pool: {
      async query(sql, params = []) {
        calls.push({
          sql: normalizeSql(sql),
          params,
        });

        return { rows };
      },
    },
  };
}

function createWritePool({
  conversationRows,
  fieldRecipientRows = [],
  messageId = 201,
  failOn,
  activityRowCount = 1,
  direct = false,
} = {}) {
  const calls = [];
  let releases = 0;

  const defaultConversationRows = [{
    id: 91,
    homeowner_id: 7,
    professional_user_id: 9,
    status: "active",
  }];

  const client = {
    async query(text, params = []) {
      const sql = normalizeSql(text);
      calls.push({ sql, params });

      if (failOn && sql.includes(failOn)) {
        throw new Error("private simulated database failure");
      }

      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) {
        return { rows: [] };
      }

      if (sql.includes("FROM conversations") && sql.includes("FOR UPDATE")) {
        return {
          rows: conversationRows === undefined
            ? defaultConversationRows
            : conversationRows,
        };
      }

      if (
        sql.includes("WITH participant_rows AS") &&
        sql.includes("INSERT INTO conversation_participant_state")
      ) {
        return { rows: [], rowCount: 2 };
      }

      if (
        sql.includes("FROM conversation_participant_state") &&
        sql.includes("last_read_message_id")
      ) {
        return { rows: [{ last_read_message_id: null }] };
      }

      if (sql.includes("INSERT INTO messages")) {
        return {
          rows: [{
            id: messageId,
            sender_id: params[1],
            receiver_id: params[2],
            message_text: params[3],
            image_url: null,
            message_type: "text",
            workflow_type: null,
            workflow_status: null,
            workflow_payload: {},
            created_at: "2026-07-21T12:00:00.000Z",
          }],
        };
      }

      if (
        sql.includes(
          "INSERT INTO conversation_participant_state AS participant_state"
        )
      ) {
        return {
          rows: [{
            conversation_id: params[0],
            user_id: params[1],
            participant_role: params[2],
            last_read_message_id: params[3],
            last_read_at: params[4],
          }],
          rowCount: 1,
        };
      }

      if (sql.includes("UPDATE conversations")) {
        return { rows: [], rowCount: activityRowCount };
      }

      if (sql.includes("COUNT(*)::bigint AS unread_count")) {
        return { rows: [{ unread_count: "1" }] };
      }

      if (
        sql.includes(
          "field_customer_communication:customer_reply_alert_recipients"
        )
      ) {
        return { rows: fieldRecipientRows };
      }

      if (sql.includes("INSERT INTO alerts")) {
        return {
          rows: [communicationAlertRow(params[0])],
          rowCount: 1,
        };
      }

      throw new Error(`Unexpected SQL: ${sql}`);
    },

    release() {
      releases += 1;
    },
  };

  const pool = direct
    ? client
    : {
        async query() {
          throw new Error("Pool query should not own the transaction.");
        },
        async connect() {
          return client;
        },
      };

  return {
    calls,
    pool,
    get releases() {
      return releases;
    },
  };
}

test("canonical message input accepts only trimmed bounded text", () => {
  assert.deepEqual(
    validateConversationMessageInput({
      message_text: "  Hello\nthere  ",
    }),
    {
      valid: true,
      value: {
        messageText: "Hello\nthere",
      },
    }
  );

  for (const payload of [null, [], {}, { message_text: 1 }, { message_text: "   " }]) {
    assert.equal(
      validateConversationMessageInput(payload).code,
      "MESSAGE_TEXT_REQUIRED"
    );
  }

  assert.equal(
    validateConversationMessageInput({
      message_text: "x".repeat(MAX_MESSAGE_TEXT_LENGTH + 1),
    }).code,
    "MESSAGE_TEXT_TOO_LONG"
  );
});

test("canonical message input rejects every client-controlled authority field", () => {
  for (const field of [
    "sender_id",
    "receiver_id",
    "conversation_id",
    "quote_request_id",
    "homeowner_id",
    "contractor_id",
    "professional_user_id",
    "image_url",
    "image_urls",
    "message_type",
    "workflow_type",
    "workflow_status",
    "workflow_payload",
  ]) {
    assert.equal(
      validateConversationMessageInput({
        message_text: "Hello",
        [field]: "client-controlled",
      }).code,
      "UNSUPPORTED_MESSAGE_FIELDS"
    );
  }
});

test("homeowner canonical send locks, inserts fixed identity, updates activity, and commits", async () => {
  const fake = createWritePool();

  const result = await createConversationMessage({
    pool: fake.pool,
    conversationId: 91,
    senderUserId: 7,
    payload: { message_text: "  Hello\nprofessional  " },
  });

  assert.equal(result.code, "CONVERSATION_MESSAGE_CREATED");
  assert.equal(result.status, 201);
  assert.equal(fake.calls[0].sql, "BEGIN");
  assert.equal(fake.calls.at(-1).sql, "COMMIT");
  assert.equal(fake.releases, 1);

  const locked = fake.calls.find(({ sql }) => sql.includes("FOR UPDATE"));
  assert.deepEqual(locked.params, [91, 7]);
  assert.match(locked.sql, /conversations\.homeowner_id = \$2 OR conversations\.professional_user_id = \$2/);

  const inserted = fake.calls.find(({ sql }) => sql.includes("INSERT INTO messages"));
  assert.deepEqual(inserted.params, [91, 7, 9, "Hello\nprofessional"]);
  assert.match(inserted.sql, /quote_request_id, conversation_id, sender_id, receiver_id/);
  assert.match(inserted.sql, /VALUES \( NULL, \$1, \$2, \$3, \$4, NULL, 'text', NULL, NULL, '\{\}'::jsonb \)/);

  const participantEnsure = fake.calls.find(({ sql }) =>
    sql.includes("WITH participant_rows AS")
  );
  const senderAdvance = fake.calls.find(({ sql }) =>
    sql.includes(
      "INSERT INTO conversation_participant_state AS participant_state"
    )
  );

  assert.ok(participantEnsure);
  assert.deepEqual(participantEnsure.params, [91]);
  assert.ok(senderAdvance);
  assert.deepEqual(senderAdvance.params, [
    91,
    7,
    "homeowner",
    201,
    "2026-07-21T12:00:00.000Z",
  ]);
  assert.ok(
    fake.calls.indexOf(participantEnsure) <
      fake.calls.indexOf(inserted)
  );
  assert.ok(
    fake.calls.indexOf(inserted) <
      fake.calls.indexOf(senderAdvance)
  );
  assert.match(
    senderAdvance.sql,
    /ELSE GREATEST\( participant_state\.last_read_message_id, EXCLUDED\.last_read_message_id \)/
  );

  const activity = fake.calls.find(({ sql }) => sql.includes("UPDATE conversations"));
  assert.deepEqual(activity.params, [91, "2026-07-21T12:00:00.000Z"]);

  const attentionWindow = fake.calls.find(({ sql }) =>
    sql.includes("FROM conversation_participant_state") &&
    sql.includes("FOR UPDATE")
  );
  const unreadCount = fake.calls.find(({ sql }) =>
    sql.includes("COUNT(*)::bigint AS unread_count")
  );
  const alertInsert = fake.calls.find(({ sql }) =>
    sql.includes("INSERT INTO alerts")
  );
  assert.deepEqual(attentionWindow.params, [91, 9]);
  assert.deepEqual(unreadCount.params, [91, 9, null]);
  assert.equal(alertInsert.params[0], 9);
  assert.equal(alertInsert.params[4], "91");
  assert.equal(alertInsert.params[5], "201");
  assert.ok(fake.calls.indexOf(attentionWindow) < fake.calls.indexOf(inserted));
  assert.ok(fake.calls.indexOf(inserted) < fake.calls.indexOf(unreadCount));
  assert.ok(fake.calls.indexOf(activity) < fake.calls.indexOf(alertInsert));
  assert.ok(
    fake.calls.indexOf(alertInsert) <
      fake.calls.findIndex(({ sql }) => sql === "COMMIT")
  );

  const fieldRecipientLookup = fake.calls.find(({ sql }) =>
    sql.includes(
      "field_customer_communication:customer_reply_alert_recipients"
    )
  );
  assert.deepEqual(fieldRecipientLookup.params, [91]);
  assert.ok(
    fake.calls.indexOf(alertInsert) <
      fake.calls.indexOf(fieldRecipientLookup)
  );
});

test("customer reply preserves the Business alert and fans out canonical message alerts to every eligible Field user", async () => {
  const fake = createWritePool({
    fieldRecipientRows: [
      { user_id: 14, role: "FIELD_EMPLOYEE" },
      { user_id: 15, role: "FIELD_EMPLOYEE" },
    ],
  });

  await createConversationMessage({
    pool: fake.pool,
    conversationId: 91,
    senderUserId: 7,
    payload: { message_text: "Gate code is 1234." },
  });

  const alertInserts = fake.calls.filter(({ sql }) =>
    sql.includes("INSERT INTO alerts")
  );
  assert.equal(alertInserts.length, 3);
  assert.deepEqual(
    alertInserts.map(({ params }) => params[0]),
    [9, 14, 15]
  );

  for (const fieldAlert of alertInserts.slice(1)) {
    const recipientUserId = fieldAlert.params[0];
    assert.equal(fieldAlert.params[1], "communication");
    assert.equal(
      fieldAlert.params[2],
      "conversation.message_created"
    );
    assert.equal(fieldAlert.params[3], "conversation");
    assert.equal(fieldAlert.params[4], "91");
    assert.equal(fieldAlert.params[5], "201");
    assert.equal(fieldAlert.params[7], "communication");
    assert.equal(fieldAlert.params[12], "conversation");
    assert.equal(fieldAlert.params[13], '{"conversationId":91}');
    assert.equal(
      fieldAlert.params[14],
      `communication:conversation:91:recipient:${recipientUserId}:message:201`
    );
    assert.match(String(fieldAlert.params[6]), /^[0-9a-f]{64}$/);
    assert.doesNotMatch(fieldAlert.params[13], /jobId|assignmentId/);
  }

  const recipientLookup = fake.calls.find(({ sql }) =>
    sql.includes(
      "field_customer_communication:customer_reply_alert_recipients"
    )
  );
  assert.match(recipientLookup.sql, /assignments\.state = 'ACTIVE'/);
  assert.match(recipientLookup.sql, /memberships\.status = 'ACTIVE'/);
  assert.match(recipientLookup.sql, /memberships\.role = 'FIELD_EMPLOYEE'/);
  assert.match(recipientLookup.sql, /jobs\.lifecycle_contract_version = 2/);
  assert.match(recipientLookup.sql, /relationships\.status = 'active'/);
  assert.match(
    recipientLookup.sql,
    /selections\.selected_by_user_id = conversations\.homeowner_id/
  );
  assert.match(
    recipientLookup.sql,
    /selections\.professional_user_id = conversations\.professional_user_id/
  );
  assert.match(recipientLookup.sql, /selections\.ended_at IS NULL/);
  assert.match(recipientLookup.sql, /business_job_assignment_events/);
  assert.match(recipientLookup.sql, /'ASSIGNED', 'REASSIGNED'/);
  assert.match(recipientLookup.sql, /SELECT DISTINCT memberships\.user_id/);
});

test("Field customer reply alert dedupe is stable for one canonical message and distinct for a later message", async () => {
  const run = async (messageId) => {
    const fake = createWritePool({
      fieldRecipientRows: [
        { user_id: 14, role: "FIELD_EMPLOYEE" },
      ],
      messageId,
    });
    await createConversationMessage({
      pool: fake.pool,
      conversationId: 91,
      senderUserId: 7,
      payload: { message_text: "Customer reply" },
    });
    return fake.calls.filter(({ sql }) =>
      sql.includes("INSERT INTO alerts")
    ).at(-1).params;
  };

  const firstAttempt = await run(201);
  const sameMessageRetry = await run(201);
  const laterMessage = await run(202);

  assert.equal(firstAttempt[6], sameMessageRetry[6]);
  assert.equal(firstAttempt[14], sameMessageRetry[14]);
  assert.notEqual(firstAttempt[6], laterMessage[6]);
  assert.notEqual(firstAttempt[14], laterMessage[14]);
  assert.match(laterMessage[14], /:message:202$/);
});

test("professional canonical send resolves the homeowner server-side", async () => {
  const fake = createWritePool();

  await createConversationMessage({
    pool: fake.pool,
    conversationId: 91,
    senderUserId: 9,
    payload: { message_text: "Hello homeowner" },
  });

  const inserted = fake.calls.find(({ sql }) => sql.includes("INSERT INTO messages"));
  assert.deepEqual(inserted.params, [91, 9, 7, "Hello homeowner"]);

  const senderAdvance = fake.calls.find(({ sql }) =>
    sql.includes(
      "INSERT INTO conversation_participant_state AS participant_state"
    )
  );
  assert.deepEqual(senderAdvance.params.slice(0, 4), [
    91,
    9,
    "professional",
    201,
  ]);
  assert.notEqual(senderAdvance.params[1], 7);
  assert.equal(
    fake.calls.some(({ sql }) =>
      sql.includes(
        "field_customer_communication:customer_reply_alert_recipients"
      )
    ),
    false
  );
});

test("validation and invalid identity failures occur before database access", async () => {
  let queried = false;
  const pool = {
    async query() {
      queried = true;
      return { rows: [] };
    },
  };

  assert.equal((await createConversationMessage({
    pool,
    conversationId: "invalid",
    senderUserId: 7,
    payload: { message_text: "Hello" },
  })).code, "INVALID_CONVERSATION_ID");

  assert.equal((await createConversationMessage({
    pool,
    conversationId: 91,
    senderUserId: 7,
    payload: { message_text: "Hello", receiver_id: 9 },
  })).code, "UNSUPPORTED_MESSAGE_FIELDS");

  assert.equal(queried, false);
});

test("non-participant and closed conversation failures roll back without insertion", async () => {
  for (const scenario of [
    { conversationRows: [], code: "CONVERSATION_NOT_FOUND" },
    {
      conversationRows: [{
        id: 91,
        homeowner_id: 7,
        professional_user_id: 9,
        status: "closed",
      }],
      code: "CONVERSATION_CLOSED",
    },
  ]) {
    const fake = createWritePool(scenario);
    const result = await createConversationMessage({
      pool: fake.pool,
      conversationId: 91,
      senderUserId: 7,
      payload: { message_text: "Hello" },
    });

    assert.equal(result.code, scenario.code);
    assert.equal(fake.calls.at(-1).sql, "ROLLBACK");
    assert.equal(fake.calls.some(({ sql }) => sql.includes("INSERT INTO messages")), false);
    assert.equal(fake.calls.some(({ sql }) => sql.includes("UPDATE conversations")), false);
  }
});

test("message, activity, and alert failures roll back and release without commit", async () => {
  for (const failOn of [
    "INSERT INTO messages",
    "UPDATE conversations",
    "INSERT INTO alerts",
  ]) {
    const fake = createWritePool({ failOn });

    await assert.rejects(
      createConversationMessage({
        pool: fake.pool,
        conversationId: 91,
        senderUserId: 7,
        payload: { message_text: "Hello" },
      }),
      /private simulated database failure/
    );

    assert.equal(fake.calls.some(({ sql }) => sql === "ROLLBACK"), true);
    assert.equal(fake.calls.some(({ sql }) => sql === "COMMIT"), false);
    assert.equal(fake.releases, 1);
  }
});

test("alert persistence failure rolls back message, sender read state, and activity atomically", async () => {
  const fake = createWritePool({ failOn: "INSERT INTO alerts" });

  await assert.rejects(
    createConversationMessage({
      pool: fake.pool,
      conversationId: 91,
      senderUserId: 7,
      payload: { message_text: "Atomic alert failure" },
    }),
    /private simulated database failure/
  );

  const insertedIndex = fake.calls.findIndex(({ sql }) =>
    sql.includes("INSERT INTO messages")
  );
  const senderAdvanceIndex = fake.calls.findIndex(({ sql }) =>
    sql.includes("INSERT INTO conversation_participant_state AS participant_state")
  );
  const activityIndex = fake.calls.findIndex(({ sql }) =>
    sql.includes("UPDATE conversations")
  );
  const alertIndex = fake.calls.findIndex(({ sql }) =>
    sql.includes("INSERT INTO alerts")
  );
  const rollbackIndex = fake.calls.findIndex(({ sql }) => sql === "ROLLBACK");
  assert.ok(insertedIndex >= 0);
  assert.ok(insertedIndex < senderAdvanceIndex);
  assert.ok(senderAdvanceIndex < activityIndex);
  assert.ok(activityIndex < alertIndex);
  assert.ok(alertIndex < rollbackIndex);
  assert.equal(fake.calls.some(({ sql }) => sql === "COMMIT"), false);
});

test("canonical sending supports a direct database client", async () => {
  const fake = createWritePool({ direct: true });

  const result = await createConversationMessage({
    pool: fake.pool,
    conversationId: 91,
    senderUserId: 7,
    payload: { message_text: "Hello" },
  });

  assert.equal(result.ok, true);
  assert.equal(fake.releases, 0);
});

test("canonical sending rejects an invalid database dependency", async () => {
  await assert.rejects(
    createConversationMessage({
      pool: null,
      conversationId: 91,
      senderUserId: 7,
      payload: { message_text: "Hello" },
    }),
    /database pool or client/
  );
});

test("message page size is bounded and defaults safely", () => {
  assert.equal(
    parseMessagePageSize(undefined),
    DEFAULT_MESSAGE_PAGE_SIZE
  );

  assert.equal(
    parseMessagePageSize("100"),
    MAX_MESSAGE_PAGE_SIZE
  );

  for (const invalid of [
    "0",
    "-1",
    "1.5",
    "101",
    "invalid",
  ]) {
    assert.equal(
      parseMessagePageSize(invalid),
      null
    );
  }
});

test("message cursors round trip deterministic identity", () => {
  const encoded = encodeMessageCursor({
    id: 44,
    created_at:
      "2026-07-21T12:30:00.000Z",
  });

  assert.deepEqual(
    decodeMessageCursor(encoded),
    {
      valid: true,
      cursor: {
        id: 44,
        createdAt:
          "2026-07-21T12:30:00.000Z",
      },
    }
  );
});

test("invalid message cursors fail closed", () => {
  for (const invalid of [
    "not-a-cursor",
    Buffer.from(
      JSON.stringify({ id: 0 }),
      "utf8"
    ).toString("base64url"),
    Buffer.from(
      JSON.stringify({
        id: 1,
        createdAt: "invalid",
      }),
      "utf8"
    ).toString("base64url"),
  ]) {
    assert.deepEqual(
      decodeMessageCursor(invalid),
      {
        valid: false,
        cursor: null,
      }
    );
  }
});

test("conversation messages query only canonical conversation identity", async () => {
  const rows = [{
    id: 101,
    sender_id: 7,
    receiver_id: 9,
    message_text: "Canonical hello",
    image_url: null,
    message_type: "text",
    workflow_type: null,
    workflow_status: null,
    workflow_payload: {},
    created_at:
      "2026-07-21T12:00:00.000Z",
  }];

  const fake = createPool(rows);

  const result =
    await listConversationMessages({
      pool: fake.pool,
      conversationId: 91,
      limit: 25,
    });

  assert.equal(result.ok, true);
  assert.deepEqual(result.messages, rows);
  assert.deepEqual(result.pagination, {
    limit: 25,
    hasMore: false,
    nextCursor: null,
  });

  const query = fake.calls[0];

  assert.match(
    query.sql,
    /WHERE messages\.conversation_id = \$1/
  );

  assert.doesNotMatch(
    query.sql,
    /quote_request_id/
  );

  assert.match(
    query.sql,
    /ORDER BY messages\.created_at ASC NULLS LAST, messages\.id ASC/
  );

  assert.deepEqual(
    query.params,
    [91, false, null, 0, 26]
  );
});

test("conversation messages return bounded forward pagination", async () => {
  const rows = [
    {
      id: 101,
      created_at:
        "2026-07-21T12:00:00.000Z",
    },
    {
      id: 102,
      created_at:
        "2026-07-21T12:00:00.000Z",
    },
    {
      id: 103,
      created_at:
        "2026-07-21T12:01:00.000Z",
    },
  ];

  const fake = createPool(rows);

  const result =
    await listConversationMessages({
      pool: fake.pool,
      conversationId: 91,
      limit: 2,
    });

  assert.deepEqual(
    result.messages.map(({ id }) => id),
    [101, 102]
  );

  assert.equal(
    result.pagination.hasMore,
    true
  );

  assert.deepEqual(
    decodeMessageCursor(
      result.pagination.nextCursor
    ),
    {
      valid: true,
      cursor: {
        id: 102,
        createdAt:
          "2026-07-21T12:00:00.000Z",
      },
    }
  );
});

test("forward cursor uses created time and message id", async () => {
  const cursor = encodeMessageCursor({
    id: 102,
    created_at:
      "2026-07-21T12:00:00.000Z",
  });

  const fake = createPool([]);

  await listConversationMessages({
    pool: fake.pool,
    conversationId: 91,
    limit: 10,
    cursor,
  });

  assert.deepEqual(
    fake.calls[0].params,
    [
      91,
      true,
      "2026-07-21T12:00:00.000Z",
      102,
      11,
    ]
  );
});

test("invalid inputs fail before database access", async () => {
  let queried = false;

  const pool = {
    async query() {
      queried = true;
      return { rows: [] };
    },
  };

  assert.equal(
    (
      await listConversationMessages({
        pool,
        conversationId: "invalid",
      })
    ).code,
    "INVALID_CONVERSATION_ID"
  );

  assert.equal(
    (
      await listConversationMessages({
        pool,
        conversationId: 91,
        limit: 101,
      })
    ).code,
    "INVALID_MESSAGE_PAGE_SIZE"
  );

  assert.equal(
    (
      await listConversationMessages({
        pool,
        conversationId: 91,
        cursor: "invalid",
      })
    ).code,
    "INVALID_MESSAGE_CURSOR"
  );

  assert.equal(queried, false);
});

test("message service validates the database dependency", async () => {
  await assert.rejects(
    listConversationMessages({
      pool: null,
      conversationId: 91,
    }),
    /database pool or client/
  );
});


test("non-null cursors retain null-timestamp messages at the ordered tail", async () => {
  const cursor = encodeMessageCursor({
    id: 102,
    created_at:
      "2026-07-21T12:00:00.000Z",
  });

  const fake = createPool([]);

  await listConversationMessages({
    pool: fake.pool,
    conversationId: 91,
    limit: 10,
    cursor,
  });

  const query = fake.calls[0];

  assert.match(
    query.sql,
    /messages\.created_at IS NULL OR \( messages\.created_at IS NOT NULL/
  );

  assert.match(
    query.sql,
    /ORDER BY messages\.created_at ASC NULLS LAST, messages\.id ASC/
  );
});
