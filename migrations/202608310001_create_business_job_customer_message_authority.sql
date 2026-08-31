-- MC-COMM-R2A: assignment-scoped delegated customer-message command and authorship evidence.
-- This migration creates no message, participant, assignment, Job, commercial, or Alert rows.

CREATE UNIQUE INDEX IF NOT EXISTS
  business_team_memberships_customer_message_actor_uidx
ON business_team_memberships(id, contractor_profile_id, user_id);

CREATE TABLE IF NOT EXISTS business_job_customer_message_commands (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_profile_id INTEGER NOT NULL
    REFERENCES contractor_profiles(id) ON DELETE RESTRICT,
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  assignment_id UUID NOT NULL,
  membership_id UUID NOT NULL,
  assignment_activation_version INTEGER NOT NULL
    CHECK (assignment_activation_version > 0),
  actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL
    CHECK (char_length(btrim(idempotency_key)) BETWEEN 1 AND 200),
  request_fingerprint TEXT NOT NULL
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  result_message_id INTEGER REFERENCES messages(id) ON DELETE RESTRICT,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT business_job_customer_message_assignment_fk
    FOREIGN KEY (assignment_id, contractor_profile_id, job_id, membership_id)
    REFERENCES business_job_assignments(id, contractor_profile_id, job_id, membership_id)
    ON DELETE RESTRICT,
  CONSTRAINT business_job_customer_message_actor_fk
    FOREIGN KEY (membership_id, contractor_profile_id, actor_user_id)
    REFERENCES business_team_memberships(id, contractor_profile_id, user_id)
    ON DELETE RESTRICT,
  CONSTRAINT business_job_customer_message_result_check CHECK (
    (result_message_id IS NULL AND completed_at IS NULL)
    OR (result_message_id IS NOT NULL AND completed_at IS NOT NULL)
  ),
  UNIQUE (membership_id, assignment_id, idempotency_key),
  UNIQUE (result_message_id)
);

CREATE INDEX IF NOT EXISTS business_job_customer_message_assignment_idx
  ON business_job_customer_message_commands(assignment_id, created_at ASC, id ASC);

CREATE OR REPLACE FUNCTION validate_business_job_customer_message_command()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_activation_version INTEGER;
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM business_job_assignments assignments
      JOIN business_team_memberships memberships
        ON memberships.id = assignments.membership_id
       AND memberships.contractor_profile_id = assignments.contractor_profile_id
      JOIN jobs
        ON jobs.id = assignments.job_id
       AND jobs.lifecycle_contract_version = 2
      JOIN contractor_profiles profiles
        ON profiles.id = assignments.contractor_profile_id
      JOIN request_relationships relationships
        ON relationships.id = jobs.source_request_relationship_id
       AND relationships.post_id = jobs.job_request_id
       AND relationships.emergency_request_id IS NULL
       AND relationships.status = 'active'
       AND relationships.contractor_id = profiles.id
       AND relationships.professional_user_id = profiles.user_id
      JOIN request_selections selections
        ON selections.id = jobs.source_request_selection_id
       AND selections.request_relationship_id = relationships.id
       AND selections.post_id = jobs.job_request_id
       AND selections.selected_by_user_id = relationships.homeowner_id
       AND selections.contractor_id = profiles.id
       AND selections.professional_user_id = profiles.user_id
       AND selections.ended_at IS NULL
      JOIN conversations
        ON conversations.id = selections.conversation_id
       AND conversations.request_selection_id = selections.id
       AND conversations.relationship_id = relationships.id
       AND conversations.homeowner_id = relationships.homeowner_id
       AND conversations.contractor_id = profiles.id
       AND conversations.professional_user_id = profiles.user_id
     WHERE assignments.id = NEW.assignment_id
       AND assignments.contractor_profile_id = NEW.contractor_profile_id
       AND assignments.job_id = NEW.job_id
       AND assignments.membership_id = NEW.membership_id
       AND assignments.state = 'ACTIVE'
       AND memberships.user_id = NEW.actor_user_id
       AND memberships.status = 'ACTIVE'
       AND memberships.role = 'FIELD_EMPLOYEE'
  ) THEN
    RAISE EXCEPTION 'Delegated customer messaging requires the exact active Field Employee assignment';
  END IF;

  SELECT max(assignment_version)
    INTO current_activation_version
    FROM business_job_assignment_events
   WHERE assignment_id = NEW.assignment_id
     AND event_type IN ('ASSIGNED', 'REASSIGNED');

  IF current_activation_version IS NULL
     OR NEW.assignment_activation_version <> current_activation_version THEN
    RAISE EXCEPTION 'Delegated customer messaging activation identity is stale';
  END IF;

  IF NEW.result_message_id IS NOT NULL OR NEW.completed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Delegated customer message command must begin incomplete';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS business_job_customer_message_insert_guard
  ON business_job_customer_message_commands;
