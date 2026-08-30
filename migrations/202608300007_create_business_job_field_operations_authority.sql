-- MC Employee / Team V1: exact assigned-Job field communication and status.
-- This migration creates no status, message, assignment, Alert, or billing rows.

CREATE TABLE IF NOT EXISTS business_job_field_status_commands (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id UUID NOT NULL,
  contractor_profile_id INTEGER NOT NULL
    REFERENCES contractor_profiles(id) ON DELETE RESTRICT,
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  membership_id UUID NOT NULL,
  assignment_activation_version INTEGER NOT NULL CHECK (assignment_activation_version > 0),
  actor_membership_id UUID NOT NULL,
  idempotency_key TEXT NOT NULL
    CHECK (char_length(btrim(idempotency_key)) BETWEEN 1 AND 200),
  request_fingerprint TEXT NOT NULL
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  result_reference JSONB,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT business_job_field_status_command_assignment_fk
    FOREIGN KEY (assignment_id, contractor_profile_id, job_id, membership_id)
    REFERENCES business_job_assignments(id, contractor_profile_id, job_id, membership_id)
    ON DELETE RESTRICT,
  CONSTRAINT business_job_field_status_command_actor_fk
    FOREIGN KEY (actor_membership_id, contractor_profile_id)
    REFERENCES business_team_memberships(id, contractor_profile_id)
    ON DELETE RESTRICT,
  CONSTRAINT business_job_field_status_command_result_check CHECK (
    (result_reference IS NULL AND completed_at IS NULL)
    OR
    (jsonb_typeof(result_reference) = 'object' AND completed_at IS NOT NULL)
  ),
  UNIQUE (actor_membership_id, assignment_id, idempotency_key),
  UNIQUE (id, assignment_id, contractor_profile_id, job_id, membership_id)
);

CREATE INDEX IF NOT EXISTS business_job_field_status_commands_assignment_idx
  ON business_job_field_status_commands(assignment_id, created_at DESC);

CREATE TABLE IF NOT EXISTS business_job_field_status_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id UUID NOT NULL,
  contractor_profile_id INTEGER NOT NULL
    REFERENCES contractor_profiles(id) ON DELETE RESTRICT,
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  membership_id UUID NOT NULL,
  assignment_activation_version INTEGER NOT NULL CHECK (assignment_activation_version > 0),
  status_version INTEGER NOT NULL CHECK (status_version > 0),
  from_status TEXT NOT NULL
    CHECK (from_status IN ('ASSIGNED', 'ON_MY_WAY', 'ARRIVED', 'WORKING')),
  to_status TEXT NOT NULL
    CHECK (to_status IN ('ON_MY_WAY', 'ARRIVED', 'WORKING', 'FIELD_WORK_COMPLETED')),
  note TEXT CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 1000),
  actor_membership_id UUID NOT NULL,
  actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  command_id UUID NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT business_job_field_status_event_assignment_fk
    FOREIGN KEY (assignment_id, contractor_profile_id, job_id, membership_id)
    REFERENCES business_job_assignments(id, contractor_profile_id, job_id, membership_id)
    ON DELETE RESTRICT,
  CONSTRAINT business_job_field_status_event_actor_fk
    FOREIGN KEY (actor_membership_id, contractor_profile_id)
    REFERENCES business_team_memberships(id, contractor_profile_id)
    ON DELETE RESTRICT,
  CONSTRAINT business_job_field_status_event_command_fk
    FOREIGN KEY (command_id, assignment_id, contractor_profile_id, job_id, membership_id)
    REFERENCES business_job_field_status_commands(
      id, assignment_id, contractor_profile_id, job_id, membership_id
    ) ON DELETE RESTRICT,
  CONSTRAINT business_job_field_status_transition_check CHECK (
    (from_status = 'ASSIGNED' AND to_status = 'ON_MY_WAY')
    OR (from_status = 'ON_MY_WAY' AND to_status = 'ARRIVED')
    OR (from_status = 'ARRIVED' AND to_status = 'WORKING')
    OR (from_status = 'WORKING' AND to_status = 'FIELD_WORK_COMPLETED')
  ),
  UNIQUE (assignment_id, assignment_activation_version, status_version),
  UNIQUE (command_id)
);

