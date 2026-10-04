-- MC-EVALUATION-VISIT-R1-R4-R5-R6B: additive canonical Visit-start
-- authority vocabulary and immutable actual-start evidence.
--
-- This migration expands the existing append-only Visit aggregate only. It
-- creates no Visit, Visit version, Visit event, command, authority grant,
-- activation, Evaluation, Quote, participant, or other business row and
-- performs no backfill or inference for historical Visits.

INSERT INTO lifecycle_capabilities (capability)
VALUES ('visit.start')
ON CONFLICT (capability) DO NOTHING;

ALTER TABLE canonical_visit_versions
ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;

ALTER TABLE canonical_visit_versions
ADD CONSTRAINT canonical_visit_versions_state_r2_check
CHECK (
  state IN (
    'PROPOSED',
    'SCHEDULED',
    'STARTED',
    'CANCELLED',
    'COMPLETED'
  )
) NOT VALID;

ALTER TABLE canonical_visit_versions
VALIDATE CONSTRAINT canonical_visit_versions_state_r2_check;

ALTER TABLE canonical_visit_versions
DROP CONSTRAINT canonical_visit_versions_state_check;

ALTER TABLE canonical_visit_versions
RENAME CONSTRAINT canonical_visit_versions_state_r2_check
TO canonical_visit_versions_state_check;

ALTER TABLE canonical_visit_versions
ADD CONSTRAINT canonical_visit_version_terminal_state_r2_check
CHECK (
  (
    state IN ('PROPOSED', 'SCHEDULED')
    AND cancellation_reason IS NULL
    AND started_at IS NULL
    AND cancelled_at IS NULL
    AND completed_at IS NULL
  )
  OR
  (
    state = 'STARTED'
    AND cancellation_reason IS NULL
    AND started_at IS NOT NULL
    AND cancelled_at IS NULL
    AND completed_at IS NULL
  )
  OR
  (
    state = 'CANCELLED'
    AND cancelled_at IS NOT NULL
    AND completed_at IS NULL
    AND (started_at IS NULL OR started_at <= cancelled_at)
  )
  OR
  (
    state = 'COMPLETED'
    AND cancellation_reason IS NULL
    AND cancelled_at IS NULL
    AND completed_at IS NOT NULL
    AND (started_at IS NULL OR started_at <= completed_at)
  )
) NOT VALID;

ALTER TABLE canonical_visit_versions
VALIDATE CONSTRAINT canonical_visit_version_terminal_state_r2_check;

ALTER TABLE canonical_visit_versions
DROP CONSTRAINT canonical_visit_version_terminal_state_check;

ALTER TABLE canonical_visit_versions
RENAME CONSTRAINT canonical_visit_version_terminal_state_r2_check
TO canonical_visit_version_terminal_state_check;

ALTER TABLE canonical_visit_command_idempotency
ADD CONSTRAINT canonical_visit_command_idempotency_command_name_r3_check
CHECK (
  command_name IN (
    'visit.propose',
    'visit.confirm',
    'visit.change_request',
    'visit.reschedule',
    'visit.cancel',
    'visit.start',
    'visit.complete',
    'visit.link_evaluation'
  )
) NOT VALID;

ALTER TABLE canonical_visit_command_idempotency
VALIDATE CONSTRAINT canonical_visit_command_idempotency_command_name_r3_check;

ALTER TABLE canonical_visit_command_idempotency
DROP CONSTRAINT canonical_visit_command_idempotency_command_name_check;

ALTER TABLE canonical_visit_command_idempotency
RENAME CONSTRAINT canonical_visit_command_idempotency_command_name_r3_check
TO canonical_visit_command_idempotency_command_name_check;

ALTER TABLE canonical_visit_events
ADD COLUMN IF NOT EXISTS start_timing_classification TEXT;

ALTER TABLE canonical_visit_events
ADD COLUMN IF NOT EXISTS schedule_variance_acknowledged BOOLEAN;

