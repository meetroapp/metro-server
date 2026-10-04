-- MC Employee / Team V1: server-owned Clock In / Clock Out evidence.
-- This migration creates no timer, time, location, Alert, payroll, Job, or billing rows.

CREATE TABLE IF NOT EXISTS business_time_commands (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_profile_id INTEGER NOT NULL
    REFERENCES contractor_profiles(id) ON DELETE RESTRICT,
  actor_membership_id UUID NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('CLOCK_IN', 'CLOCK_OUT')),
  idempotency_key TEXT NOT NULL
    CHECK (char_length(btrim(idempotency_key)) BETWEEN 1 AND 200),
  request_fingerprint TEXT NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  result_reference JSONB,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT business_time_command_actor_fk
    FOREIGN KEY (actor_membership_id, contractor_profile_id)
    REFERENCES business_team_memberships(id, contractor_profile_id)
    ON DELETE RESTRICT,
  CONSTRAINT business_time_command_result_check CHECK (
    (result_reference IS NULL AND completed_at IS NULL)
    OR (jsonb_typeof(result_reference) = 'object' AND completed_at IS NOT NULL)
  ),
  UNIQUE (actor_membership_id, idempotency_key),
  UNIQUE (id, contractor_profile_id, actor_membership_id)
);

CREATE INDEX IF NOT EXISTS business_time_commands_actor_idx
  ON business_time_commands(actor_membership_id, created_at DESC);

CREATE TABLE IF NOT EXISTS business_time_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_profile_id INTEGER NOT NULL
    REFERENCES contractor_profiles(id) ON DELETE RESTRICT,
  membership_id UUID NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  category TEXT NOT NULL
    CHECK (category IN ('JOB_WORK', 'DRIVING', 'OFFICE', 'SUPPLIES', 'BREAK', 'GENERAL')),
  job_id UUID REFERENCES jobs(id) ON DELETE RESTRICT,
  assignment_id UUID,
  assignment_activation_version INTEGER CHECK (assignment_activation_version > 0),
  clock_in_command_id UUID NOT NULL,
  clock_out_command_id UUID,
  clocked_in_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  clocked_out_at TIMESTAMPTZ,
  clock_in_source TEXT NOT NULL DEFAULT 'MEETRO_CLIENT'
    CHECK (clock_in_source IN ('MEETRO_CLIENT')),
  clock_out_source TEXT CHECK (clock_out_source IN ('MEETRO_CLIENT')),
  clock_in_location_status TEXT NOT NULL DEFAULT 'NOT_REQUESTED'
    CHECK (clock_in_location_status IN ('CAPTURED', 'UNAVAILABLE', 'DENIED', 'NOT_REQUESTED')),
  clock_in_latitude DOUBLE PRECISION,
  clock_in_longitude DOUBLE PRECISION,
  clock_out_location_status TEXT
    CHECK (clock_out_location_status IN ('CAPTURED', 'UNAVAILABLE', 'DENIED', 'NOT_REQUESTED')),
  clock_out_latitude DOUBLE PRECISION,
  clock_out_longitude DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT business_time_session_member_fk
    FOREIGN KEY (membership_id, contractor_profile_id)
    REFERENCES business_team_memberships(id, contractor_profile_id)
    ON DELETE RESTRICT,
  CONSTRAINT business_time_session_assignment_fk
    FOREIGN KEY (assignment_id, contractor_profile_id, job_id, membership_id)
    REFERENCES business_job_assignments(id, contractor_profile_id, job_id, membership_id)
    ON DELETE RESTRICT,
  CONSTRAINT business_time_session_clock_in_command_fk
    FOREIGN KEY (clock_in_command_id, contractor_profile_id, membership_id)
    REFERENCES business_time_commands(id, contractor_profile_id, actor_membership_id)
    ON DELETE RESTRICT,
  CONSTRAINT business_time_session_clock_out_command_fk
    FOREIGN KEY (clock_out_command_id, contractor_profile_id, membership_id)
    REFERENCES business_time_commands(id, contractor_profile_id, actor_membership_id)
    ON DELETE RESTRICT,
  CONSTRAINT business_time_session_job_identity_check CHECK (
    (category = 'JOB_WORK' AND job_id IS NOT NULL AND assignment_id IS NOT NULL
      AND assignment_activation_version IS NOT NULL)
    OR
    (category <> 'JOB_WORK' AND job_id IS NULL AND assignment_id IS NULL
      AND assignment_activation_version IS NULL)
  ),
  CONSTRAINT business_time_session_close_check CHECK (
    (clocked_out_at IS NULL AND clock_out_command_id IS NULL
      AND clock_out_source IS NULL AND clock_out_location_status IS NULL
      AND clock_out_latitude IS NULL AND clock_out_longitude IS NULL)
    OR
    (clocked_out_at IS NOT NULL AND clocked_out_at >= clocked_in_at
      AND clock_out_command_id IS NOT NULL AND clock_out_source IS NOT NULL
      AND clock_out_location_status IS NOT NULL)
  ),
  CONSTRAINT business_time_session_clock_in_location_check CHECK (
    (clock_in_location_status = 'CAPTURED'
      AND clock_in_latitude BETWEEN -90 AND 90
      AND clock_in_longitude BETWEEN -180 AND 180)
    OR
    (clock_in_location_status <> 'CAPTURED'
      AND clock_in_latitude IS NULL AND clock_in_longitude IS NULL)
  ),
  CONSTRAINT business_time_session_clock_out_location_check CHECK (
    clock_out_location_status IS NULL
    OR (clock_out_location_status = 'CAPTURED'
      AND clock_out_latitude BETWEEN -90 AND 90
      AND clock_out_longitude BETWEEN -180 AND 180)
    OR (clock_out_location_status <> 'CAPTURED'
      AND clock_out_latitude IS NULL AND clock_out_longitude IS NULL)
  ),
  UNIQUE (id, contractor_profile_id, membership_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS business_time_sessions_one_active_uidx
  ON business_time_sessions(membership_id)
  WHERE clocked_out_at IS NULL;

CREATE INDEX IF NOT EXISTS business_time_sessions_business_history_idx
  ON business_time_sessions(contractor_profile_id, clocked_in_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS business_time_sessions_job_history_idx
  ON business_time_sessions(job_id, clocked_in_at DESC)
  WHERE job_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS business_time_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL,
  contractor_profile_id INTEGER NOT NULL
    REFERENCES contractor_profiles(id) ON DELETE RESTRICT,
  membership_id UUID NOT NULL,
  actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN ('CLOCKED_IN', 'CLOCKED_OUT')),
  command_id UUID NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT business_time_event_member_fk
    FOREIGN KEY (membership_id, contractor_profile_id)
    REFERENCES business_team_memberships(id, contractor_profile_id)
    ON DELETE RESTRICT,
  CONSTRAINT business_time_event_session_fk
    FOREIGN KEY (session_id, contractor_profile_id, membership_id)
    REFERENCES business_time_sessions(id, contractor_profile_id, membership_id)
    ON DELETE RESTRICT,
  CONSTRAINT business_time_event_command_fk
    FOREIGN KEY (command_id, contractor_profile_id, membership_id)
    REFERENCES business_time_commands(id, contractor_profile_id, actor_membership_id)
    ON DELETE RESTRICT,
  UNIQUE (command_id),
  UNIQUE (session_id, event_type)
);

