CREATE TABLE IF NOT EXISTS meetro_business_trials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  contractor_profile_id INTEGER NOT NULL UNIQUE REFERENCES contractor_profiles(id) ON DELETE RESTRICT,
  created_reason TEXT NOT NULL CHECK (created_reason IN ('PROFESSIONAL_SIGNUP', 'BUSINESS_ACTIVATION')),
  reserved_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  converted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((starts_at IS NULL) = (ends_at IS NULL)),
  CHECK (starts_at IS NULL OR ends_at = starts_at + INTERVAL '14 days'),
  CHECK (converted_at IS NULL OR (starts_at IS NOT NULL AND converted_at >= starts_at))
);

CREATE INDEX IF NOT EXISTS meetro_business_trials_profile_idx
  ON meetro_business_trials(contractor_profile_id);

CREATE INDEX IF NOT EXISTS meetro_business_trials_access_idx
  ON meetro_business_trials(user_id, ends_at DESC)
  WHERE starts_at IS NOT NULL AND converted_at IS NULL;

CREATE OR REPLACE FUNCTION protect_meetro_business_trial_authority()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.created_reason IS DISTINCT FROM OLD.created_reason
     OR NEW.reserved_at IS DISTINCT FROM OLD.reserved_at
     OR OLD.contractor_profile_id IS NOT NULL
        AND NEW.contractor_profile_id IS DISTINCT FROM OLD.contractor_profile_id
     OR OLD.starts_at IS NOT NULL AND NEW.starts_at IS DISTINCT FROM OLD.starts_at
     OR OLD.ends_at IS NOT NULL AND NEW.ends_at IS DISTINCT FROM OLD.ends_at
     OR OLD.converted_at IS NOT NULL AND NEW.converted_at IS DISTINCT FROM OLD.converted_at THEN
    RAISE EXCEPTION 'Meetro Business Trial authority is immutable';
  END IF;
  NEW.updated_at := CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS meetro_business_trial_authority_guard ON meetro_business_trials;
CREATE TRIGGER meetro_business_trial_authority_guard
BEFORE UPDATE ON meetro_business_trials
FOR EACH ROW EXECUTE FUNCTION protect_meetro_business_trial_authority();
