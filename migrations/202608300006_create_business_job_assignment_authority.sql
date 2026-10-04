-- MC Employee / Team V1: durable Job assignment authority.
-- This migration creates no assignments and grants no Job access by itself.

CREATE UNIQUE INDEX IF NOT EXISTS business_team_memberships_business_identity_uidx
  ON business_team_memberships(id, contractor_profile_id);

CREATE TABLE IF NOT EXISTS business_job_assignment_commands (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_profile_id INTEGER NOT NULL
    REFERENCES contractor_profiles(id) ON DELETE RESTRICT,
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  actor_membership_id UUID NOT NULL,
  idempotency_key TEXT NOT NULL
    CHECK (char_length(btrim(idempotency_key)) BETWEEN 1 AND 200),
  request_fingerprint TEXT NOT NULL
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  result_reference JSONB,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT business_job_assignment_command_actor_fk
    FOREIGN KEY (actor_membership_id, contractor_profile_id)
    REFERENCES business_team_memberships(id, contractor_profile_id)
    ON DELETE RESTRICT,
  CONSTRAINT business_job_assignment_command_result_check CHECK (
    (result_reference IS NULL AND completed_at IS NULL)
    OR
    (jsonb_typeof(result_reference) = 'object' AND completed_at IS NOT NULL)
  ),
  UNIQUE (actor_membership_id, job_id, idempotency_key),
  UNIQUE (id, contractor_profile_id, job_id),
  UNIQUE (id, contractor_profile_id, job_id, actor_membership_id)
);

CREATE INDEX IF NOT EXISTS business_job_assignment_commands_job_idx
  ON business_job_assignment_commands(contractor_profile_id, job_id, created_at DESC);

CREATE TABLE IF NOT EXISTS business_job_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_profile_id INTEGER NOT NULL
    REFERENCES contractor_profiles(id) ON DELETE RESTRICT,
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  membership_id UUID NOT NULL,
  state TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (state IN ('ACTIVE', 'UNASSIGNED')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  assigned_by_membership_id UUID NOT NULL,
  initial_command_id UUID NOT NULL,
  initial_assigned_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_state_changed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT business_job_assignment_member_fk
    FOREIGN KEY (membership_id, contractor_profile_id)
    REFERENCES business_team_memberships(id, contractor_profile_id)
    ON DELETE RESTRICT,
  CONSTRAINT business_job_assignment_actor_fk
    FOREIGN KEY (assigned_by_membership_id, contractor_profile_id)
    REFERENCES business_team_memberships(id, contractor_profile_id)
    ON DELETE RESTRICT,
  CONSTRAINT business_job_assignment_initial_command_fk
    FOREIGN KEY (
      initial_command_id,
      contractor_profile_id,
      job_id,
      assigned_by_membership_id
    )
    REFERENCES business_job_assignment_commands(
      id,
      contractor_profile_id,
      job_id,
      actor_membership_id
    )
    ON DELETE RESTRICT,
  UNIQUE (contractor_profile_id, job_id, membership_id),
  UNIQUE (id, contractor_profile_id, job_id, membership_id)
);

CREATE INDEX IF NOT EXISTS business_job_assignments_member_idx
  ON business_job_assignments(membership_id, state, updated_at DESC);

CREATE INDEX IF NOT EXISTS business_job_assignments_job_idx
  ON business_job_assignments(contractor_profile_id, job_id, state);

