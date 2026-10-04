-- MEETRO SAVED PROFESSIONALS FOUNDATION
--
-- Homeowner-owned bookmark state for a real Meetro business/professional.
--
-- Saving a professional is preference only.
--
-- It does NOT:
-- - create a Customer Relationship
-- - prove prior work
-- - create a Job Request
-- - create a Lead
-- - create a Professional Response
-- - select a professional
-- - create a Conversation
-- - create a Job
-- - create a Quote, Invoice, approval, payment, or schedule
-- - grant marketplace, communication, commercial, or lifecycle authority

CREATE TABLE IF NOT EXISTS homeowner_saved_professionals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  homeowner_user_id INTEGER NOT NULL
    REFERENCES users(id)
    ON DELETE RESTRICT,

  contractor_profile_id INTEGER NOT NULL,

  professional_user_id INTEGER NOT NULL,

  status TEXT NOT NULL DEFAULT 'SAVED'
    CHECK (status IN ('SAVED', 'REMOVED')),

  version INTEGER NOT NULL DEFAULT 1
    CHECK (version > 0),

  saved_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  removed_at TIMESTAMPTZ NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT homeowner_saved_professionals_business_identity_fk
    FOREIGN KEY (
      contractor_profile_id,
      professional_user_id
    )
    REFERENCES contractor_profiles(
      id,
      user_id
    )
    ON DELETE RESTRICT,

  CONSTRAINT homeowner_saved_professionals_distinct_users_check
    CHECK (homeowner_user_id <> professional_user_id),

  CONSTRAINT homeowner_saved_professionals_state_check
    CHECK (
      (
        status = 'SAVED'
        AND removed_at IS NULL
      )
      OR
      (
        status = 'REMOVED'
        AND removed_at IS NOT NULL
        AND removed_at >= saved_at
      )
    ),

  -- One bookmark state per homeowner/business pair.
  CONSTRAINT homeowner_saved_professionals_homeowner_business_key
    UNIQUE (
      homeowner_user_id,
      contractor_profile_id
    ),

  CONSTRAINT homeowner_saved_professionals_identity_tuple_key
    UNIQUE (
      id,
      homeowner_user_id,
      contractor_profile_id,
      professional_user_id
    )
);

CREATE INDEX IF NOT EXISTS
  homeowner_saved_professionals_active_homeowner_idx
ON homeowner_saved_professionals(
  homeowner_user_id,
  saved_at DESC,
  contractor_profile_id
)
WHERE status = 'SAVED';

CREATE INDEX IF NOT EXISTS
  homeowner_saved_professionals_business_idx
ON homeowner_saved_professionals(
  contractor_profile_id,
  status,
  updated_at DESC,
  homeowner_user_id
);

-- Idempotent mutation ledger.
--
-- This preserves explicit Save / Remove commands while the primary table
-- represents current bookmark state.

CREATE TABLE IF NOT EXISTS homeowner_saved_professional_commands (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  homeowner_user_id INTEGER NOT NULL
    REFERENCES users(id)
    ON DELETE RESTRICT,

  operation TEXT NOT NULL
    CHECK (operation IN ('SAVE', 'REMOVE')),

  idempotency_key UUID NOT NULL,

  request_hash TEXT NOT NULL
    CHECK (request_hash ~ '^[0-9a-f]{64}$'),

  contractor_profile_id INTEGER NOT NULL,

  professional_user_id INTEGER NOT NULL,

  saved_professional_id UUID NULL,

  response_json JSONB NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  completed_at TIMESTAMPTZ NULL,

  CONSTRAINT homeowner_saved_professional_commands_business_identity_fk
    FOREIGN KEY (
      contractor_profile_id,
      professional_user_id
    )
    REFERENCES contractor_profiles(
      id,
      user_id
    )
    ON DELETE RESTRICT,

  CONSTRAINT homeowner_saved_professional_commands_saved_identity_fk
    FOREIGN KEY (
      saved_professional_id,
      homeowner_user_id,
      contractor_profile_id,
      professional_user_id
    )
    REFERENCES homeowner_saved_professionals(
      id,
      homeowner_user_id,
      contractor_profile_id,
      professional_user_id
    )
    ON DELETE RESTRICT,

  CONSTRAINT homeowner_saved_professional_commands_actor_operation_key
    UNIQUE (
      homeowner_user_id,
      operation,
      idempotency_key
    )
);

CREATE INDEX IF NOT EXISTS
  homeowner_saved_professional_commands_homeowner_idx
ON homeowner_saved_professional_commands(
  homeowner_user_id,
  created_at DESC,
  id
);

CREATE OR REPLACE FUNCTION
guard_homeowner_saved_professional_state()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'Saved Professional history cannot be deleted.'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.homeowner_user_id IS DISTINCT FROM OLD.homeowner_user_id
     OR NEW.contractor_profile_id IS DISTINCT FROM OLD.contractor_profile_id
     OR NEW.professional_user_id IS DISTINCT FROM OLD.professional_user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION
      'Saved Professional identity and ownership are immutable.'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION
      'Saved Professional updates require the next version.'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.status = NEW.status THEN
    RAISE EXCEPTION
      'Saved Professional updates require a state transition.'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.status = 'SAVED'
     AND NEW.status = 'REMOVED' THEN
    IF NEW.saved_at IS DISTINCT FROM OLD.saved_at
       OR NEW.removed_at IS NULL THEN
      RAISE EXCEPTION
        'Removing a Saved Professional must preserve the save timestamp.'
        USING ERRCODE = '23514';
    END IF;
  ELSIF OLD.status = 'REMOVED'
        AND NEW.status = 'SAVED' THEN
    IF NEW.removed_at IS NOT NULL
       OR NEW.saved_at <= OLD.saved_at THEN
      RAISE EXCEPTION
        'Re-saving a professional requires a new save timestamp.'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION
      'Unsupported Saved Professional state transition.'
      USING ERRCODE = '23514';
  END IF;

  NEW.updated_at := CURRENT_TIMESTAMP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER homeowner_saved_professionals_history_guard
BEFORE UPDATE OR DELETE ON homeowner_saved_professionals
FOR EACH ROW
EXECUTE FUNCTION guard_homeowner_saved_professional_state();

COMMENT ON TABLE homeowner_saved_professionals IS
  'Homeowner-owned current Save/Remove bookmark state for an exact Meetro business. Saving is preference only and grants no Customer Relationship, marketplace, communication, commercial, Job, or lifecycle authority.';

COMMENT ON TABLE homeowner_saved_professional_commands IS
  'Idempotent homeowner Save/Remove command ledger for professional bookmarks. Commands grant no relationship or work authority.';
