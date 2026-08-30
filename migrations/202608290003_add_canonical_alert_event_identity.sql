-- Extend canonical Alerts with permanent lifecycle-event identity and exact
-- protected-resource destinations. Existing rows remain unchanged and
-- Communication Alerts continue to use their active attention-window dedupe.

ALTER TABLE alerts
  ADD COLUMN IF NOT EXISTS canonical_event_key TEXT
    CHECK (
      canonical_event_key IS NULL
      OR canonical_event_key ~ '^[0-9a-f]{64}$'
    );

CREATE UNIQUE INDEX IF NOT EXISTS alerts_recipient_event_identity_uidx
ON alerts (recipient_user_id, canonical_event_key)
WHERE canonical_event_key IS NOT NULL;

ALTER TABLE alerts
  DROP CONSTRAINT IF EXISTS alerts_destination_type_check;

ALTER TABLE alerts
  ADD CONSTRAINT alerts_destination_type_check
    CHECK (
      destination_type IN (
        'conversation',
        'emergency_request',
        'request',
        'project',
        'evaluation',
        'business_profile',
        'review',
        'notifications',
        'job',
        'visit',
        'quote',
        'invoice'
      )
    );
