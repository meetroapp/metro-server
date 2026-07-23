-- Create the normalized Emergency safety-assessment foundation.
-- This migration does not expose routes, distribute requests, contact emergency
-- services, create professional candidates, or activate Emergency.

CREATE TABLE IF NOT EXISTS emergency_request_safety_assessments (
  id SERIAL PRIMARY KEY,

  emergency_request_id INTEGER NOT NULL
    REFERENCES emergency_requests(id)
    ON DELETE RESTRICT,

  immediate_danger BOOLEAN NOT NULL,
  medical_emergency BOOLEAN NOT NULL,
  fire_or_smoke BOOLEAN NOT NULL,
  gas_odor_or_suspected_leak BOOLEAN NOT NULL,
  active_crime_or_threat BOOLEAN NOT NULL,
  electrical_immediate_hazard BOOLEAN NOT NULL,
  structural_collapse_risk BOOLEAN NOT NULL,
  flooding_or_water_damage BOOLEAN NOT NULL,
  occupants_unable_to_exit BOOLEAN NOT NULL,
  emergency_services_contacted BOOLEAN NOT NULL,
  safe_to_remain_at_location BOOLEAN NOT NULL,

  additional_safety_context TEXT NOT NULL DEFAULT '',
  disposition TEXT NOT NULL,

  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT emergency_request_safety_assessments_one_per_request
    UNIQUE (emergency_request_id),

  CONSTRAINT emergency_request_safety_assessments_disposition_check
    CHECK (
      disposition IN (
        'continue',
        'contact_emergency_services',
        'leave_location',
        'manual_review'
      )
    ),

  CONSTRAINT emergency_request_safety_context_length_check
    CHECK (char_length(additional_safety_context) <= 2000)
);

CREATE INDEX IF NOT EXISTS
  emergency_request_safety_assessments_disposition_idx
ON emergency_request_safety_assessments(
  disposition,
  updated_at DESC
);