CREATE TABLE IF NOT EXISTS business_job_assignment_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id UUID NOT NULL,
  contractor_profile_id INTEGER NOT NULL
    REFERENCES contractor_profiles(id) ON DELETE RESTRICT,
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  membership_id UUID NOT NULL,
  assignment_version INTEGER NOT NULL CHECK (assignment_version > 0),
  event_type TEXT NOT NULL
    CHECK (event_type IN ('ASSIGNED', 'CHANGED', 'REASSIGNED', 'UNASSIGNED')),
  actor_membership_id UUID NOT NULL,
  command_id UUID NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT business_job_assignment_event_member_fk
    FOREIGN KEY (membership_id, contractor_profile_id)
    REFERENCES business_team_memberships(id, contractor_profile_id)
    ON DELETE RESTRICT,
  CONSTRAINT business_job_assignment_event_actor_fk
    FOREIGN KEY (actor_membership_id, contractor_profile_id)
    REFERENCES business_team_memberships(id, contractor_profile_id)
    ON DELETE RESTRICT,
  CONSTRAINT business_job_assignment_event_assignment_fk
    FOREIGN KEY (assignment_id, contractor_profile_id, job_id, membership_id)
    REFERENCES business_job_assignments(id, contractor_profile_id, job_id, membership_id)
    ON DELETE RESTRICT,
  CONSTRAINT business_job_assignment_event_command_fk
    FOREIGN KEY (
      command_id,
      contractor_profile_id,
      job_id,
      actor_membership_id
    )
    REFERENCES business_job_assignment_commands(
      id,
      contractor_profile_id,
      job_id,
      actor_membership_id
    )
    ON DELETE RESTRICT,
  UNIQUE (assignment_id, assignment_version)
);

CREATE INDEX IF NOT EXISTS business_job_assignment_events_job_idx
  ON business_job_assignment_events(contractor_profile_id, job_id, occurred_at DESC);

CREATE OR REPLACE FUNCTION validate_business_job_assignment_authority()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM jobs
      JOIN request_relationships
        ON request_relationships.id = jobs.source_request_relationship_id
       AND request_relationships.post_id = jobs.job_request_id
       AND request_relationships.emergency_request_id IS NULL
      JOIN contractor_profiles
        ON contractor_profiles.id = NEW.contractor_profile_id
       AND contractor_profiles.user_id = request_relationships.professional_user_id
     WHERE jobs.id = NEW.job_id
       AND jobs.lifecycle_contract_version = 2
       AND request_relationships.status = 'active'
  ) THEN
    RAISE EXCEPTION 'Job does not belong to the exact business';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM business_team_memberships
     WHERE id = NEW.membership_id
       AND contractor_profile_id = NEW.contractor_profile_id
       AND status = 'ACTIVE'
       AND role IN ('MANAGER', 'FIELD_EMPLOYEE')
  ) THEN
    RAISE EXCEPTION 'Assignment target is not an active field-authorized Team member';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM business_team_memberships
     WHERE id = NEW.assigned_by_membership_id
       AND contractor_profile_id = NEW.contractor_profile_id
       AND status = 'ACTIVE'
       AND role IN ('OWNER', 'MANAGER')
  ) THEN
    RAISE EXCEPTION 'Assignment actor lacks authority';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS business_job_assignment_authority_guard
  ON business_job_assignments;
CREATE TRIGGER business_job_assignment_authority_guard
BEFORE INSERT ON business_job_assignments
FOR EACH ROW EXECUTE FUNCTION validate_business_job_assignment_authority();

CREATE OR REPLACE FUNCTION protect_business_job_assignment_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.contractor_profile_id IS DISTINCT FROM OLD.contractor_profile_id
     OR NEW.job_id IS DISTINCT FROM OLD.job_id
     OR NEW.membership_id IS DISTINCT FROM OLD.membership_id
     OR NEW.assigned_by_membership_id IS DISTINCT FROM OLD.assigned_by_membership_id
     OR NEW.initial_command_id IS DISTINCT FROM OLD.initial_command_id
     OR NEW.initial_assigned_at IS DISTINCT FROM OLD.initial_assigned_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (
       NEW.state IS NOT DISTINCT FROM OLD.state
       AND NEW.state <> 'ACTIVE'
     )
     OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'Business Job assignment history is immutable';
  END IF;
  NEW.last_state_changed_at := CURRENT_TIMESTAMP;
  NEW.updated_at := CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS business_job_assignment_history_guard
  ON business_job_assignments;
CREATE TRIGGER business_job_assignment_history_guard
BEFORE UPDATE ON business_job_assignments
FOR EACH ROW EXECUTE FUNCTION protect_business_job_assignment_history();

