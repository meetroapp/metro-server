"use strict";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const test = require("node:test");
const { Pool } = require("pg");

const { assertSafeTestDatabaseUrl } = require("./helpers/databaseTargetSafety");
const {
  createVisitTestIdentities,
} = require("./helpers/visitLifecycleFixture");
const {
  createCanonicalLifecycleAlertWithClient,
  resolveCanonicalLifecycleAlertsWithClient,
} = require("../server/alerts/lifecycleAlertService");
const {
  archiveAlert,
  dismissAlert,
  markAlertRead,
} = require("../server/alerts/alertService");
const {
  getMigrationFiles,
  runMigrationCollection,
} = require("../scripts/run-migrations");

const databaseUrl = process.env.ALERT_B1_IDENTITY_DATABASE_URL;

function targetMetadata() {
  return {
    target: "local-test",
    database: assertSafeTestDatabaseUrl(databaseUrl, {
      nodeEnv: process.env.NODE_ENV,
    }),
  };
}

function eventInput(recipientUserId, sourceEventId = "event-1") {
  return {
    recipientUserId,
    sourceDomain: "workflow",
    sourceEventType: "request.professional_response_submitted",
    sourceEntityType: "request",
    sourceEntityId: "101",
    sourceEventId,
    category: "request",
    priority: "normal",
    titleKey: "alerts.request.response.title",
    messageKey: "alerts.request.response.message",
    safePayload: { shortPreview: "Professional response available" },
    destination: { type: "request", payload: { requestId: 101 } },
  };
}

test(
  "permanent recipient-event identity survives read, dismiss, resolve, archive, and replay",
  { skip: !databaseUrl },
  async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 6 });
    try {
      const migrations = getMigrationFiles();
      const migrated = await runMigrationCollection(pool, migrations, targetMetadata());
      assert.equal(migrated.success, true, migrated.errorCode);
      assert.equal(migrated.applied.length, 64);
      const identities = await createVisitTestIdentities(pool, randomUUID());

      const first = await createCanonicalLifecycleAlertWithClient({
        client: pool,
        ...eventInput(identities.homeownerId),
      });
      assert.equal(first.created, true);
      const alertId = first.alertId;

      const read = await markAlertRead({
        pool,
        recipientUserId: identities.homeownerId,
        alertId,
      });
      assert.equal(read.ok, true);
      assert.deepEqual(
        await createCanonicalLifecycleAlertWithClient({
          client: pool,
          ...eventInput(identities.homeownerId),
        }),
        { alertId, created: false }
      );

      const dismissed = await dismissAlert({
        pool,
        recipientUserId: identities.homeownerId,
        alertId,
      });
      assert.equal(dismissed.ok, true);
      assert.deepEqual(
        await createCanonicalLifecycleAlertWithClient({
          client: pool,
          ...eventInput(identities.homeownerId),
        }),
        { alertId, created: false }
      );

      const resolved = await resolveCanonicalLifecycleAlertsWithClient({
        client: pool,
        sourceDomain: "workflow",
        sourceEntityType: "request",
        sourceEntityId: "101",
        sourceEventTypes: ["request.professional_response_submitted"],
        recipientUserId: identities.homeownerId,
      });
      assert.equal(resolved.count, 1);
      assert.deepEqual(
        await createCanonicalLifecycleAlertWithClient({
          client: pool,
          ...eventInput(identities.homeownerId),
        }),
        { alertId, created: false }
      );

      const archived = await archiveAlert({
        pool,
        recipientUserId: identities.homeownerId,
        alertId,
      });
      assert.equal(archived.ok, true);
      assert.deepEqual(
        await createCanonicalLifecycleAlertWithClient({
          client: pool,
          ...eventInput(identities.homeownerId),
        }),
        { alertId, created: false }
      );

      const secondRecipient = await createCanonicalLifecycleAlertWithClient({
        client: pool,
        ...eventInput(identities.professionalId),
      });
      assert.equal(secondRecipient.created, true);
      assert.notEqual(secondRecipient.alertId, alertId);
      const secondEvent = await createCanonicalLifecycleAlertWithClient({
        client: pool,
        ...eventInput(identities.homeownerId, "event-2"),
      });
      assert.equal(secondEvent.created, true);
      assert.notEqual(secondEvent.alertId, alertId);

      const rows = await pool.query(
        `SELECT recipient_user_id, source_event_id, canonical_event_key, lifecycle_state
         FROM alerts
         WHERE source_entity_type = 'request' AND source_entity_id = '101'
         ORDER BY id`
      );
      assert.equal(rows.rowCount, 3);
      assert.equal(rows.rows[0].lifecycle_state, "archived");
      assert.equal(rows.rows[0].canonical_event_key, rows.rows[1].canonical_event_key);
      assert.notEqual(rows.rows[0].canonical_event_key, rows.rows[2].canonical_event_key);

      await assert.rejects(
        pool.query(
          `INSERT INTO alerts (
            recipient_user_id, source_domain, source_event_type,
            source_entity_type, source_entity_id, source_event_id,
            canonical_event_key, category, priority, title_key, message_key,
            safe_payload, destination_type, destination_payload, dedupe_key
           )
           SELECT recipient_user_id, source_domain, source_event_type,
             source_entity_type, source_entity_id, source_event_id,
             canonical_event_key, category, priority, title_key, message_key,
             safe_payload, destination_type, destination_payload,
             dedupe_key || ':forced-duplicate'
           FROM alerts WHERE id = $1`,
          [alertId]
        ),
        (error) =>
          error?.code === "23505" &&
          error?.constraint === "alerts_recipient_event_identity_uidx"
      );
    } finally {
      await pool.end();
    }
  }
);
