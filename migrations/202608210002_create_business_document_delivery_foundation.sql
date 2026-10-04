CREATE TABLE IF NOT EXISTS business_document_delivery_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_profile_id INTEGER NOT NULL REFERENCES contractor_profiles(id) ON DELETE RESTRICT,
  actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  document_draft_id UUID NULL
    REFERENCES business_document_working_drafts(id) ON DELETE SET NULL,
  source_document_id UUID NOT NULL,
  document_type TEXT NOT NULL CHECK (document_type IN ('QUOTE', 'INVOICE')),
  document_reference TEXT NOT NULL,
  document_version INTEGER NOT NULL CHECK (document_version > 0),
  channel TEXT NOT NULL CHECK (channel IN ('EMAIL', 'MEETRO_MESSAGE')),
  delivery_state TEXT NOT NULL
    CHECK (delivery_state IN ('REQUESTING', 'DELIVERY_REQUESTED', 'SENT', 'FAILED')),
  recipient_email TEXT NULL,
  recipient_user_id INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
  conversation_id INTEGER NULL REFERENCES conversations(id) ON DELETE SET NULL,
  message_id INTEGER NULL REFERENCES messages(id) ON DELETE SET NULL,
  subject TEXT NOT NULL DEFAULT '',
  customer_message TEXT NOT NULL DEFAULT '',
  customer_document_snapshot JSONB NOT NULL,
  snapshot_hash TEXT NOT NULL CHECK (snapshot_hash ~ '^[0-9a-f]{64}$'),
  provider_name TEXT NULL,
  provider_reference TEXT NULL,
  provider_status TEXT NULL,
  failure_code TEXT NULL,
  idempotency_key UUID NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at TIMESTAMPTZ NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (actor_user_id, channel, idempotency_key),
  CHECK (jsonb_typeof(customer_document_snapshot) = 'object'),
  CHECK (
    (
      channel = 'EMAIL'
      AND recipient_email IS NOT NULL
      AND recipient_user_id IS NULL
      AND conversation_id IS NULL
      AND message_id IS NULL
    )
    OR (
      channel = 'MEETRO_MESSAGE'
      AND recipient_email IS NULL
      AND recipient_user_id IS NOT NULL
      AND conversation_id IS NOT NULL
      AND (delivery_state = 'REQUESTING' OR message_id IS NOT NULL)
    )
  )
);

CREATE INDEX IF NOT EXISTS business_document_delivery_events_document_idx
  ON business_document_delivery_events
    (contractor_profile_id, source_document_id, requested_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS business_document_delivery_events_conversation_idx
  ON business_document_delivery_events (conversation_id, requested_at DESC)
  WHERE conversation_id IS NOT NULL;

COMMENT ON TABLE business_document_delivery_events IS
  'Noncanonical delivery evidence for exact saved business-document working-draft versions. Rows never issue, accept, pay, or close canonical records.';
COMMENT ON COLUMN business_document_delivery_events.customer_document_snapshot IS
  'Immutable customer-safe package bound to the saved working-draft version at delivery time; private workspace data is forbidden.';
COMMENT ON COLUMN business_document_delivery_events.source_document_id IS
  'Durable historical document identity retained even if the private working draft is later deleted.';
