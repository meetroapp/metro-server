-- Create the disabled canonical Emergency aggregate foundation.
-- No public API or runtime activation is introduced by this migration.

CREATE TABLE IF NOT EXISTS emergency_requests (
  id SERIAL PRIMARY KEY,

  homeowner_id INTEGER NOT NULL
    REFERENCES users(id)
    ON DELETE RESTRICT,

  category TEXT NOT NULL,
  service_domain TEXT NOT NULL,
  service_specialty TEXT NOT NULL,

  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  location_text TEXT NOT NULL,
  unit_number TEXT NOT NULL DEFAULT '',
  access_notes TEXT NOT NULL DEFAULT '',

  status TEXT NOT NULL DEFAULT 'draft',

  requested_at TIMESTAMP,
  assigned_at TIMESTAMP,
  resolved_at TIMESTAMP,
  cancelled_at TIMESTAMP,
  expired_at TIMESTAMP,

  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT emergency_requests_status_check
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
        'safety_blocked'
      )
    )
);

CREATE INDEX IF NOT EXISTS emergency_requests_homeowner_idx
ON emergency_requests(homeowner_id, created_at DESC);

CREATE INDEX IF NOT EXISTS emergency_requests_status_service_idx
ON emergency_requests(
  status,
  service_domain,
  service_specialty,
  created_at DESC
);
