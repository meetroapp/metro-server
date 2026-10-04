"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  archiveAlertWithClient,
  countAlertsForRecipientWithClient,
  countCommunicationAttentionForRecipientWithClient,
  dismissAlertWithClient,
  expireAlertWithClient,
  findAnyAlertByRecipientWithClient,
  findAlertByRecipientWithClient,
  insertAlertWithClient,
  listAlertsForRecipientWithClient,
  markAlertsReadThroughCutoffWithClient,
  markAlertReadWithClient,
  resolveAlertsBySourceWithClient,
} = require("../server/alerts/alertRepository");

function normalizeSql(value) {
  return String(value).replace(/\s+/g, " ").trim();
}

function alertInput(overrides = {}) {
  return {
    recipientUserId: 7,
    sourceDomain: "communication",
    sourceEventType: "conversation.message.created",
    sourceEntityType: "conversation",
    sourceEntityId: "91",
    sourceEventId: "message:205",
    canonicalEventKey: null,
    category: "communication",
    priority: "normal",
    titleKey: "alerts.communication.message.title",
    messageKey: "alerts.communication.message.body",
    safePayload: { count: 1 },
    destination: {
      type: "conversation",
      payload: { conversationId: 91 },
    },
    dedupeKey: "communication:conversation:91:message:205",
    availableAt: null,
    expiresAt: null,
    ...overrides,
  };
}

function row(overrides = {}) {
  return {
    id: 100,
    recipient_user_id: 7,
    source_domain: "communication",
    source_event_type: "conversation.message.created",
    source_entity_type: "conversation",
    source_entity_id: "91",
    source_event_id: "message:205",
    category: "communication",
    priority: "normal",
    title_key: "alerts.communication.message.title",
    message_key: "alerts.communication.message.body",
    safe_payload: { count: 1 },
    destination_type: "conversation",
    destination_payload: { conversationId: 91 },
    dedupe_key: "communication:conversation:91:message:205",
    lifecycle_state: "active",
    available_at: "2026-08-03T12:00:00.000Z",
    expires_at: null,
    read_at: null,
    dismissed_at: null,
    resolved_at: null,
    archived_at: null,
    created_at: "2026-08-03T12:00:00.000Z",
    updated_at: "2026-08-03T12:00:00.000Z",
    ...overrides,
  };
}

test("alert repository inserts canonical recipient-scoped columns as JSONB", async () => {
  const calls = [];
  const client = {
    async query(text, params) {
      calls.push({ sql: normalizeSql(text), params });
      return { rows: [row()] };
    },
  };

  const result = await insertAlertWithClient({
    client,
    alert: alertInput(),
  });

  assert.equal(result.created, true);
  assert.equal(result.row.id, 100);
  assert.match(calls[0].sql, /INSERT INTO alerts/);
  assert.match(calls[0].sql, /\$12::jsonb/);
  assert.match(calls[0].sql, /\$14::jsonb/);
  assert.match(calls[0].sql, /ON CONFLICT DO NOTHING/);
  assert.equal(calls[0].params[0], 7);
  assert.equal(calls[0].params[14], "communication:conversation:91:message:205");
});

test("alert repository returns existing active alert on dedupe conflict", async () => {
  const calls = [];
  const existing = row({ id: 101 });
  const client = {
    async query(text, params) {
      const sql = normalizeSql(text);
      calls.push({ sql, params });
      if (sql.startsWith("INSERT INTO alerts")) return { rows: [] };
      return { rows: [existing] };
    },
  };

  const result = await insertAlertWithClient({
    client,
    alert: alertInput(),
  });

  assert.equal(result.created, false);
  assert.equal(result.row.id, 101);
  assert.match(
    calls[1].sql,
    /recipient_user_id = \$1 AND dedupe_key = \$2/
  );
  assert.match(
    calls[1].sql,
    /lifecycle_state IN \('active', 'dismissed'\)/
  );
});

