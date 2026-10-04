-- Add explicit Emergency relationship provenance for Available Now
-- direct selection without fabricating a professional response.
--
-- Existing Emergency relationships predate direct selection and were created
-- only by the canonical professional Emergency response path. They are
-- therefore backfilled truthfully as professional_response.
--
-- responded_at remains defaulted for the legacy response path but becomes
-- nullable so available_now_direct_select relationships can explicitly record
-- that no professional response occurred.

ALTER TABLE request_relationships
  ADD COLUMN IF NOT EXISTS emergency_authority_source TEXT;

UPDATE request_relationships
SET emergency_authority_source = 'professional_response'
WHERE emergency_request_id IS NOT NULL
  AND emergency_authority_source IS NULL;

-- request_relationships already has DEFERRABLE constraint triggers in deployed
-- databases. The backfill queues those events. Flush them before issuing later
-- ALTER TABLE statements against the same relation so PostgreSQL does not
-- reject the DDL with SQLSTATE 55006 (pending trigger events).
SET CONSTRAINTS ALL IMMEDIATE;

ALTER TABLE request_relationships
  ALTER COLUMN responded_at DROP NOT NULL;

-- Preserve compatibility with a server version that predates this migration.
-- Legacy Emergency response inserts omit emergency_authority_source and retain
-- the responded_at default. Those rows are actual professional responses, so
-- the database may safely normalize that exact legacy shape.
CREATE OR REPLACE FUNCTION
  normalize_emergency_relationship_authority_source()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.emergency_request_id IS NOT NULL
     AND NEW.emergency_authority_source IS NULL
     AND NEW.responded_at IS NOT NULL THEN
    NEW.emergency_authority_source := 'professional_response';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  request_relationships_emergency_authority_source_normalize
ON request_relationships;

CREATE TRIGGER
  request_relationships_emergency_authority_source_normalize
BEFORE INSERT ON request_relationships
FOR EACH ROW
EXECUTE FUNCTION
  normalize_emergency_relationship_authority_source();

ALTER TABLE request_relationships
  DROP CONSTRAINT IF EXISTS
    request_relationships_emergency_authority_source_check;

ALTER TABLE request_relationships
  ADD CONSTRAINT
    request_relationships_emergency_authority_source_check
  CHECK (
    (
      emergency_request_id IS NULL
      AND emergency_authority_source IS NULL
      AND responded_at IS NOT NULL
    )
    OR
    (
      emergency_request_id IS NOT NULL
      AND (
        (
          emergency_authority_source = 'professional_response'
          AND responded_at IS NOT NULL
        )
        OR
        (
          emergency_authority_source =
            'available_now_direct_select'
          AND responded_at IS NULL
          AND status IN ('active', 'closed')
        )
      )
    )
  );

COMMENT ON COLUMN
  request_relationships.emergency_authority_source
IS
  'Emergency-only relationship provenance: professional_response for a business response, or available_now_direct_select for homeowner selection under standing Available Now / dispatch-ready consent. NULL for non-Emergency relationships.';
