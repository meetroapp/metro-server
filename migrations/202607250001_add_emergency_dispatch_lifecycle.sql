-- Extend the canonical Emergency request with dispatch lifecycle persistence.
-- Runtime services remain responsible for authorized transitions and immutable
-- timestamp population.

ALTER TABLE emergency_requests
  DROP CONSTRAINT IF EXISTS emergency_requests_status_check;

ALTER TABLE emergency_requests
  ADD COLUMN IF NOT EXISTS en_route_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS arrived_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS work_started_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP;

ALTER TABLE emergency_requests
  ADD CONSTRAINT emergency_requests_status_check
  CHECK (
    status IN (
      'draft',
      'ready_for_distribution',
      'active',
      'selection_pending',
      'assigned',
      'in_service',
      'resolved',
      'cancelled',
      'expired',
      'unable_to_match',
      'safety_blocked',
      'professional_en_route',
      'professional_arrived',
      'work_in_progress',
      'completed'
    )
  );