CREATE INDEX IF NOT EXISTS business_job_field_status_events_job_idx
  ON business_job_field_status_events(contractor_profile_id, job_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS business_job_field_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id UUID NOT NULL,
  contractor_profile_id INTEGER NOT NULL
    REFERENCES contractor_profiles(id) ON DELETE RESTRICT,
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  membership_id UUID NOT NULL,
  sender_membership_id UUID NOT NULL,
  sender_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  message_text TEXT NOT NULL
    CHECK (char_length(btrim(message_text)) BETWEEN 1 AND 5000),
  idempotency_key TEXT NOT NULL
    CHECK (char_length(btrim(idempotency_key)) BETWEEN 1 AND 200),
  request_fingerprint TEXT NOT NULL
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT business_job_field_message_assignment_fk
    FOREIGN KEY (assignment_id, contractor_profile_id, job_id, membership_id)
    REFERENCES business_job_assignments(id, contractor_profile_id, job_id, membership_id)
    ON DELETE RESTRICT,
  CONSTRAINT business_job_field_message_sender_fk
    FOREIGN KEY (sender_membership_id, contractor_profile_id)
    REFERENCES business_team_memberships(id, contractor_profile_id)
    ON DELETE RESTRICT,
  UNIQUE (sender_membership_id, assignment_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS business_job_field_messages_assignment_idx
  ON business_job_field_messages(assignment_id, created_at ASC, id ASC);

CREATE OR REPLACE FUNCTION validate_business_job_field_status_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_status TEXT;
  current_status_version INTEGER;
  current_activation_version INTEGER;
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM business_job_assignments assignments
      JOIN business_team_memberships memberships
        ON memberships.id = assignments.membership_id
       AND memberships.contractor_profile_id = assignments.contractor_profile_id
     WHERE assignments.id = NEW.assignment_id
       AND assignments.contractor_profile_id = NEW.contractor_profile_id
       AND assignments.job_id = NEW.job_id
       AND assignments.membership_id = NEW.membership_id
       AND assignments.state = 'ACTIVE'
       AND memberships.status = 'ACTIVE'
       AND memberships.role = 'FIELD_EMPLOYEE'
  ) THEN
    RAISE EXCEPTION 'Field status requires an active Field Employee assignment';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM business_team_memberships
     WHERE id = NEW.actor_membership_id
       AND id = NEW.membership_id
       AND user_id = NEW.actor_user_id
       AND contractor_profile_id = NEW.contractor_profile_id
       AND status = 'ACTIVE'
       AND role = 'FIELD_EMPLOYEE'
  ) THEN
    RAISE EXCEPTION 'Only the assigned Field Employee may record field status';
  END IF;

  SELECT max(assignment_version)
    INTO current_activation_version
    FROM business_job_assignment_events
   WHERE assignment_id = NEW.assignment_id
     AND event_type IN ('ASSIGNED', 'REASSIGNED');

  IF current_activation_version IS NULL
     OR NEW.assignment_activation_version <> current_activation_version THEN
    RAISE EXCEPTION 'Field status activation identity is stale';
  END IF;

  SELECT events.to_status, events.status_version
    INTO current_status, current_status_version
    FROM business_job_field_status_events events
   WHERE events.assignment_id = NEW.assignment_id
     AND events.assignment_activation_version = NEW.assignment_activation_version
   ORDER BY events.status_version DESC
   LIMIT 1;

  current_status := COALESCE(current_status, 'ASSIGNED');
  current_status_version := COALESCE(current_status_version, 0);
  IF NEW.from_status <> current_status
     OR NEW.status_version <> current_status_version + 1 THEN
    RAISE EXCEPTION 'Field status transition is not the next exact transition';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS business_job_field_status_event_guard
  ON business_job_field_status_events;
CREATE TRIGGER business_job_field_status_event_guard
BEFORE INSERT ON business_job_field_status_events
FOR EACH ROW EXECUTE FUNCTION validate_business_job_field_status_event();

