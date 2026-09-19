CREATE TABLE IF NOT EXISTS business_complimentary_access_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  contractor_profile_id INTEGER NOT NULL
    REFERENCES contractor_profiles(id) ON DELETE RESTRICT,

  grant_type TEXT NOT NULL
    CHECK (
      grant_type IN (
        'TESTFLIGHT_STARTER',
        'FULL_COMPLIMENTARY'
      )
    ),

  effective_plan TEXT NOT NULL
    CHECK (
      effective_plan IN (
        'COMMUNITY_2_USER_MONTHLY',
        'COMMUNITY_10_USER_MONTHLY'
      )
    ),

  seat_limit INTEGER NOT NULL
    CHECK (seat_limit IN (2, 10)),

  grant_reason TEXT NOT NULL
    CHECK (
      grant_reason IN (
        'TESTFLIGHT_TESTER',
        'BGONE_PERMANENT'
      )
    ),

  granted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at TIMESTAMPTZ,

  version INTEGER NOT NULL DEFAULT 1
    CHECK (version >= 1),

  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CHECK (
    (
      grant_type = 'TESTFLIGHT_STARTER'
      AND effective_plan = 'COMMUNITY_2_USER_MONTHLY'
      AND seat_limit = 2
      AND grant_reason = 'TESTFLIGHT_TESTER'
    )
    OR
    (
      grant_type = 'FULL_COMPLIMENTARY'
      AND effective_plan = 'COMMUNITY_10_USER_MONTHLY'
      AND seat_limit = 10
      AND grant_reason = 'BGONE_PERMANENT'
    )
  ),

  CHECK (
    revoked_at IS NULL
    OR revoked_at >= granted_at
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS
  business_complimentary_access_one_active_grant_idx
ON business_complimentary_access_grants(contractor_profile_id)
WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS
  business_complimentary_access_history_idx
ON business_complimentary_access_grants(
  contractor_profile_id,
  granted_at DESC
);

CREATE OR REPLACE FUNCTION protect_business_complimentary_access_authority()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.contractor_profile_id IS DISTINCT FROM OLD.contractor_profile_id
     OR NEW.grant_type IS DISTINCT FROM OLD.grant_type
     OR NEW.effective_plan IS DISTINCT FROM OLD.effective_plan
     OR NEW.seat_limit IS DISTINCT FROM OLD.seat_limit
     OR NEW.grant_reason IS DISTINCT FROM OLD.grant_reason
     OR NEW.granted_at IS DISTINCT FROM OLD.granted_at THEN
    RAISE EXCEPTION 'Business complimentary access authority is immutable';
  END IF;

  IF OLD.revoked_at IS NOT NULL
     AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'Revoked complimentary access cannot be restored in place';
  END IF;

  NEW.version := OLD.version + 1;
  NEW.updated_at := CURRENT_TIMESTAMP;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  business_complimentary_access_authority_guard
ON business_complimentary_access_grants;

CREATE TRIGGER business_complimentary_access_authority_guard
BEFORE UPDATE ON business_complimentary_access_grants
FOR EACH ROW
EXECUTE FUNCTION protect_business_complimentary_access_authority();

CREATE OR REPLACE FUNCTION prevent_business_complimentary_access_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Business complimentary access history cannot be deleted';
END;
$$;

DROP TRIGGER IF EXISTS
  business_complimentary_access_delete_guard
ON business_complimentary_access_grants;

CREATE TRIGGER business_complimentary_access_delete_guard
BEFORE DELETE ON business_complimentary_access_grants
FOR EACH ROW
EXECUTE FUNCTION prevent_business_complimentary_access_delete();