test("permanent event identity survives every lifecycle state and remains recipient scoped", async () => {
  const calls = [];
  const canonicalEventKey = "a".repeat(64);
  const existing = row({
    id: 109,
    recipient_user_id: 7,
    canonical_event_key: canonicalEventKey,
    lifecycle_state: "archived",
    read_at: "2026-08-03T12:01:00.000Z",
    dismissed_at: "2026-08-03T12:02:00.000Z",
    resolved_at: "2026-08-03T12:03:00.000Z",
    archived_at: "2026-08-04T00:00:00.000Z",
  });
  const client = {
    async query(text, params) {
      const sql = normalizeSql(text);
      calls.push({ sql, params });
      if (sql.startsWith("INSERT INTO alerts")) return { rows: [] };
      return { rows: [existing] };
    },
  };

  const result = await insertAlertWithClient({
    client,
    alert: alertInput({ canonicalEventKey }),
  });

  assert.equal(result.created, false);
  assert.equal(result.row.id, 109);
  assert.deepEqual(calls[1].params, [7, canonicalEventKey]);
  assert.match(calls[1].sql, /recipient_user_id = \$1/);
  assert.match(calls[1].sql, /canonical_event_key = \$2/);
  const whereClause = calls[1].sql.split(" FROM alerts ")[1];
  assert.doesNotMatch(
    whereClause,
    /lifecycle_state|read_at|dismissed_at|resolved_at|archived_at/
  );
});

test("the same permanent event may project once for each distinct recipient", async () => {
  const canonicalEventKey = "b".repeat(64);
  const lookups = [];
  const client = {
    async query(text, params) {
      const sql = normalizeSql(text);
      if (sql.startsWith("INSERT INTO alerts")) return { rows: [] };
      lookups.push({ sql, params });
      return {
        rows: [row({
          id: params[0] * 10,
          recipient_user_id: params[0],
          canonical_event_key: params[1],
        })],
      };
    },
  };

  const first = await insertAlertWithClient({
    client,
    alert: alertInput({ recipientUserId: 7, canonicalEventKey }),
  });
  const second = await insertAlertWithClient({
    client,
    alert: alertInput({ recipientUserId: 8, canonicalEventKey }),
  });

  assert.equal(first.row.recipient_user_id, 7);
  assert.equal(second.row.recipient_user_id, 8);
  assert.deepEqual(lookups.map(({ params }) => params), [
    [7, canonicalEventKey],
    [8, canonicalEventKey],
  ]);
});

test("alert repository keeps recipient lookup and mutations owner scoped", async () => {
  const calls = [];
  const client = {
    async query(text, params) {
      calls.push({ sql: normalizeSql(text), params });
      return { rows: [row()] };
    },
  };

  await findAlertByRecipientWithClient({
    client,
    alertId: 100,
    recipientUserId: 7,
  });
  await markAlertReadWithClient({
    client,
    alertId: 100,
    recipientUserId: 7,
  });
  await dismissAlertWithClient({
    client,
    alertId: 100,
    recipientUserId: 7,
  });

  assert.match(calls[0].sql, /WHERE id = \$1 AND recipient_user_id = \$2/);
  assert.match(calls[0].sql, /FOR UPDATE/);
  assert.match(calls[1].sql, /WHERE id = \$1 AND recipient_user_id = \$2/);
  assert.match(calls[1].sql, /read_at = COALESCE/);
  assert.match(calls[2].sql, /priority <> 'critical'/);
  assert.match(calls[2].sql, /lifecycle_state IN \('active', 'dismissed'\)/);
});

test("alert repository resolves only exact source-scoped active or dismissed alerts", async () => {
  let captured;
  const client = {
    async query(text, params) {
      captured = { sql: normalizeSql(text), params };
      return { rows: [row({ lifecycle_state: "resolved" })] };
    },
  };

  const rows = await resolveAlertsBySourceWithClient({
    client,
    sourceDomain: "communication",
    sourceEntityType: "conversation",
    sourceEntityId: "91",
    sourceEventType: "conversation.message.created",
    recipientUserId: 7,
  });

  assert.equal(rows.length, 1);
  assert.match(captured.sql, /source_domain = \$1/);
  assert.match(captured.sql, /source_entity_type = \$2/);
  assert.match(captured.sql, /source_entity_id = \$3/);
  assert.match(captured.sql, /\(\$4::text IS NULL OR source_event_type = \$4\)/);
  assert.match(captured.sql, /\(\$5::integer IS NULL OR recipient_user_id = \$5\)/);
  assert.doesNotMatch(captured.sql, /workflow_events/i);
});

