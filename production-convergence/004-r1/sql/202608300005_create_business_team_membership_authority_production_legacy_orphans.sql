CREATE TABLE IF NOT EXISTS business_team_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_profile_id INTEGER NOT NULL REFERENCES contractor_profiles(id) ON DELETE RESTRICT,
  email_normalized TEXT NOT NULL CHECK (
    email_normalized = lower(btrim(email_normalized))
    AND email_normalized ~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$'
  ),
  display_name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL CHECK (role IN ('MANAGER', 'BOOKKEEPER_FINANCE', 'FIELD_EMPLOYEE')),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED')),
  token_digest TEXT NOT NULL UNIQUE CHECK (token_digest ~ '^[0-9a-f]{64}$'),
  invited_by_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  accepted_by_user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK (expires_at > created_at),
  CHECK ((status = 'ACCEPTED') = (accepted_by_user_id IS NOT NULL AND accepted_at IS NOT NULL)),
  CHECK ((status = 'REVOKED') = (revoked_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS business_team_invitations_pending_email_uidx
  ON business_team_invitations(contractor_profile_id, email_normalized)
  WHERE status = 'PENDING';

CREATE INDEX IF NOT EXISTS business_team_invitations_recipient_idx
  ON business_team_invitations(email_normalized, status, expires_at DESC);

CREATE TABLE IF NOT EXISTS business_team_memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_profile_id INTEGER NOT NULL REFERENCES contractor_profiles(id) ON DELETE RESTRICT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  invitation_id UUID UNIQUE REFERENCES business_team_invitations(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN ('OWNER', 'MANAGER', 'BOOKKEEPER_FINANCE', 'FIELD_EMPLOYEE')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DEACTIVATED')),
  activated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deactivated_at TIMESTAMPTZ,
  created_by_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (contractor_profile_id, user_id),
  CHECK ((status = 'DEACTIVATED') = (deactivated_at IS NOT NULL)),
  CHECK (role <> 'OWNER' OR (status = 'ACTIVE' AND invitation_id IS NULL))
);

CREATE INDEX IF NOT EXISTS business_team_memberships_actor_idx
  ON business_team_memberships(user_id, status, contractor_profile_id);

CREATE INDEX IF NOT EXISTS business_team_memberships_business_idx
  ON business_team_memberships(contractor_profile_id, status, role);

INSERT INTO business_team_memberships
  (contractor_profile_id, user_id, role, status, activated_at, created_by_user_id)
SELECT profiles.id,
       profiles.user_id,
       'OWNER',
       'ACTIVE',
       COALESCE(profiles.created_at, CURRENT_TIMESTAMP),
       profiles.user_id
FROM contractor_profiles profiles
JOIN users ON users.id = profiles.user_id
ON CONFLICT (contractor_profile_id, user_id) DO NOTHING;

CREATE OR REPLACE FUNCTION protect_business_team_invitation_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.contractor_profile_id IS DISTINCT FROM OLD.contractor_profile_id
     OR NEW.email_normalized IS DISTINCT FROM OLD.email_normalized
     OR NEW.role IS DISTINCT FROM OLD.role
     OR NEW.token_digest IS DISTINCT FROM OLD.token_digest
     OR NEW.invited_by_user_id IS DISTINCT FROM OLD.invited_by_user_id
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR OLD.status <> 'PENDING'
     OR NEW.status NOT IN ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED') THEN
    RAISE EXCEPTION 'Business Team invitation authority is immutable';
  END IF;
  NEW.version := OLD.version + 1;
  NEW.updated_at := CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS business_team_invitation_history_guard ON business_team_invitations;
CREATE TRIGGER business_team_invitation_history_guard
BEFORE UPDATE ON business_team_invitations
FOR EACH ROW EXECUTE FUNCTION protect_business_team_invitation_history();

CREATE OR REPLACE FUNCTION protect_business_team_membership_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.contractor_profile_id IS DISTINCT FROM OLD.contractor_profile_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.invitation_id IS DISTINCT FROM OLD.invitation_id
     OR NEW.activated_at IS DISTINCT FROM OLD.activated_at
     OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
     OR OLD.status = 'DEACTIVATED'
     OR OLD.role = 'OWNER' AND NEW.role IS DISTINCT FROM OLD.role THEN
    RAISE EXCEPTION 'Business Team membership authority is immutable';
  END IF;
  NEW.version := OLD.version + 1;
  NEW.updated_at := CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS business_team_membership_history_guard ON business_team_memberships;
CREATE TRIGGER business_team_membership_history_guard
BEFORE UPDATE ON business_team_memberships
FOR EACH ROW EXECUTE FUNCTION protect_business_team_membership_history();

CREATE OR REPLACE FUNCTION reject_business_team_history_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Business Team history cannot be deleted';
END;
$$;

DROP TRIGGER IF EXISTS business_team_invitation_delete_guard ON business_team_invitations;
CREATE TRIGGER business_team_invitation_delete_guard
BEFORE DELETE ON business_team_invitations
FOR EACH ROW EXECUTE FUNCTION reject_business_team_history_delete();

DROP TRIGGER IF EXISTS business_team_membership_delete_guard ON business_team_memberships;
CREATE TRIGGER business_team_membership_delete_guard
BEFORE DELETE ON business_team_memberships
FOR EACH ROW EXECUTE FUNCTION reject_business_team_history_delete();