ALTER TABLE canonical_visit_events
ADD CONSTRAINT canonical_visit_events_event_type_r3_check
CHECK (
  event_type IN (
    'VISIT_PROPOSED',
    'VISIT_CONFIRMED',
    'VISIT_CHANGE_REQUESTED',
    'VISIT_SCHEDULE_PROPOSED',
    'VISIT_RESCHEDULED',
    'VISIT_CANCELLED',
    'VISIT_STARTED',
    'VISIT_COMPLETED'
  )
) NOT VALID;

ALTER TABLE canonical_visit_events
VALIDATE CONSTRAINT canonical_visit_events_event_type_r3_check;

ALTER TABLE canonical_visit_events
DROP CONSTRAINT canonical_visit_events_event_type_check;

ALTER TABLE canonical_visit_events
RENAME CONSTRAINT canonical_visit_events_event_type_r3_check
TO canonical_visit_events_event_type_check;

ALTER TABLE canonical_visit_events
ADD CONSTRAINT canonical_visit_events_visit_state_r2_check
CHECK (
  visit_state IN (
    'PROPOSED',
    'SCHEDULED',
    'STARTED',
    'CANCELLED',
    'COMPLETED'
  )
) NOT VALID;

ALTER TABLE canonical_visit_events
VALIDATE CONSTRAINT canonical_visit_events_visit_state_r2_check;

ALTER TABLE canonical_visit_events
DROP CONSTRAINT canonical_visit_events_visit_state_check;

ALTER TABLE canonical_visit_events
RENAME CONSTRAINT canonical_visit_events_visit_state_r2_check
TO canonical_visit_events_visit_state_check;

ALTER TABLE canonical_visit_events
ADD CONSTRAINT canonical_visit_event_start_evidence_check
CHECK (
  (
    event_type = 'VISIT_STARTED'
    AND start_timing_classification IS NOT NULL
    AND schedule_variance_acknowledged IS NOT NULL
    AND start_timing_classification IN (
      'WITHIN_EARLY_WINDOW',
      'SAME_DATE_ON_OR_AFTER_SCHEDULE',
      'EARLY_OUTSIDE_WINDOW',
      'DIFFERENT_LOCAL_DATE'
    )
    AND (
      (
        start_timing_classification IN (
          'WITHIN_EARLY_WINDOW',
          'SAME_DATE_ON_OR_AFTER_SCHEDULE'
        )
        AND schedule_variance_acknowledged = FALSE
      )
      OR
      (
        start_timing_classification IN (
          'EARLY_OUTSIDE_WINDOW',
          'DIFFERENT_LOCAL_DATE'
        )
        AND schedule_variance_acknowledged = TRUE
      )
    )
  )
  OR
  (
    event_type <> 'VISIT_STARTED'
    AND start_timing_classification IS NULL
    AND schedule_variance_acknowledged IS NULL
  )
) NOT VALID;

ALTER TABLE canonical_visit_events
VALIDATE CONSTRAINT canonical_visit_event_start_evidence_check;

ALTER TABLE canonical_visit_events
ADD CONSTRAINT canonical_visit_event_transition_shape_r3_check
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
    event_type = 'VISIT_STARTED'
    AND visit_version >= 2
    AND previous_visit_version = visit_version - 1
    AND visit_state = 'STARTED'
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
VALIDATE CONSTRAINT canonical_visit_event_transition_shape_r3_check;

ALTER TABLE canonical_visit_events
DROP CONSTRAINT canonical_visit_event_transition_shape_check;

ALTER TABLE canonical_visit_events
RENAME CONSTRAINT canonical_visit_event_transition_shape_r3_check
TO canonical_visit_event_transition_shape_check;

-- Existing append-only Visit triggers protect the new nullable evidence
-- columns automatically. Historical SCHEDULED-to-COMPLETED records remain
-- valid and retain NULL started_at without fabricated start history.