test("alert repository does not own transactions or release caller clients", async () => {
  const calls = [];
  let released = false;
  const client = {
    async query(text) {
      calls.push(normalizeSql(text));
      return { rows: [row()] };
    },
    release() {
      released = true;
    },
  };

  await markAlertReadWithClient({
    client,
    alertId: 100,
    recipientUserId: 7,
  });

  assert.equal(calls.some((sql) => ["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)), false);
  assert.equal(released, false);
});

test("alert dedupe fallback remains exact, active, and recipient independent", async () => {
  const calls = [];
  const client = {
    async query(text, params) {
      const sql = normalizeSql(text);
      calls.push({ sql, params });
      if (sql.startsWith("INSERT INTO alerts")) return { rows: [] };
      return { rows: [row({ id: params[0] * 10, recipient_user_id: params[0] })] };
    },
  };

  const first = await insertAlertWithClient({ client, alert: alertInput({ recipientUserId: 7 }) });
  const second = await insertAlertWithClient({ client, alert: alertInput({ recipientUserId: 8 }) });

  assert.equal(first.row.recipient_user_id, 7);
  assert.equal(second.row.recipient_user_id, 8);
  for (const lookup of calls.filter((call) => call.sql.startsWith("SELECT"))) {
    assert.match(lookup.sql, /recipient_user_id = \$1 AND dedupe_key = \$2/);
    assert.match(lookup.sql, /archived_at IS NULL/);
    assert.match(lookup.sql, /resolved_at IS NULL/);
    assert.match(lookup.sql, /lifecycle_state IN \('active', 'dismissed'\)/);
  }
});

test("alert repository expires only due recipient-owned active obligations", async () => {
  let captured;
  const client = {
    async query(text, params) {
      captured = { sql: normalizeSql(text), params };
      return { rows: [row({ lifecycle_state: "expired" })] };
    },
  };

  const result = await expireAlertWithClient({
    client,
    alertId: 100,
    recipientUserId: 7,
    effectiveAt: "2026-08-04T00:00:00.000Z",
  });

  assert.equal(result.lifecycle_state, "expired");
  assert.match(captured.sql, /WHERE id = \$1 AND recipient_user_id = \$2/);
  assert.match(captured.sql, /lifecycle_state IN \('active', 'dismissed', 'expired'\)/);
  assert.match(captured.sql, /expires_at <= COALESCE\(\$3::timestamp, CURRENT_TIMESTAMP\)/);
  assert.doesNotMatch(captured.sql, /BEGIN|COMMIT|ROLLBACK/);
});

test("alert repository archives only recipient-owned terminal rows without deletion", async () => {
  const calls = [];
  const client = {
    async query(text, params) {
      calls.push({ sql: normalizeSql(text), params });
      return { rows: [row({ lifecycle_state: "archived", archived_at: params[2] })] };
    },
  };

  await findAnyAlertByRecipientWithClient({ client, alertId: 100, recipientUserId: 7 });
  const result = await archiveAlertWithClient({
    client,
    alertId: 100,
    recipientUserId: 7,
    archivedAt: "2026-08-04T00:00:00.000Z",
  });

  assert.equal(result.lifecycle_state, "archived");
  assert.match(calls[0].sql, /WHERE id = \$1 AND recipient_user_id = \$2/);
  assert.doesNotMatch(calls[0].sql, /archived_at IS NULL/);
  assert.match(calls[1].sql, /lifecycle_state IN \('resolved', 'expired', 'archived'\)/);
  assert.match(calls[1].sql, /archived_at = COALESCE/);
  assert.doesNotMatch(calls[1].sql, /DELETE/);
});

test("alert repository propagates SQL failures without transaction ownership", async () => {
  let released = false;
  const error = new Error("private sql detail");
  const client = {
    async query() {
      throw error;
    },
    release() {
      released = true;
    },
  };

  await assert.rejects(
    expireAlertWithClient({ client, alertId: 100, recipientUserId: 7 }),
    (caught) => caught === error
  );
  assert.equal(released, false);
});

test("alert repository lists only one recipient with static filters and descending cursor order", async () => {
  let captured;
  const client = {
    async query(text, params) {
      captured = { sql: normalizeSql(text), params };
      return { rows: [row()] };
    },
  };

  const rows = await listAlertsForRecipientWithClient({
    client,
    recipientUserId: 7,
    category: "communication",
    priority: "high",
    lifecycle: "active",
    unread: true,
    cursor: {
      availableAt: "2026-08-03T12:00:00.000Z",
      id: 100,
    },
    limit: 26,
  });

  assert.equal(rows.length, 1);
  assert.match(captured.sql, /WHERE recipient_user_id = \$1/);
  assert.match(captured.sql, /lifecycle_state = \$2/);
  assert.match(captured.sql, /available_at <= CURRENT_TIMESTAMP/);
  assert.match(captured.sql, /\$5::boolean = TRUE AND read_at IS NULL/);
  assert.match(captured.sql, /available_at < \$7::timestamp/);
  assert.match(captured.sql, /available_at = \$7::timestamp AND id < \$8/);
  assert.match(captured.sql, /ORDER BY available_at DESC, id DESC LIMIT \$9/);
  assert.deepEqual(captured.params, [
    7,
    "active",
    "communication",
    "high",
    true,
    true,
    "2026-08-03T12:00:00.000Z",
    100,
    26,
  ]);
});

test("alert repository explicitly separates archived and non-archived listing", async () => {
  let sql;
  const client = {
    async query(text) {
      sql = normalizeSql(text);
      return { rows: [] };
    },
  };

  await listAlertsForRecipientWithClient({
    client,
    recipientUserId: 7,
    lifecycle: "archived",
    limit: 26,
  });

  assert.match(sql, /\$2::text = 'archived' AND archived_at IS NOT NULL/);
  assert.match(sql, /\$2::text <> 'archived' AND archived_at IS NULL/);
});

test("alert repository counts active and unread alerts in one recipient-scoped aggregate", async () => {
  let captured;
  const client = {
    async query(text, params) {
      captured = { sql: normalizeSql(text), params };
      return {
        rows: [{ category: "communication", active_count: 2, unread_count: 1 }],
      };
    },
  };

  const rows = await countAlertsForRecipientWithClient({
    client,
    recipientUserId: 7,
  });

  assert.equal(rows.length, 1);
  assert.deepEqual(captured.params, [7]);
  assert.match(captured.sql, /WHERE recipient_user_id = \$1/);
  assert.match(captured.sql, /lifecycle_state = 'active'/);
  assert.match(captured.sql, /archived_at IS NULL/);
  assert.match(captured.sql, /COUNT\(\*\) FILTER \(WHERE read_at IS NULL\)/);
  assert.match(captured.sql, /GROUP BY category/);
});

test("communication attention counts distinct recipient-owned Alerts under current authority", async () => {
  let captured;
  const client = {
    async query(text, params) {
      captured = { sql: normalizeSql(text), params };
      return { rows: [{ audience: "team", business_id: 7, job_id: "job", unread_count: 1 }] };
    },
  };
  const rows = await countCommunicationAttentionForRecipientWithClient({
    client,
    recipientUserId: 7,
  });
  assert.equal(rows.length, 1);
  assert.deepEqual(captured.params, [7]);
  assert.match(captured.sql, /alerts:communication_attention_counts/);
  assert.match(captured.sql, /COUNT\(DISTINCT alert_id\)/);
  assert.match(captured.sql, /WHERE recipient_user_id = \$1/);
  assert.match(captured.sql, /assignments\.state = 'ACTIVE'/);
  assert.match(captured.sql, /jobs\.lifecycle_contract_version = 2/);
  assert.match(captured.sql, /candidate_count = 1/);
  assert.doesNotMatch(captured.sql, /INSERT INTO|DELETE FROM/);
});

test("alert repository read-all uses one race-safe cutoff update for active unread rows", async () => {
  let captured;
  const client = {
    async query(text, params) {
      captured = { sql: normalizeSql(text), params };
      return {
        rows: [{
          cutoff_at: "2026-08-03T12:00:00.000Z",
          marked_read_count: 3,
        }],
      };
    },
  };

  const result = await markAlertsReadThroughCutoffWithClient({
    client,
    recipientUserId: 7,
    category: "communication",
  });

  assert.equal(result.marked_read_count, 3);
  assert.deepEqual(captured.params, [7, "communication"]);
  assert.match(captured.sql, /SELECT statement_timestamp\(\) AS cutoff_at/);
  assert.match(captured.sql, /UPDATE alerts SET read_at = cutoff\.cutoff_at/);
  assert.match(captured.sql, /recipient_user_id = \$1/);
  assert.match(captured.sql, /lifecycle_state = 'active'/);
  assert.match(captured.sql, /read_at IS NULL/);
  assert.match(captured.sql, /available_at <= cutoff\.cutoff_at/);
  assert.match(captured.sql, /\$2::text IS NULL OR category = \$2/);
  assert.doesNotMatch(captured.sql, /BEGIN|COMMIT|ROLLBACK|DELETE/);
});

test("alert list parameters cannot become SQL authority", async () => {
  let captured;
  const client = {
    async query(text, params) {
      captured = { sql: normalizeSql(text), params };
      return { rows: [] };
    },
  };
  const injected = "communication' OR TRUE --";

  await listAlertsForRecipientWithClient({
    client,
    recipientUserId: 7,
    category: injected,
    priority: injected,
    lifecycle: injected,
    limit: 26,
  });

  assert.doesNotMatch(captured.sql, /OR TRUE --/);
  assert.equal(captured.params.includes(injected), true);
});
