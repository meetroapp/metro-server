-- MC-EVALUATION-VISIT-R1-R2: correct Evaluation Visit authority ordering and
-- preserve exact, immutable alternate-schedule proposals in the canonical
-- Visit engine.
--
-- This migration adds vocabulary and an active-grant lookup index only. It
-- creates no authority grant, Visit, Visit version/event, Evaluation, link,
-- Relationship, Job, or other business row, and performs no backfill.

ALTER TABLE lifecycle_authority_grants
ADD CONSTRAINT lifecycle_authority_grants_scope_type_r2_check
CHECK (
  scope_type IN (
    'job',
    'reported_concern',
    'evaluation',
    'approved_work',
    'evaluation_visit'
  )
) NOT VALID;

ALTER TABLE lifecycle_authority_grants
VALIDATE CONSTRAINT lifecycle_authority_grants_scope_type_r2_check;

ALTER TABLE lifecycle_authority_grants
DROP CONSTRAINT lifecycle_authority_grants_scope_type_check;

ALTER TABLE lifecycle_authority_grants
RENAME CONSTRAINT lifecycle_authority_grants_scope_type_r2_check
TO lifecycle_authority_grants_scope_type_check;

ALTER TABLE lifecycle_authority_grants
ADD CONSTRAINT lifecycle_authority_grants_scope_shape_r2_check
CHECK (
  (
    scope_type = 'job'
    AND scope_concern_id IS NULL
    AND scope_evaluation_id IS NULL
    AND scope_approved_quote_decision_id IS NULL
    AND scope_approved_quote_decision IS NULL
  )
  OR
  (
    scope_type = 'reported_concern'
    AND scope_concern_id IS NOT NULL
    AND scope_evaluation_id IS NULL
    AND scope_approved_quote_decision_id IS NULL
    AND scope_approved_quote_decision IS NULL
  )
  OR
  (
    scope_type = 'evaluation'
    AND scope_concern_id IS NULL
    AND scope_evaluation_id IS NOT NULL
    AND scope_approved_quote_decision_id IS NULL
    AND scope_approved_quote_decision IS NULL
  )
  OR
  (
    scope_type = 'approved_work'
    AND scope_concern_id IS NULL
    AND scope_evaluation_id IS NULL
    AND scope_approved_quote_decision_id IS NOT NULL
    AND scope_approved_quote_decision = 'APPROVED'
  )
  OR
  (
    scope_type = 'evaluation_visit'
    AND scope_job_id = job_id
    AND scope_concern_id IS NULL
    AND scope_evaluation_id IS NULL
    AND scope_approved_quote_decision_id IS NULL
    AND scope_approved_quote_decision IS NULL
  )
) NOT VALID;

ALTER TABLE lifecycle_authority_grants
VALIDATE CONSTRAINT lifecycle_authority_grants_scope_shape_r2_check;

ALTER TABLE lifecycle_authority_grants
DROP CONSTRAINT lifecycle_authority_grants_scope_shape_check;

ALTER TABLE lifecycle_authority_grants
RENAME CONSTRAINT lifecycle_authority_grants_scope_shape_r2_check
TO lifecycle_authority_grants_scope_shape_check;

ALTER TABLE canonical_visit_command_idempotency
ADD CONSTRAINT canonical_visit_command_idempotency_command_name_r2_check
CHECK (
  command_name IN (
    'visit.propose',
    'visit.confirm',
    'visit.change_request',
    'visit.reschedule',
    'visit.cancel',
    'visit.complete',
    'visit.link_evaluation'
  )
) NOT VALID;

ALTER TABLE canonical_visit_command_idempotency
VALIDATE CONSTRAINT canonical_visit_command_idempotency_command_name_r2_check;

ALTER TABLE canonical_visit_command_idempotency
DROP CONSTRAINT canonical_visit_command_idempotency_command_name_check;

