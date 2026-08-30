-- Team invitation delivery credentials are rotatable while the
-- canonical invitation remains PENDING.
--
-- Business identity, recipient identity, role, inviter, expiration,
-- lifecycle history, and post-pending history remain immutable.
--
-- token_digest is a hashed security credential, not business authority.

CREATE OR REPLACE FUNCTION protect_business_team_invitation_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.contractor_profile_id IS DISTINCT FROM OLD.contractor_profile_id
     OR NEW.email_normalized IS DISTINCT FROM OLD.email_normalized
     OR NEW.role IS DISTINCT FROM OLD.role
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
