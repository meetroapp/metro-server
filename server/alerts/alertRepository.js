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
  canonical_event_key,
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
      canonical_event_key,
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
      $11,
      $12::jsonb,
      $13,
      $14::jsonb,
      $15,
      COALESCE($16::timestamp, CURRENT_TIMESTAMP),
      $17::timestamp
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
      alert.canonicalEventKey,
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

  if (alert.canonicalEventKey) {
    const existingEvent = await findAlertByCanonicalEventWithClient({
      client,
      recipientUserId: alert.recipientUserId,
      canonicalEventKey: alert.canonicalEventKey,
    });
    return { row: existingEvent, created: false };
  }

  const existing = await findActiveAlertByDedupeWithClient({
    client,
    recipientUserId: alert.recipientUserId,
    dedupeKey: alert.dedupeKey,
  });

  return { row: existing, created: false };
}

async function findAlertByCanonicalEventWithClient({
  client,
  recipientUserId,
  canonicalEventKey,
}) {
  requireDatabasePool(client);
  const result = await client.query(
    `
    SELECT ${ALERT_COLUMNS}
    FROM alerts
    WHERE recipient_user_id = $1
      AND canonical_event_key = $2
    ORDER BY id ASC
    LIMIT 1
    `,
    [recipientUserId, canonicalEventKey]
  );
  return result.rows[0] || null;
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

async function countCommunicationAttentionForRecipientWithClient({
  client,
  recipientUserId,
}) {
  requireDatabasePool(client);
  const result = await client.query(
    `/* alerts:communication_attention_counts */
    WITH unread_alerts AS (
      SELECT *
        FROM alerts
       WHERE recipient_user_id = $1
         AND lifecycle_state = 'active'
         AND archived_at IS NULL
         AND read_at IS NULL
         AND available_at <= CURRENT_TIMESTAMP
    ),
    team_attention AS (
      SELECT DISTINCT
        alerts.id AS alert_id,
        messages.contractor_profile_id AS business_id,
        messages.job_id,
        NULL::integer AS conversation_id,
        'team'::text AS audience
      FROM unread_alerts alerts
      JOIN business_job_field_messages messages
        ON messages.id::text = alerts.source_entity_id
       AND messages.id::text = alerts.source_event_id
      JOIN business_job_assignments assignments
        ON assignments.id = messages.assignment_id
       AND assignments.contractor_profile_id = messages.contractor_profile_id
       AND assignments.job_id = messages.job_id
       AND assignments.membership_id = messages.membership_id
       AND assignments.state = 'ACTIVE'
      JOIN business_team_memberships assigned_memberships
        ON assigned_memberships.id = assignments.membership_id
       AND assigned_memberships.contractor_profile_id = assignments.contractor_profile_id
       AND assigned_memberships.status = 'ACTIVE'
       AND assigned_memberships.role = 'FIELD_EMPLOYEE'
      JOIN business_team_memberships senders
        ON senders.id = messages.sender_membership_id
       AND senders.contractor_profile_id = messages.contractor_profile_id
       AND senders.user_id = messages.sender_user_id
       AND senders.status = 'ACTIVE'
      JOIN jobs
        ON jobs.id = assignments.job_id
       AND jobs.lifecycle_contract_version = 2
      WHERE alerts.source_domain = 'business'
        AND alerts.source_event_type = 'job.field_message.received'
        AND alerts.source_entity_type = 'business_job_field_message'
        AND alerts.category = 'work'
        AND alerts.destination_type = 'job'
        AND alerts.destination_payload = jsonb_build_object('jobId', messages.job_id)
        AND EXISTS (
          SELECT 1
            FROM business_job_assignment_events activation_events
           WHERE activation_events.assignment_id = assignments.id
             AND activation_events.contractor_profile_id = assignments.contractor_profile_id
             AND activation_events.job_id = assignments.job_id
             AND activation_events.membership_id = assignments.membership_id
             AND activation_events.event_type IN ('ASSIGNED', 'REASSIGNED')
        )
        AND (
          (
            senders.role IN ('OWNER', 'MANAGER')
            AND assigned_memberships.user_id = $1
          )
          OR (
            senders.role = 'FIELD_EMPLOYEE'
            AND senders.id = assigned_memberships.id
            AND EXISTS (
              SELECT 1
                FROM business_team_memberships recipients
               WHERE recipients.user_id = $1
                 AND recipients.contractor_profile_id = messages.contractor_profile_id
                 AND recipients.status = 'ACTIVE'
                 AND recipients.role IN ('OWNER', 'MANAGER')
            )
          )
        )
    ),
    customer_participant_attention AS (
      SELECT DISTINCT
        alerts.id AS alert_id,
        conversations.contractor_id AS business_id,
        NULL::uuid AS job_id,
        conversations.id AS conversation_id,
        'customer'::text AS audience
      FROM unread_alerts alerts
      JOIN messages
        ON messages.id::text = alerts.source_event_id
       AND messages.conversation_id::text = alerts.source_entity_id
      JOIN conversations
        ON conversations.id = messages.conversation_id
      WHERE alerts.source_domain = 'communication'
        AND alerts.source_event_type = 'conversation.message_created'
        AND alerts.source_entity_type = 'conversation'
        AND alerts.category = 'communication'
        AND alerts.destination_type = 'conversation'
        AND alerts.destination_payload = jsonb_build_object('conversationId', conversations.id)
        AND alerts.recipient_user_id IN (
          conversations.homeowner_id,
          conversations.professional_user_id
        )
    ),
    field_customer_candidates AS (
      SELECT DISTINCT
        alerts.id AS alert_id,
        profiles.id AS business_id,
        jobs.id AS job_id,
        conversations.id AS conversation_id,
        assignments.id AS assignment_id,
        'customer'::text AS audience
      FROM unread_alerts alerts
      JOIN messages
        ON messages.id::text = alerts.source_event_id
       AND messages.conversation_id::text = alerts.source_entity_id
      JOIN conversations
        ON conversations.id = messages.conversation_id
       AND messages.sender_id = conversations.homeowner_id
       AND messages.receiver_id = conversations.professional_user_id
      JOIN request_selections selections
        ON selections.id = conversations.request_selection_id
       AND selections.conversation_id = conversations.id
       AND selections.ended_at IS NULL
      JOIN request_relationships relationships
        ON relationships.id = conversations.relationship_id
       AND relationships.id = selections.request_relationship_id
       AND relationships.status = 'active'
       AND relationships.emergency_request_id IS NULL
      JOIN contractor_profiles profiles
        ON profiles.id = conversations.contractor_id
       AND profiles.id = selections.contractor_id
       AND profiles.user_id = conversations.professional_user_id
      JOIN jobs
        ON jobs.source_request_selection_id = selections.id
       AND jobs.source_request_relationship_id = relationships.id
       AND jobs.lifecycle_contract_version = 2
      JOIN business_job_assignments assignments
        ON assignments.job_id = jobs.id
       AND assignments.contractor_profile_id = profiles.id
       AND assignments.state = 'ACTIVE'
      JOIN business_team_memberships memberships
        ON memberships.id = assignments.membership_id
       AND memberships.contractor_profile_id = assignments.contractor_profile_id
       AND memberships.user_id = $1
       AND memberships.status = 'ACTIVE'
       AND memberships.role = 'FIELD_EMPLOYEE'
      WHERE alerts.source_domain = 'communication'
        AND alerts.source_event_type = 'conversation.message_created'
        AND alerts.source_entity_type = 'conversation'
        AND alerts.category = 'communication'
        AND alerts.destination_type = 'conversation'
        AND alerts.destination_payload = jsonb_build_object('conversationId', conversations.id)
        AND alerts.recipient_user_id NOT IN (
          conversations.homeowner_id,
          conversations.professional_user_id
        )
        AND EXISTS (
          SELECT 1
            FROM business_job_assignment_events activation_events
           WHERE activation_events.assignment_id = assignments.id
             AND activation_events.contractor_profile_id = assignments.contractor_profile_id
             AND activation_events.job_id = assignments.job_id
             AND activation_events.membership_id = assignments.membership_id
             AND activation_events.event_type IN ('ASSIGNED', 'REASSIGNED')
        )
    ),
    field_customer_attention AS (
      SELECT alert_id, business_id, job_id, conversation_id, audience
        FROM (
          SELECT candidates.*,
                 COUNT(*) OVER (PARTITION BY alert_id) AS candidate_count
            FROM field_customer_candidates candidates
        ) scoped
       WHERE candidate_count = 1
    ),
    communication_attention AS (
      SELECT * FROM team_attention
      UNION ALL
      SELECT * FROM customer_participant_attention
      UNION ALL
      SELECT * FROM field_customer_attention
    )
    SELECT
      audience,
      business_id,
      job_id,
      conversation_id,
      COUNT(DISTINCT alert_id)::integer AS unread_count
    FROM communication_attention
    GROUP BY audience, business_id, job_id, conversation_id
    ORDER BY audience, business_id, job_id, conversation_id`,
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
  findAlertByCanonicalEventWithClient,
  findAnyAlertByRecipientWithClient,
  findAlertByRecipientWithClient,
  insertAlertWithClient,
  listAlertsForRecipientWithClient,
  countAlertsForRecipientWithClient,
  countCommunicationAttentionForRecipientWithClient,
  markAlertsReadThroughCutoffWithClient,
  markAlertReadWithClient,
  resolveAlertsBySourceWithClient,
};