CREATE INDEX IF NOT EXISTS business_time_events_session_idx
  ON business_time_events(session_id, occurred_at ASC);

CREATE OR REPLACE FUNCTION validate_business_time_session_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  activation_version INTEGER;
BEGIN
  NEW.clocked_in_at := CURRENT_TIMESTAMP;
  NEW.created_at := CURRENT_TIMESTAMP;
  NEW.updated_at := CURRENT_TIMESTAMP;
  IF NOT EXISTS (
    SELECT 1 FROM business_team_memberships memberships
     WHERE memberships.id = NEW.membership_id
       AND memberships.contractor_profile_id = NEW.contractor_profile_id
       AND memberships.user_id = NEW.user_id
       AND memberships.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'Time evidence requires the exact active Team membership';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM business_time_commands commands
     WHERE commands.id = NEW.clock_in_command_id
       AND commands.contractor_profile_id = NEW.contractor_profile_id
       AND commands.actor_membership_id = NEW.membership_id
       AND commands.action = 'CLOCK_IN'
  ) THEN
    RAISE EXCEPTION 'Clock In command identity is invalid';
  END IF;

  IF NEW.category = 'JOB_WORK' THEN
    IF NOT EXISTS (
      SELECT 1 FROM business_job_assignments assignments
       WHERE assignments.id = NEW.assignment_id
         AND assignments.contractor_profile_id = NEW.contractor_profile_id
         AND assignments.job_id = NEW.job_id
         AND assignments.membership_id = NEW.membership_id
         AND assignments.state = 'ACTIVE'
    ) THEN
      RAISE EXCEPTION 'Job Work requires the exact active assignment';
    END IF;
    SELECT max(events.assignment_version)
      INTO activation_version
      FROM business_job_assignment_events events
     WHERE events.assignment_id = NEW.assignment_id
       AND events.event_type IN ('ASSIGNED', 'REASSIGNED');
    IF activation_version IS NULL
       OR activation_version <> NEW.assignment_activation_version THEN
      RAISE EXCEPTION 'Job Work assignment activation identity is stale';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS business_time_session_insert_guard ON business_time_sessions;
CREATE TRIGGER business_time_session_insert_guard
BEFORE INSERT ON business_time_sessions
FOR EACH ROW EXECUTE FUNCTION validate_business_time_session_insert();

