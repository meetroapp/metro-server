"use strict";

const {
  requireDatabasePool,
} = require("./alertContracts");

const ALERT_COLUMNS = `
  id,
  recipient_user_id,
  source_domain,
  source_event_type,
  source_entity_type,
  source_entity_id,
  source_event_id,
  category,
  priority,
  title_key,
  message_key,
  safe_payload,
  destination_type,
  destination_payload,
  dedupe_key,
  lifecycle_state,
  available_at,
  expires_at,
  read_at,
  dismissed_at,
  resolved_at,
  archived_at,
  created_at,
  updated_at
`;

async function insertAlertWithClient({ client, alert }) {
  requireDatabasePool(client);

  const result = await client.query(
    `
    INSERT INTO alerts
    (
      recipient_user_id,
      source_domain,
      source_event_type,
      source_entity_type,
      source_entity_id,
      source_event_id,
      category,
      priority,
      title_key,
      message_key,
      safe_payload,
      destination_type,
      destination_payload,
      dedupe_key,
      available_at,
      expires_at
    )
    VALUES (
      $1,
      $2,
      $3,
      $4,
      $5,
      $6,
      $7,
      $8,
      $9,
      $10,
      $11::jsonb,
      $12,
      $13::jsonb,
      $14,
      COALESCE($15::timestamp, CURRENT_TIMESTAMP),
      $16::timestamp
    )
    ON CONFLICT DO NOTHING
    RETURNING ${ALERT_COLUMNS}
    `,
    [
      alert.recipientUserId,
      alert.sourceDomain,
      alert.sourceEventType,
      alert.sourceEntityType,
      alert.sourceEntityId,
      alert.sourceEventId,
      alert.category,
      alert.priority,
      alert.titleKey,
      alert.messageKey,
      JSON.stringify(alert.safePayload),
      alert.destination.type,
      JSON.stringify(alert.destination.payload),
      alert.dedupeKey,
      alert.availableAt,
      alert.expiresAt,
    ]
  );

  if (result.rows[0]) {
    return { row: result.rows[0], created: true };
  }

  const existing = await findActiveAlertByDedupeWithClient({
    client,
    recipientUserId: alert.recipientUserId,
    dedupeKey: alert.dedupeKey,
  });

  return { row: existing, created: false };
}

async function findActiveAlertByDedupeWithClient({
  client,
  recipientUserId,
  dedupeKey,
}) {
  requireDatabasePool(client);
  const result = await client.query(
    `
    SELECT ${ALERT_COLUMNS}
    FROM alerts
    WHERE recipient_user_id = $1
      AND dedupe_key = $2
      AND archived_at IS NULL
      AND resolved_at IS NULL
      AND lifecycle_state IN ('active', 'dismissed')
    ORDER BY id ASC
    LIMIT 1
    `,
    [recipientUserId, dedupeKey]
  );
  return result.rows[0] || null;
}

async function findAlertByRecipientWithClient({
  client,
  alertId,
  recipientUserId,
}) {
  requireDatabasePool(client);
  const result = await client.query(
    `
    SELECT ${ALERT_COLUMNS}
    FROM alerts
    WHERE id = $1
      AND recipient_user_id = $2
      AND archived_at IS NULL
    LIMIT 1
    FOR UPDATE
    `,
    [alertId, recipientUserId]
  );
  return result.rows[0] || null;
}

async function findAnyAlertByRecipientWithClient({
  client,
  alertId,
  recipientUserId,
}) {
  requireDatabasePool(client);
  const result = await client.query(
    `
    SELECT ${ALERT_COLUMNS}
    FROM alerts
    WHERE id = $1
      AND recipient_user_id = $2
    LIMIT 1
    FOR UPDATE
    `,
    [alertId, recipientUserId]
  );
  return result.rows[0] || null;
}

