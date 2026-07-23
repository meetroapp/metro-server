-- Allow canonical request relationships to reference exactly one governed
-- aggregate source while preserving all existing post-backed relationships.

ALTER TABLE request_relationships
  ADD COLUMN IF NOT EXISTS emergency_request_id INTEGER
    REFERENCES emergency_requests(id)
    ON DELETE RESTRICT;

ALTER TABLE request_relationships
  ALTER COLUMN post_id DROP NOT NULL;

ALTER TABLE request_relationships
  DROP CONSTRAINT IF EXISTS request_relationships_unique_response;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'request_relationships_exactly_one_source'
      AND conrelid = 'request_relationships'::regclass
  ) THEN
    ALTER TABLE request_relationships
      ADD CONSTRAINT request_relationships_exactly_one_source
      CHECK (
        (
          post_id IS NOT NULL
          AND emergency_request_id IS NULL
        )
        OR
        (
          post_id IS NULL
          AND emergency_request_id IS NOT NULL
        )
      );
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS
  request_relationships_unique_post_response
ON request_relationships(post_id, contractor_id)
WHERE post_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS
  request_relationships_unique_emergency_response
ON request_relationships(emergency_request_id, contractor_id)
WHERE emergency_request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS
  request_relationships_emergency_request_idx
ON request_relationships(emergency_request_id)
WHERE emergency_request_id IS NOT NULL;
