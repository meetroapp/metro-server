-- MC-PL-002A: additive canonical Visit persistence foundation.
-- A Job may own many Visits. Visit purpose, scheduling state, and history are
-- independent from Evaluation, Quote, Workstream, Activity, and Job state.
-- This migration registers future capabilities but grants none, creates no
-- Visit rows, and performs no inference or backfill from existing records.

INSERT INTO lifecycle_capabilities (capability)
VALUES
  ('visit.read'),
  ('visit.propose'),
  ('visit.confirm'),
  ('visit.change_request'),
  ('visit.reschedule'),
  ('visit.cancel'),
  ('visit.complete')
ON CONFLICT (capability) DO NOTHING;

CREATE TABLE IF NOT EXISTS canonical_visit_command_idempotency (
  id UUID PRIMARY KEY,

  actor_participant_id UUID NOT NULL,
  job_id UUID NOT NULL,

  command_name TEXT NOT NULL
    CHECK (
      command_name IN (
        'visit.propose',
        'visit.confirm',
        'visit.change_request',
        'visit.reschedule',
        'visit.cancel',
        'visit.complete'
      )
    ),

  command_scope TEXT NOT NULL
    CHECK (char_length(btrim(command_scope)) BETWEEN 1 AND 300),

  idempotency_key TEXT NOT NULL
    CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),

  request_fingerprint TEXT NOT NULL
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),

  result_reference JSONB,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT canonical_visit_command_actor_fk
    FOREIGN KEY (actor_participant_id, job_id)
    REFERENCES relationship_participants(id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_visit_command_result_check
    CHECK (
      (
        result_reference IS NULL
        AND completed_at IS NULL
      )
      OR
      (
        result_reference IS NOT NULL
        AND jsonb_typeof(result_reference) = 'object'
        AND completed_at IS NOT NULL
      )
    ),

  CONSTRAINT canonical_visit_command_key
    UNIQUE (
      actor_participant_id,
      command_name,
      command_scope,
      idempotency_key
    ),

  CONSTRAINT canonical_visit_command_identity_actor_job_key
    UNIQUE (id, actor_participant_id, job_id)
);

CREATE INDEX IF NOT EXISTS canonical_visit_command_job_idx
ON canonical_visit_command_idempotency(
  job_id,
  command_name,
  created_at DESC,
  id DESC
);

-- This non-partial identity permits an APPROVED_WORK Visit to reference the
-- exact immutable customer decision and prove that the decision belongs to
-- the same Job. The Visit FK also carries the constrained APPROVED value, so
-- an ISSUED Quote or DECLINED decision cannot satisfy approved-work evidence.
CREATE UNIQUE INDEX IF NOT EXISTS
  canonical_quote_customer_decision_visit_evidence_uidx
ON canonical_quote_customer_decisions(id, job_id, decision);