async function listAlertsForRecipientWithClient({
  client,
  recipientUserId,
  category = null,
  priority = null,
  lifecycle = "active",
  unread = null,
  cursor = null,
  limit,
}) {
  requireDatabasePool(client);
  const result = await client.query(
    `
    SELECT ${ALERT_COLUMNS}
    FROM alerts
    WHERE recipient_user_id = $1
      AND lifecycle_state = $2
      AND available_at <= CURRENT_TIMESTAMP
      AND (
        ($2::text = 'archived' AND archived_at IS NOT NULL)
        OR
        ($2::text <> 'archived' AND archived_at IS NULL)
      )
      AND ($3::text IS NULL OR category = $3)
      AND ($4::text IS NULL OR priority = $4)
      AND (
        $5::boolean IS NULL
        OR ($5::boolean = TRUE AND read_at IS NULL)
        OR ($5::boolean = FALSE AND read_at IS NOT NULL)
      )
      AND (
        $6::boolean = FALSE
        OR available_at < $7::timestamp
        OR (available_at = $7::timestamp AND id < $8)
      )
    ORDER BY available_at DESC, id DESC
    LIMIT $9
    `,
    [
      recipientUserId,
      lifecycle,
      category,
      priority,
      unread,
      Boolean(cursor),
      cursor?.availableAt || null,
      cursor?.id || 0,
      limit,
    ]
  );
  return result.rows;
}

async function countAlertsForRecipientWithClient({
  client,
  recipientUserId,
}) {
  requireDatabasePool(client);
  const result = await client.query(
    `
    SELECT
      category,
      COUNT(*)::integer AS active_count,
      COUNT(*) FILTER (WHERE read_at IS NULL)::integer AS unread_count
    FROM alerts
    WHERE recipient_user_id = $1
      AND lifecycle_state = 'active'
      AND archived_at IS NULL
      AND available_at <= CURRENT_TIMESTAMP
    GROUP BY category
    ORDER BY category ASC
    `,
    [recipientUserId]
  );
  return result.rows;
}

async function markAlertsReadThroughCutoffWithClient({
  client,
  recipientUserId,
  category = null,
}) {
  requireDatabasePool(client);
  const result = await client.query(
    `
    WITH cutoff AS (
      SELECT statement_timestamp() AS cutoff_at
    ),
    updated AS (
      UPDATE alerts
      SET
        read_at = cutoff.cutoff_at,
        updated_at = cutoff.cutoff_at
      FROM cutoff
      WHERE recipient_user_id = $1
        AND lifecycle_state = 'active'
        AND archived_at IS NULL
        AND read_at IS NULL
        AND available_at <= cutoff.cutoff_at
        AND ($2::text IS NULL OR category = $2)
      RETURNING 1 AS marked
    )
    SELECT
      cutoff.cutoff_at,
      COUNT(updated.marked)::integer AS marked_read_count
    FROM cutoff
    LEFT JOIN updated ON TRUE
    GROUP BY cutoff.cutoff_at
    `,
    [recipientUserId, category]
  );
  return result.rows[0] || null;
}

async function markAlertReadWithClient({
  client,
  alertId,
  recipientUserId,
  readAt = null,
}) {
  requireDatabasePool(client);
  const result = await client.query(
    `
    UPDATE alerts
    SET
      read_at = COALESCE(read_at, COALESCE($3::timestamp, CURRENT_TIMESTAMP)),
      updated_at = CASE
        WHEN read_at IS NULL THEN CURRENT_TIMESTAMP
        ELSE updated_at
      END
    WHERE id = $1
      AND recipient_user_id = $2
      AND archived_at IS NULL
    RETURNING ${ALERT_COLUMNS}
    `,
    [alertId, recipientUserId, readAt]
  );
  return result.rows[0] || null;
}