ALTER TABLE canonical_visit_command_idempotency
RENAME CONSTRAINT canonical_visit_command_idempotency_command_name_r2_check
TO canonical_visit_command_idempotency_command_name_check;

ALTER TABLE canonical_visit_events
ADD CONSTRAINT canonical_visit_events_event_type_r2_check
CHECK (
  event_type IN (
    'VISIT_PROPOSED',
    'VISIT_CONFIRMED',
    'VISIT_CHANGE_REQUESTED',
    'VISIT_SCHEDULE_PROPOSED',
    'VISIT_RESCHEDULED',
    'VISIT_CANCELLED',
    'VISIT_COMPLETED'
  )
) NOT VALID;

ALTER TABLE canonical_visit_events
VALIDATE CONSTRAINT canonical_visit_events_event_type_r2_check;

ALTER TABLE canonical_visit_events
DROP CONSTRAINT canonical_visit_events_event_type_check;

ALTER TABLE canonical_visit_events
RENAME CONSTRAINT canonical_visit_events_event_type_r2_check
TO canonical_visit_events_event_type_check;

ALTER TABLE canonical_visit_events
ADD CONSTRAINT canonical_visit_event_transition_shape_r2_check
CHECK (
  (
    event_type = 'VISIT_PROPOSED'
    AND visit_version = 1
    AND previous_visit_version IS NULL
    AND visit_state = 'PROPOSED'
  )
  OR
  (
    event_type = 'VISIT_CHANGE_REQUESTED'
    AND previous_visit_version = visit_version
    AND visit_state IN ('PROPOSED', 'SCHEDULED')
  )
  OR
  (
    event_type = 'VISIT_SCHEDULE_PROPOSED'
    AND visit_version >= 2
    AND previous_visit_version = visit_version - 1
    AND visit_state = 'PROPOSED'
  )
  OR
  (
    event_type = 'VISIT_CONFIRMED'
    AND visit_version >= 2
    AND previous_visit_version = visit_version - 1
    AND visit_state = 'SCHEDULED'
  )
  OR
  (
    event_type = 'VISIT_RESCHEDULED'
    AND visit_version >= 2
    AND previous_visit_version = visit_version - 1
    AND visit_state = 'SCHEDULED'
  )
  OR
  (
    event_type = 'VISIT_CANCELLED'
    AND visit_version >= 2
    AND previous_visit_version = visit_version - 1
    AND visit_state = 'CANCELLED'
  )
  OR
  (
    event_type = 'VISIT_COMPLETED'
    AND visit_version >= 2
    AND previous_visit_version = visit_version - 1
    AND visit_state = 'COMPLETED'
  )
) NOT VALID;

ALTER TABLE canonical_visit_events
VALIDATE CONSTRAINT canonical_visit_event_transition_shape_r2_check;

ALTER TABLE canonical_visit_events
DROP CONSTRAINT canonical_visit_event_transition_shape_check;

ALTER TABLE canonical_visit_events
RENAME CONSTRAINT canonical_visit_event_transition_shape_r2_check
TO canonical_visit_event_transition_shape_check;

CREATE INDEX IF NOT EXISTS lifecycle_authority_grants_evaluation_visit_scope_idx
ON lifecycle_authority_grants(
  grantee_participant_id,
  job_id,
  capability,
  valid_from ASC,
  id ASC
)
WHERE scope_type = 'evaluation_visit' AND valid_until IS NULL;

-- Purpose-specific enforcement belongs at the future Evaluation Visit command
-- boundary: evaluation_visit authorizes only canonical Visits whose purpose is
-- EVALUATION. It must never authorize APPROVED_WORK or FOLLOW_UP scheduling.
--
-- Communication Center coordinates scheduling, Work Center / Schedule manages
-- the canonical operational Visit, and Business Dashboard derives attention
-- from that same Visit identity, version, and state. No surface- or
-- device-specific scheduling authority is introduced here.