CREATE OR REPLACE FUNCTION validate_business_job_field_message()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  sender_role TEXT;
  sender_status TEXT;
  sender_user INTEGER;
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM business_job_assignments assignments
      JOIN business_team_memberships targets
        ON targets.id = assignments.membership_id
       AND targets.contractor_profile_id = assignments.contractor_profile_id
     WHERE assignments.id = NEW.assignment_id
       AND assignments.contractor_profile_id = NEW.contractor_profile_id
       AND assignments.job_id = NEW.job_id
       AND assignments.membership_id = NEW.membership_id
       AND assignments.state = 'ACTIVE'
       AND targets.status = 'ACTIVE'
       AND targets.role = 'FIELD_EMPLOYEE'
  ) THEN
    RAISE EXCEPTION 'Field communication requires an active Field Employee assignment';
  END IF;

  SELECT role, status, user_id
    INTO sender_role, sender_status, sender_user
    FROM business_team_memberships
   WHERE id = NEW.sender_membership_id
     AND contractor_profile_id = NEW.contractor_profile_id;

  IF sender_status IS DISTINCT FROM 'ACTIVE'
     OR sender_user IS DISTINCT FROM NEW.sender_user_id
     OR sender_role IS NULL
     OR sender_role NOT IN ('OWNER', 'MANAGER', 'FIELD_EMPLOYEE')
     OR (sender_role = 'FIELD_EMPLOYEE' AND NEW.sender_membership_id <> NEW.membership_id) THEN
    RAISE EXCEPTION 'Field message sender lacks exact Job authority';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS business_job_field_message_guard
  ON business_job_field_messages;
CREATE TRIGGER business_job_field_message_guard
BEFORE INSERT ON business_job_field_messages
FOR EACH ROW EXECUTE FUNCTION validate_business_job_field_message();

CREATE OR REPLACE FUNCTION reject_business_job_field_evidence_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Business Job field evidence is append-only';
END;
$$;

DROP TRIGGER IF EXISTS business_job_field_status_event_history_guard
  ON business_job_field_status_events;
CREATE TRIGGER business_job_field_status_event_history_guard
BEFORE UPDATE OR DELETE ON business_job_field_status_events
FOR EACH ROW EXECUTE FUNCTION reject_business_job_field_evidence_mutation();

DROP TRIGGER IF EXISTS business_job_field_message_history_guard
  ON business_job_field_messages;
CREATE TRIGGER business_job_field_message_history_guard
BEFORE UPDATE OR DELETE ON business_job_field_messages
FOR EACH ROW EXECUTE FUNCTION reject_business_job_field_evidence_mutation();

CREATE OR REPLACE FUNCTION protect_business_job_field_status_command()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.completed_at IS NOT NULL
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.assignment_id IS DISTINCT FROM OLD.assignment_id
     OR NEW.contractor_profile_id IS DISTINCT FROM OLD.contractor_profile_id
     OR NEW.job_id IS DISTINCT FROM OLD.job_id
     OR NEW.membership_id IS DISTINCT FROM OLD.membership_id
     OR NEW.assignment_activation_version IS DISTINCT FROM OLD.assignment_activation_version
     OR NEW.actor_membership_id IS DISTINCT FROM OLD.actor_membership_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.request_fingerprint IS DISTINCT FROM OLD.request_fingerprint
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.result_reference IS NULL
     OR jsonb_typeof(NEW.result_reference) <> 'object'
     OR NEW.completed_at IS NULL THEN
    RAISE EXCEPTION 'Business Job field status command identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS business_job_field_status_command_update_guard
  ON business_job_field_status_commands;
CREATE TRIGGER business_job_field_status_command_update_guard
BEFORE UPDATE ON business_job_field_status_commands
FOR EACH ROW EXECUTE FUNCTION protect_business_job_field_status_command();

DROP TRIGGER IF EXISTS business_job_field_status_command_delete_guard
  ON business_job_field_status_commands;
CREATE TRIGGER business_job_field_status_command_delete_guard
BEFORE DELETE ON business_job_field_status_commands
FOR EACH ROW EXECUTE FUNCTION reject_business_job_field_evidence_mutation();
