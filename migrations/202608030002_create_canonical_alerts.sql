-- Establish canonical recipient-scoped alert persistence.
-- This migration is additive and does not import legacy notifications or
-- create runtime alert producers.

CREATE TABLE IF NOT EXISTS alerts (
  id BIGSERIAL PRIMARY KEY,

  recipient_user_id INTEGER NOT NULL
    REFERENCES users(id)
    ON DELETE CASCADE,

  source_domain TEXT NOT NULL
    CHECK (
      source_domain IN (
        'communication',
        'emergency',
        'workflow',
        'commercial',
        'review',
        'business',
        'system'
      )
    ),

  source_event_type TEXT NOT NULL
    CHECK (char_length(source_event_type) BETWEEN 1 AND 120),

  source_entity_type TEXT NOT NULL
    CHECK (char_length(source_entity_type) BETWEEN 1 AND 120),

  source_entity_id TEXT NOT NULL
    CHECK (char_length(source_entity_id) BETWEEN 1 AND 120),

  source_event_id TEXT
    CHECK (
      source_event_id IS NULL
      OR char_length(source_event_id) BETWEEN 1 AND 120
    ),

  category TEXT NOT NULL
    CHECK (
      category IN (
        'communication',
        'emergency',
        'request',
        'evaluation',
        'proposal',
        'invoice',
        'payment',
        'schedule',
        'work',
        'completion',
        'review',
        'business_verification',
        'system'
      )
    ),

  priority TEXT NOT NULL DEFAULT 'normal'
    CHECK (
      priority IN (
        'critical',
        'high',
        'normal',
        'informational'
      )
    ),

  title_key TEXT NOT NULL
    CHECK (char_length(title_key) BETWEEN 1 AND 160),

  message_key TEXT NOT NULL
    CHECK (char_length(message_key) BETWEEN 1 AND 160),

  safe_payload JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(safe_payload) = 'object'),

  destination_type TEXT NOT NULL,

  destination_payload JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(destination_payload) = 'object'),

  dedupe_key TEXT NOT NULL
    CHECK (char_length(dedupe_key) BETWEEN 1 AND 240),

  lifecycle_state TEXT NOT NULL DEFAULT 'active'
    CHECK (
      lifecycle_state IN (
        'active',
        'dismissed',
        'resolved',
        'expired',
        'archived'
      )
    ),

  available_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP,
  read_at TIMESTAMP,
  dismissed_at TIMESTAMP,
  resolved_at TIMESTAMP,
  archived_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT alerts_destination_type_check
    CHECK (
      destination_type IN (
        'conversation',
        'emergency_request',
        'request',
        'project',
        'evaluation',
        'business_profile',
        'review',
        'notifications'
      )
    ),

  CONSTRAINT alerts_dismissed_state_timestamp_check
    CHECK (
      lifecycle_state <> 'dismissed'
      OR dismissed_at IS NOT NULL
    ),

  CONSTRAINT alerts_resolved_state_timestamp_check
    CHECK (
      lifecycle_state <> 'resolved'
      OR resolved_at IS NOT NULL
    ),

  CONSTRAINT alerts_expired_state_timestamp_check
    CHECK (
      lifecycle_state <> 'expired'
      OR expires_at IS NOT NULL
    ),

  CONSTRAINT alerts_archived_state_timestamp_check
    CHECK (
      lifecycle_state <> 'archived'
      OR archived_at IS NOT NULL
    ),

  CONSTRAINT alerts_read_after_creation_check
    CHECK (
      read_at IS NULL
      OR read_at >= created_at
    ),

  CONSTRAINT alerts_dismissed_after_creation_check
    CHECK (
      dismissed_at IS NULL
      OR dismissed_at >= created_at
    ),

  CONSTRAINT alerts_resolved_after_creation_check
    CHECK (
      resolved_at IS NULL
      OR resolved_at >= created_at
    ),

  CONSTRAINT alerts_archived_after_creation_check
    CHECK (
      archived_at IS NULL
      OR archived_at >= created_at
    ),

  CONSTRAINT alerts_expires_after_creation_check
    CHECK (
      expires_at IS NULL
      OR expires_at >= created_at
    )
);

CREATE INDEX IF NOT EXISTS alerts_recipient_active_idx
ON alerts (
  recipient_user_id,
  lifecycle_state,
  available_at DESC,
  id DESC
)
WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS alerts_recipient_unread_idx
ON alerts (
  recipient_user_id,
  category,
  available_at DESC,
  id DESC
)
WHERE read_at IS NULL
  AND archived_at IS NULL
  AND lifecycle_state = 'active';

CREATE INDEX IF NOT EXISTS alerts_source_lookup_idx
ON alerts (
  source_domain,
  source_event_type,
  source_entity_type,
  source_entity_id
);

CREATE INDEX IF NOT EXISTS alerts_resolution_idx
ON alerts (
  source_domain,
  source_entity_type,
  source_entity_id,
  lifecycle_state
)
WHERE lifecycle_state IN ('active', 'dismissed');

CREATE INDEX IF NOT EXISTS alerts_expiration_idx
ON alerts (expires_at)
WHERE expires_at IS NOT NULL
  AND archived_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS alerts_active_dedupe_uidx
ON alerts (
  recipient_user_id,
  dedupe_key
)
WHERE archived_at IS NULL
  AND resolved_at IS NULL
  AND lifecycle_state IN ('active', 'dismissed');
