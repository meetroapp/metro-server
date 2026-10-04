-- MC-U1-HOMEOWNER-EDIT-003A: server-owned request modification authority,
-- optimistic request versioning, and append-only post-reliance photo evidence.

ALTER TABLE posts
  ADD COLUMN IF NOT EXISTS modification_version INTEGER NOT NULL DEFAULT 1;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'posts_modification_version_check'
  ) THEN
    ALTER TABLE posts
      ADD CONSTRAINT posts_modification_version_check
      CHECK (modification_version >= 1);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS jobs_identity_request_uidx
ON jobs(id, job_request_id);

CREATE TABLE IF NOT EXISTS request_photo_attachment_events (
  id UUID PRIMARY KEY,

  request_id INTEGER NOT NULL,
  concern_id UUID NOT NULL,
  job_id UUID,
  actor_user_id INTEGER NOT NULL
    REFERENCES users(id)
    ON DELETE RESTRICT,

  request_version INTEGER NOT NULL
    CHECK (request_version >= 2),

  public_id TEXT NOT NULL UNIQUE
    CHECK (char_length(btrim(public_id)) BETWEEN 1 AND 500),
  secure_url TEXT NOT NULL
    CHECK (secure_url ~ '^https://res\.cloudinary\.com/'),
  media_payload JSONB NOT NULL
    CHECK (jsonb_typeof(media_payload) = 'object'),

  idempotency_key TEXT NOT NULL
    CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  request_fingerprint TEXT NOT NULL
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),

  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT request_photo_attachment_request_fk
    FOREIGN KEY (request_id)
    REFERENCES posts(id)
    ON DELETE RESTRICT,

  CONSTRAINT request_photo_attachment_concern_request_fk
    FOREIGN KEY (concern_id, request_id)
    REFERENCES reported_concerns(id, job_request_id)
    ON DELETE RESTRICT,

  CONSTRAINT request_photo_attachment_job_request_fk
    FOREIGN KEY (job_id, request_id)
    REFERENCES jobs(id, job_request_id)
    ON DELETE RESTRICT,

  CONSTRAINT request_photo_attachment_command_key
    UNIQUE (actor_user_id, request_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS request_photo_attachment_request_order_idx
ON request_photo_attachment_events(request_id, created_at ASC, id ASC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'request_photo_attachment_events_append_only'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER request_photo_attachment_events_append_only
    BEFORE UPDATE OR DELETE ON request_photo_attachment_events
    FOR EACH ROW
    EXECUTE FUNCTION prevent_lifecycle_append_only_mutation();
  END IF;
END $$;