CREATE OR REPLACE FUNCTION validate_business_job_assignment_event_authority()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM business_team_memberships
     WHERE id = NEW.actor_membership_id
       AND contractor_profile_id = NEW.contractor_profile_id
       AND status = 'ACTIVE'
       AND role IN ('OWNER', 'MANAGER')
  ) THEN
    RAISE EXCEPTION 'Assignment event actor lacks authority';
  END IF;

  IF NEW.event_type IN ('ASSIGNED', 'CHANGED', 'REASSIGNED') AND NOT EXISTS (
    SELECT 1
      FROM business_team_memberships
     WHERE id = NEW.membership_id
       AND contractor_profile_id = NEW.contractor_profile_id
       AND status = 'ACTIVE'
       AND role IN ('MANAGER', 'FIELD_EMPLOYEE')
  ) THEN
    RAISE EXCEPTION 'Assignment event target lacks field authority';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS business_job_assignment_event_authority_guard
  ON business_job_assignment_events;
CREATE TRIGGER business_job_assignment_event_authority_guard
BEFORE INSERT ON business_job_assignment_events
FOR EACH ROW EXECUTE FUNCTION validate_business_job_assignment_event_authority();

CREATE OR REPLACE FUNCTION require_business_job_assignment_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  required_event_type TEXT;
BEGIN
  required_event_type := CASE
    WHEN NEW.state = 'UNASSIGNED' THEN 'UNASSIGNED'
    WHEN NEW.version = 1 THEN 'ASSIGNED'
    WHEN TG_OP = 'UPDATE' AND OLD.state = 'UNASSIGNED' THEN 'REASSIGNED'
    ELSE 'CHANGED'
  END;

  IF NOT EXISTS (
    SELECT 1
      FROM business_job_assignment_events
     WHERE assignment_id = NEW.id
       AND contractor_profile_id = NEW.contractor_profile_id
       AND job_id = NEW.job_id
       AND membership_id = NEW.membership_id
       AND assignment_version = NEW.version
       AND event_type = required_event_type
  ) THEN
    RAISE EXCEPTION 'Assignment state requires exact durable event evidence';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS business_job_assignment_event_evidence_check
  ON business_job_assignments;
CREATE CONSTRAINT TRIGGER business_job_assignment_event_evidence_check
AFTER INSERT OR UPDATE ON business_job_assignments
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION require_business_job_assignment_event();

CREATE OR REPLACE FUNCTION reject_business_job_assignment_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Business Job assignment evidence is append-only';
END;
$$;

DROP TRIGGER IF EXISTS business_job_assignment_delete_guard
  ON business_job_assignments;
CREATE TRIGGER business_job_assignment_delete_guard
BEFORE DELETE ON business_job_assignments
FOR EACH ROW EXECUTE FUNCTION reject_business_job_assignment_history_mutation();

CREATE OR REPLACE FUNCTION protect_business_job_assignment_command()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.completed_at IS NOT NULL
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.contractor_profile_id IS DISTINCT FROM OLD.contractor_profile_id
     OR NEW.job_id IS DISTINCT FROM OLD.job_id
     OR NEW.actor_membership_id IS DISTINCT FROM OLD.actor_membership_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.request_fingerprint IS DISTINCT FROM OLD.request_fingerprint
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.result_reference IS NULL
     OR jsonb_typeof(NEW.result_reference) <> 'object'
     OR NEW.completed_at IS NULL THEN
    RAISE EXCEPTION 'Business Job assignment command identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS business_job_assignment_command_update_guard
  ON business_job_assignment_commands;
CREATE TRIGGER business_job_assignment_command_update_guard
BEFORE UPDATE ON business_job_assignment_commands
FOR EACH ROW EXECUTE FUNCTION protect_business_job_assignment_command();

DROP TRIGGER IF EXISTS business_job_assignment_command_delete_guard
  ON business_job_assignment_commands;
CREATE TRIGGER business_job_assignment_command_delete_guard
BEFORE DELETE ON business_job_assignment_commands
FOR EACH ROW EXECUTE FUNCTION reject_business_job_assignment_history_mutation();

DROP TRIGGER IF EXISTS business_job_assignment_event_update_guard
  ON business_job_assignment_events;
CREATE TRIGGER business_job_assignment_event_update_guard
BEFORE UPDATE OR DELETE ON business_job_assignment_events
FOR EACH ROW EXECUTE FUNCTION reject_business_job_assignment_history_mutation();