CREATE OR REPLACE FUNCTION protect_business_time_session_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.clocked_out_at IS NOT NULL
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.contractor_profile_id IS DISTINCT FROM OLD.contractor_profile_id
     OR NEW.membership_id IS DISTINCT FROM OLD.membership_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.category IS DISTINCT FROM OLD.category
     OR NEW.job_id IS DISTINCT FROM OLD.job_id
     OR NEW.assignment_id IS DISTINCT FROM OLD.assignment_id
     OR NEW.assignment_activation_version IS DISTINCT FROM OLD.assignment_activation_version
     OR NEW.clock_in_command_id IS DISTINCT FROM OLD.clock_in_command_id
     OR NEW.clocked_in_at IS DISTINCT FROM OLD.clocked_in_at
     OR NEW.clock_in_source IS DISTINCT FROM OLD.clock_in_source
     OR NEW.clock_in_location_status IS DISTINCT FROM OLD.clock_in_location_status
     OR NEW.clock_in_latitude IS DISTINCT FROM OLD.clock_in_latitude
     OR NEW.clock_in_longitude IS DISTINCT FROM OLD.clock_in_longitude
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.clock_out_command_id IS NULL
     OR NEW.clock_out_source IS DISTINCT FROM 'MEETRO_CLIENT'
     OR NEW.clock_out_location_status IS NULL THEN
    RAISE EXCEPTION 'Business time session evidence is immutable except for its first governed close';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM business_team_memberships memberships
     WHERE memberships.id = OLD.membership_id
       AND memberships.contractor_profile_id = OLD.contractor_profile_id
       AND memberships.user_id = OLD.user_id
       AND memberships.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'Inactive Team membership cannot record a time action';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM business_time_commands commands
     WHERE commands.id = NEW.clock_out_command_id
       AND commands.contractor_profile_id = OLD.contractor_profile_id
       AND commands.actor_membership_id = OLD.membership_id
       AND commands.action = 'CLOCK_OUT'
  ) THEN
    RAISE EXCEPTION 'Clock Out command identity is invalid';
  END IF;
  NEW.clocked_out_at := CURRENT_TIMESTAMP;
  NEW.updated_at := CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS business_time_session_update_guard ON business_time_sessions;
CREATE TRIGGER business_time_session_update_guard
BEFORE UPDATE ON business_time_sessions
FOR EACH ROW EXECUTE FUNCTION protect_business_time_session_evidence();

CREATE OR REPLACE FUNCTION validate_business_time_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  session_row business_time_sessions%ROWTYPE;
BEGIN
  SELECT * INTO session_row
    FROM business_time_sessions
   WHERE id = NEW.session_id
     AND contractor_profile_id = NEW.contractor_profile_id
     AND membership_id = NEW.membership_id;
  IF session_row.id IS NULL OR session_row.user_id <> NEW.actor_user_id THEN
    RAISE EXCEPTION 'Time event lacks exact session actor identity';
  END IF;
  IF (NEW.event_type = 'CLOCKED_IN'
      AND (NEW.command_id <> session_row.clock_in_command_id
        OR NEW.occurred_at IS DISTINCT FROM session_row.clocked_in_at))
     OR (NEW.event_type = 'CLOCKED_OUT'
      AND (session_row.clocked_out_at IS NULL
        OR NEW.command_id <> session_row.clock_out_command_id
        OR NEW.occurred_at IS DISTINCT FROM session_row.clocked_out_at)) THEN
    RAISE EXCEPTION 'Time event does not match the exact governed boundary';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS business_time_event_guard ON business_time_events;
CREATE TRIGGER business_time_event_guard
BEFORE INSERT ON business_time_events
FOR EACH ROW EXECUTE FUNCTION validate_business_time_event();

CREATE OR REPLACE FUNCTION reject_business_time_evidence_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Business time evidence is durable';
END;
$$;

DROP TRIGGER IF EXISTS business_time_session_delete_guard ON business_time_sessions;
CREATE TRIGGER business_time_session_delete_guard
BEFORE DELETE ON business_time_sessions
FOR EACH ROW EXECUTE FUNCTION reject_business_time_evidence_mutation();

DROP TRIGGER IF EXISTS business_time_event_history_guard ON business_time_events;
CREATE TRIGGER business_time_event_history_guard
BEFORE UPDATE OR DELETE ON business_time_events
FOR EACH ROW EXECUTE FUNCTION reject_business_time_evidence_mutation();

CREATE OR REPLACE FUNCTION protect_business_time_command()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.completed_at IS NOT NULL
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.contractor_profile_id IS DISTINCT FROM OLD.contractor_profile_id
     OR NEW.actor_membership_id IS DISTINCT FROM OLD.actor_membership_id
     OR NEW.action IS DISTINCT FROM OLD.action
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.request_fingerprint IS DISTINCT FROM OLD.request_fingerprint
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.result_reference IS NULL
     OR jsonb_typeof(NEW.result_reference) <> 'object'
     OR NEW.completed_at IS NULL THEN
    RAISE EXCEPTION 'Business time command identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS business_time_command_update_guard ON business_time_commands;
CREATE TRIGGER business_time_command_update_guard
BEFORE UPDATE ON business_time_commands
FOR EACH ROW EXECUTE FUNCTION protect_business_time_command();

DROP TRIGGER IF EXISTS business_time_command_delete_guard ON business_time_commands;
CREATE TRIGGER business_time_command_delete_guard
BEFORE DELETE ON business_time_commands
FOR EACH ROW EXECUTE FUNCTION reject_business_time_evidence_mutation();