CREATE TRIGGER business_job_customer_message_insert_guard
BEFORE INSERT ON business_job_customer_message_commands
FOR EACH ROW EXECUTE FUNCTION validate_business_job_customer_message_command();

CREATE OR REPLACE FUNCTION protect_business_job_customer_message_command()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.completed_at IS NOT NULL
     OR OLD.result_message_id IS NOT NULL
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.contractor_profile_id IS DISTINCT FROM OLD.contractor_profile_id
     OR NEW.job_id IS DISTINCT FROM OLD.job_id
     OR NEW.assignment_id IS DISTINCT FROM OLD.assignment_id
     OR NEW.membership_id IS DISTINCT FROM OLD.membership_id
     OR NEW.assignment_activation_version IS DISTINCT FROM OLD.assignment_activation_version
     OR NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.request_fingerprint IS DISTINCT FROM OLD.request_fingerprint
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.result_message_id IS NULL
     OR NEW.completed_at IS NULL THEN
    RAISE EXCEPTION 'Delegated customer message command identity is immutable';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM messages
      JOIN conversations
        ON conversations.id = messages.conversation_id
      JOIN request_selections selections
        ON selections.id = conversations.request_selection_id
       AND selections.conversation_id = conversations.id
       AND selections.request_relationship_id = conversations.relationship_id
       AND selections.selected_by_user_id = conversations.homeowner_id
       AND selections.contractor_id = conversations.contractor_id
       AND selections.professional_user_id = conversations.professional_user_id
      JOIN jobs
        ON jobs.id = NEW.job_id
       AND jobs.source_request_selection_id = selections.id
       AND jobs.source_request_relationship_id = conversations.relationship_id
       AND jobs.job_request_id = selections.post_id
     WHERE messages.id = NEW.result_message_id
       AND conversations.contractor_id = NEW.contractor_profile_id
       AND messages.quote_request_id IS NULL
       AND messages.sender_id = conversations.professional_user_id
       AND messages.receiver_id = conversations.homeowner_id
       AND messages.message_type = 'text'
       AND NULLIF(btrim(messages.message_text), '') IS NOT NULL
       AND messages.image_url IS NULL
       AND messages.workflow_type IS NULL
       AND messages.workflow_status IS NULL
       AND COALESCE(messages.workflow_payload, '{}'::jsonb) = '{}'::jsonb
       AND messages.quote_id IS NULL
       AND messages.invoice_id IS NULL
       AND messages.job_id IS NULL
  ) THEN
    RAISE EXCEPTION 'Delegated authorship must reference the exact ordinary canonical business message';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS business_job_customer_message_update_guard
  ON business_job_customer_message_commands;
CREATE TRIGGER business_job_customer_message_update_guard
BEFORE UPDATE ON business_job_customer_message_commands
FOR EACH ROW EXECUTE FUNCTION protect_business_job_customer_message_command();

CREATE OR REPLACE FUNCTION protect_completed_business_job_customer_message_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.completed_at IS NOT NULL OR OLD.result_message_id IS NOT NULL THEN
    RAISE EXCEPTION 'Completed delegated customer message evidence cannot be deleted';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS business_job_customer_message_delete_guard
  ON business_job_customer_message_commands;
CREATE TRIGGER business_job_customer_message_delete_guard
BEFORE DELETE ON business_job_customer_message_commands
FOR EACH ROW EXECUTE FUNCTION protect_completed_business_job_customer_message_delete();

COMMENT ON TABLE business_job_customer_message_commands IS
  'Replay-safe delegated Field Employee command and immutable authorship provenance for ordinary canonical business-to-customer messages.';