async function dismissAlertWithClient({
  client,
  alertId,
  recipientUserId,
  dismissedAt = null,
}) {
  requireDatabasePool(client);
  const result = await client.query(
    `
    UPDATE alerts
    SET
      lifecycle_state = 'dismissed',
      dismissed_at = COALESCE(dismissed_at, COALESCE($3::timestamp, CURRENT_TIMESTAMP)),
      updated_at = CASE
        WHEN lifecycle_state <> 'dismissed' THEN CURRENT_TIMESTAMP
        ELSE updated_at
      END
    WHERE id = $1
      AND recipient_user_id = $2
      AND archived_at IS NULL
      AND lifecycle_state IN ('active', 'dismissed')
      AND priority <> 'critical'
    RETURNING ${ALERT_COLUMNS}
    `,
    [alertId, recipientUserId, dismissedAt]
  );
  return result.rows[0] || null;
}

async function resolveAlertsBySourceWithClient({
  client,
  sourceDomain,
  sourceEntityType,
  sourceEntityId,
  sourceEventType = null,
  recipientUserId = null,
  resolvedAt = null,
}) {
  requireDatabasePool(client);
  const result = await client.query(
    `
    UPDATE alerts
    SET
      lifecycle_state = 'resolved',
      resolved_at = COALESCE(resolved_at, COALESCE($6::timestamp, CURRENT_TIMESTAMP)),
      updated_at = CASE
        WHEN lifecycle_state <> 'resolved' THEN CURRENT_TIMESTAMP
        ELSE updated_at
      END
    WHERE source_domain = $1
      AND source_entity_type = $2
      AND source_entity_id = $3
      AND ($4::text IS NULL OR source_event_type = $4)
      AND ($5::integer IS NULL OR recipient_user_id = $5)
      AND lifecycle_state IN ('active', 'dismissed')
      AND archived_at IS NULL
    RETURNING ${ALERT_COLUMNS}
    `,
    [
      sourceDomain,
      sourceEntityType,
      sourceEntityId,
      sourceEventType,
      recipientUserId,
      resolvedAt,
    ]
  );
  return result.rows;
}

async function expireAlertWithClient({
  client,
  alertId,
  recipientUserId,
  effectiveAt = null,
}) {
  requireDatabasePool(client);
  const result = await client.query(
    `
    UPDATE alerts
    SET
      lifecycle_state = 'expired',
      updated_at = CASE
        WHEN lifecycle_state <> 'expired' THEN CURRENT_TIMESTAMP
        ELSE updated_at
      END
    WHERE id = $1
      AND recipient_user_id = $2
      AND archived_at IS NULL
      AND lifecycle_state IN ('active', 'dismissed', 'expired')
      AND expires_at IS NOT NULL
      AND expires_at <= COALESCE($3::timestamp, CURRENT_TIMESTAMP)
    RETURNING ${ALERT_COLUMNS}
    `,
    [alertId, recipientUserId, effectiveAt]
  );
  return result.rows[0] || null;
}

async function archiveAlertWithClient({
  client,
  alertId,
  recipientUserId,
  archivedAt = null,
}) {
  requireDatabasePool(client);
  const result = await client.query(
    `
    UPDATE alerts
    SET
      lifecycle_state = 'archived',
      archived_at = COALESCE(archived_at, COALESCE($3::timestamp, CURRENT_TIMESTAMP)),
      updated_at = CASE
        WHEN lifecycle_state <> 'archived' THEN CURRENT_TIMESTAMP
        ELSE updated_at
      END
    WHERE id = $1
      AND recipient_user_id = $2
      AND lifecycle_state IN ('resolved', 'expired', 'archived')
    RETURNING ${ALERT_COLUMNS}
    `,
    [alertId, recipientUserId, archivedAt]
  );
  return result.rows[0] || null;
}

module.exports = {
  ALERT_COLUMNS,
  archiveAlertWithClient,
  dismissAlertWithClient,
  expireAlertWithClient,
  findActiveAlertByDedupeWithClient,
  findAnyAlertByRecipientWithClient,
  findAlertByRecipientWithClient,
  insertAlertWithClient,
  listAlertsForRecipientWithClient,
  countAlertsForRecipientWithClient,
  markAlertsReadThroughCutoffWithClient,
  markAlertReadWithClient,
  resolveAlertsBySourceWithClient,
};
