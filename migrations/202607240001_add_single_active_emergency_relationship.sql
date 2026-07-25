-- Enforce one active professional relationship for each canonical Emergency
-- request. The index is intentionally limited to Emergency-backed active
-- relationships and does not alter post-backed relationship behavior.
--
-- Existing duplicate active Emergency relationships cause index creation to
-- fail closed. This migration never rewrites, deletes, or chooses among
-- conflicting authoritative records.

CREATE UNIQUE INDEX IF NOT EXISTS
  request_relationships_one_active_emergency
ON request_relationships(emergency_request_id)
WHERE emergency_request_id IS NOT NULL
  AND status = 'active';