CREATE TABLE IF NOT EXISTS canonical_visits (
  id UUID PRIMARY KEY,

  job_id UUID NOT NULL
    REFERENCES jobs(id)
    ON DELETE RESTRICT,

  purpose TEXT NOT NULL
    CHECK (
      purpose IN (
        'EVALUATION',
        'APPROVED_WORK',
        'FOLLOW_UP'
      )
    ),

  created_by_participant_id UUID NOT NULL,
  created_command_idempotency_id UUID NOT NULL UNIQUE,

  approved_quote_decision_id UUID,
  approved_quote_decision TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT canonical_visit_creator_fk
    FOREIGN KEY (created_by_participant_id, job_id)
    REFERENCES relationship_participants(id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_visit_create_command_fk
    FOREIGN KEY (
      created_command_idempotency_id,
      created_by_participant_id,
      job_id
    )
    REFERENCES canonical_visit_command_idempotency(
      id,
      actor_participant_id,
      job_id
    )
    ON DELETE RESTRICT,

  CONSTRAINT canonical_visit_approved_work_evidence_shape_check
    CHECK (
      (
        purpose = 'APPROVED_WORK'
        AND approved_quote_decision_id IS NOT NULL
        AND approved_quote_decision = 'APPROVED'
      )
      OR
      (
        purpose IN ('EVALUATION', 'FOLLOW_UP')
        AND approved_quote_decision_id IS NULL
        AND approved_quote_decision IS NULL
      )
    ),

  CONSTRAINT canonical_visit_approved_work_evidence_fk
    FOREIGN KEY (
      approved_quote_decision_id,
      job_id,
      approved_quote_decision
    )
    REFERENCES canonical_quote_customer_decisions(
      id,
      job_id,
      decision
    )
    ON DELETE RESTRICT,

  CONSTRAINT canonical_visit_job_identity_key
    UNIQUE (id, job_id),

  CONSTRAINT canonical_visit_job_purpose_identity_key
    UNIQUE (id, job_id, purpose)
);

CREATE INDEX IF NOT EXISTS canonical_visit_job_created_idx
ON canonical_visits(job_id, created_at ASC, id ASC);

CREATE INDEX IF NOT EXISTS canonical_visit_approved_decision_idx
ON canonical_visits(approved_quote_decision_id, job_id)
WHERE approved_quote_decision_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS canonical_visit_versions (
  visit_id UUID NOT NULL,
  version INTEGER NOT NULL
    CHECK (version >= 1),
  job_id UUID NOT NULL,

  state TEXT NOT NULL
    CHECK (
      state IN (
        'PROPOSED',
        'SCHEDULED',
        'CANCELLED',
        'COMPLETED'
      )
    ),

  scheduled_start_at TIMESTAMPTZ NOT NULL,
  scheduled_end_at TIMESTAMPTZ,

  -- PostgreSQL stores the scheduled instants as TIMESTAMPTZ. This field
  -- preserves the authoritative IANA zone selected at the future command
  -- boundary. MC-PL-002B owns IANA membership and DST ambiguity validation.
  time_zone TEXT NOT NULL
    CHECK (char_length(btrim(time_zone)) BETWEEN 1 AND 100),

  location_mode TEXT NOT NULL
    CHECK (location_mode IN ('JOB_SERVICE_LOCATION', 'REMOTE')),

  cancellation_reason TEXT
    CHECK (
      cancellation_reason IS NULL
      OR char_length(btrim(cancellation_reason)) BETWEEN 1 AND 2000
    ),
  cancelled_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,

  recorded_by_participant_id UUID NOT NULL,
  command_idempotency_id UUID NOT NULL UNIQUE,

  integrity_algorithm TEXT NOT NULL DEFAULT 'sha256'
    CHECK (integrity_algorithm = 'sha256'),
  integrity_hash TEXT NOT NULL
    CHECK (integrity_hash ~ '^[0-9a-f]{64}$'),
  integrity_version SMALLINT NOT NULL DEFAULT 1
    CHECK (integrity_version = 1),

  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT canonical_visit_version_key
    PRIMARY KEY (visit_id, version),

  CONSTRAINT canonical_visit_version_identity_fk
    FOREIGN KEY (visit_id, job_id)
    REFERENCES canonical_visits(id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_visit_version_actor_fk
    FOREIGN KEY (recorded_by_participant_id, job_id)
    REFERENCES relationship_participants(id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_visit_version_command_fk
    FOREIGN KEY (
      command_idempotency_id,
      recorded_by_participant_id,
      job_id
    )
    REFERENCES canonical_visit_command_idempotency(
      id,
      actor_participant_id,
      job_id
    )
    ON DELETE RESTRICT,

  CONSTRAINT canonical_visit_version_time_range_check
    CHECK (
      scheduled_end_at IS NULL
      OR scheduled_end_at > scheduled_start_at
    ),

  CONSTRAINT canonical_visit_version_terminal_state_check
    CHECK (
      (
        state IN ('PROPOSED', 'SCHEDULED')
        AND cancellation_reason IS NULL
        AND cancelled_at IS NULL
        AND completed_at IS NULL
      )
      OR
      (
        state = 'CANCELLED'
        AND cancelled_at IS NOT NULL
        AND completed_at IS NULL
      )
      OR
      (
        state = 'COMPLETED'
        AND cancellation_reason IS NULL
        AND cancelled_at IS NULL
        AND completed_at IS NOT NULL
      )
    ),

  CONSTRAINT canonical_visit_version_job_key
    UNIQUE (visit_id, version, job_id),

  CONSTRAINT canonical_visit_version_job_state_key
    UNIQUE (visit_id, version, job_id, state)
);

CREATE INDEX IF NOT EXISTS canonical_visit_latest_version_idx
ON canonical_visit_versions(visit_id, version DESC);

CREATE INDEX IF NOT EXISTS canonical_visit_job_state_start_idx
ON canonical_visit_versions(
  job_id,
  state,
  scheduled_start_at ASC,
  visit_id,
  version DESC
);

CREATE TABLE IF NOT EXISTS canonical_visit_events (
  id UUID PRIMARY KEY,

  visit_id UUID NOT NULL,
  visit_version INTEGER NOT NULL
    CHECK (visit_version >= 1),
  previous_visit_version INTEGER
    CHECK (previous_visit_version IS NULL OR previous_visit_version >= 1),
  job_id UUID NOT NULL,

  event_type TEXT NOT NULL
    CHECK (
      event_type IN (
        'VISIT_PROPOSED',
        'VISIT_CONFIRMED',
        'VISIT_CHANGE_REQUESTED',
        'VISIT_RESCHEDULED',
        'VISIT_CANCELLED',
        'VISIT_COMPLETED'
      )
    ),

  visit_state TEXT NOT NULL
    CHECK (
      visit_state IN (
        'PROPOSED',
        'SCHEDULED',
        'CANCELLED',
        'COMPLETED'
      )
    ),

  reason TEXT
    CHECK (
      reason IS NULL
      OR char_length(btrim(reason)) BETWEEN 1 AND 2000
    ),

  recorded_by_participant_id UUID NOT NULL,
  command_idempotency_id UUID NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT canonical_visit_event_version_fk
    FOREIGN KEY (visit_id, visit_version, job_id, visit_state)
    REFERENCES canonical_visit_versions(visit_id, version, job_id, state)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_visit_event_previous_version_fk
    FOREIGN KEY (visit_id, previous_visit_version, job_id)
    REFERENCES canonical_visit_versions(visit_id, version, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_visit_event_actor_fk
    FOREIGN KEY (recorded_by_participant_id, job_id)
    REFERENCES relationship_participants(id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_visit_event_command_fk
    FOREIGN KEY (
      command_idempotency_id,
      recorded_by_participant_id,
      job_id
    )
    REFERENCES canonical_visit_command_idempotency(
      id,
      actor_participant_id,
      job_id
    )
    ON DELETE RESTRICT,

  CONSTRAINT canonical_visit_event_transition_shape_check
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
    ),

  CONSTRAINT canonical_visit_event_identity_key
    UNIQUE (id, visit_id, job_id)
);

CREATE INDEX IF NOT EXISTS canonical_visit_event_history_idx
ON canonical_visit_events(
  visit_id,
  created_at ASC,
  id ASC
);

CREATE INDEX IF NOT EXISTS canonical_visit_event_job_idx
ON canonical_visit_events(
  job_id,
  created_at DESC,
  id DESC
);

CREATE TABLE IF NOT EXISTS canonical_visit_evaluation_links (
  visit_id UUID PRIMARY KEY,
  job_id UUID NOT NULL,
  visit_purpose TEXT NOT NULL DEFAULT 'EVALUATION'
    CHECK (visit_purpose = 'EVALUATION'),
  evaluation_id UUID NOT NULL,

  linked_by_participant_id UUID NOT NULL,
  command_idempotency_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT canonical_visit_evaluation_link_visit_fk
    FOREIGN KEY (visit_id, job_id, visit_purpose)
    REFERENCES canonical_visits(id, job_id, purpose)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_visit_evaluation_link_evaluation_fk
    FOREIGN KEY (evaluation_id, job_id)
    REFERENCES canonical_evaluation_job_subjects(evaluation_id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_visit_evaluation_link_actor_fk
    FOREIGN KEY (linked_by_participant_id, job_id)
    REFERENCES relationship_participants(id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_visit_evaluation_link_command_fk
    FOREIGN KEY (
      command_idempotency_id,
      linked_by_participant_id,
      job_id
    )
    REFERENCES canonical_visit_command_idempotency(
      id,
      actor_participant_id,
      job_id
    )
    ON DELETE RESTRICT,

  CONSTRAINT canonical_visit_evaluation_link_key
    UNIQUE (visit_id, evaluation_id),

  CONSTRAINT canonical_visit_evaluation_link_identity_key
    UNIQUE (visit_id, evaluation_id, job_id)
);

CREATE INDEX IF NOT EXISTS canonical_visit_evaluation_lookup_idx
ON canonical_visit_evaluation_links(
  evaluation_id,
  created_at ASC,
  visit_id ASC
);

CREATE TABLE IF NOT EXISTS canonical_visit_workstream_links (
  visit_id UUID NOT NULL,
  workstream_id UUID NOT NULL,
  job_id UUID NOT NULL,

  linked_by_participant_id UUID NOT NULL,
  command_idempotency_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT canonical_visit_workstream_link_visit_fk
    FOREIGN KEY (visit_id, job_id)
    REFERENCES canonical_visits(id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_visit_workstream_link_workstream_fk
    FOREIGN KEY (workstream_id, job_id)
    REFERENCES canonical_workstreams(id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_visit_workstream_link_actor_fk
    FOREIGN KEY (linked_by_participant_id, job_id)
    REFERENCES relationship_participants(id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_visit_workstream_link_command_fk
    FOREIGN KEY (
      command_idempotency_id,
      linked_by_participant_id,
      job_id
    )
    REFERENCES canonical_visit_command_idempotency(
      id,
      actor_participant_id,
      job_id
    )
    ON DELETE RESTRICT,

  CONSTRAINT canonical_visit_workstream_link_key
    PRIMARY KEY (visit_id, workstream_id),

  CONSTRAINT canonical_visit_workstream_link_identity_key
    UNIQUE (visit_id, workstream_id, job_id)
);

CREATE INDEX IF NOT EXISTS canonical_visit_workstream_visit_idx
ON canonical_visit_workstream_links(
  visit_id,
  created_at ASC,
  workstream_id ASC
);

CREATE INDEX IF NOT EXISTS canonical_visit_workstream_lookup_idx
ON canonical_visit_workstream_links(
  workstream_id,
  created_at ASC,
  visit_id ASC
);

CREATE OR REPLACE FUNCTION prevent_canonical_visit_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'canonical Visit history is append-only'
    USING ERRCODE = '55000';
END;
$$;

CREATE OR REPLACE FUNCTION prevent_canonical_visit_identity_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'canonical Visit identity is immutable'
    USING ERRCODE = '55000';
END;
$$;

DO $$
DECLARE
  table_name TEXT;
  trigger_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'canonical_visit_versions',
    'canonical_visit_events',
    'canonical_visit_evaluation_links',
    'canonical_visit_workstream_links'
  ]
  LOOP
    trigger_name := table_name || '_append_only';
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgname = trigger_name AND NOT tgisinternal
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I '
        'FOR EACH ROW EXECUTE FUNCTION prevent_canonical_visit_history_mutation()',
        trigger_name,
        table_name
      );
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'canonical_visits_immutable' AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER canonical_visits_immutable
    BEFORE UPDATE OR DELETE ON canonical_visits
    FOR EACH ROW EXECUTE FUNCTION prevent_canonical_visit_identity_mutation();
  END IF;
END;
$$;

-- No trigger in this migration creates or transitions Evaluation, Quote,
-- Workstream, Work Activity, Job, Invoice, or completion authority. Visit
-- COMPLETED records only that the scheduled interaction occurred.
