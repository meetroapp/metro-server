-- Add the minimum authoritative lifecycle for generic Request Help records.

ALTER TABLE posts
  ADD COLUMN IF NOT EXISTS request_category TEXT,
  ADD COLUMN IF NOT EXISTS service_domain TEXT,
  ADD COLUMN IF NOT EXISTS service_specialty TEXT,
  ADD COLUMN IF NOT EXISTS unit_number TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS access_notes TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'open',
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMP;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'posts_request_status_check'
  ) THEN
    ALTER TABLE posts
      ADD CONSTRAINT posts_request_status_check
      CHECK (status IN ('open', 'cancelled'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_posts_open_service_projection
  ON posts (status, service_domain, service_specialty, created_at DESC);
