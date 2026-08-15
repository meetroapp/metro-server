-- Add canonical Quote delivery identity to Conversation messages without changing
-- the ordinary text-message contract.

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS quote_id UUID,
  ADD COLUMN IF NOT EXISTS job_id UUID,
  ADD COLUMN IF NOT EXISTS delivery_idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS delivery_request_fingerprint TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'messages_quote_job_fk'
      AND conrelid = 'messages'::regclass
  ) THEN
    ALTER TABLE messages
      ADD CONSTRAINT messages_quote_job_fk
      FOREIGN KEY (quote_id, job_id)
      REFERENCES canonical_quotes(id, job_id)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'messages_quote_delivery_shape_check'
      AND conrelid = 'messages'::regclass
  ) THEN
    ALTER TABLE messages
      ADD CONSTRAINT messages_quote_delivery_shape_check
      CHECK (
        (
          message_type = 'quote_shared'
          AND quote_request_id IS NULL
          AND conversation_id IS NOT NULL
          AND quote_id IS NOT NULL
          AND job_id IS NOT NULL
          AND workflow_type = 'QUOTE_SHARED'
          AND workflow_status = 'SENT'
          AND jsonb_typeof(workflow_payload) = 'object'
          AND char_length(delivery_idempotency_key) BETWEEN 1 AND 200
          AND delivery_request_fingerprint ~ '^[0-9a-f]{64}$'
        )
        OR
        (
          message_type <> 'quote_shared'
          AND quote_id IS NULL
          AND job_id IS NULL
          AND delivery_idempotency_key IS NULL
          AND delivery_request_fingerprint IS NULL
        )
      );
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS messages_quote_delivery_idempotency_uidx
  ON messages(sender_id, quote_id, delivery_idempotency_key)
  WHERE message_type = 'quote_shared';

CREATE INDEX IF NOT EXISTS messages_quote_delivery_reference_idx
  ON messages(quote_id, job_id, created_at ASC, id ASC)
  WHERE message_type = 'quote_shared';
