-- Allow messages to use either legacy quote-request or canonical conversation identity.

ALTER TABLE messages
  ALTER COLUMN quote_request_id DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'messages_thread_identity_required'
      AND conrelid = 'messages'::regclass
  ) THEN
    ALTER TABLE messages
      ADD CONSTRAINT messages_thread_identity_required
      CHECK (
        conversation_id IS NOT NULL
        OR quote_request_id IS NOT NULL
      );
  END IF;
END $$;
