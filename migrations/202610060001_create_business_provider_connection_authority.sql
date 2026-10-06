-- Provider-neutral internal authority. Public R2 discovery remains COMING_SOON.
-- The migration runner owns BEGIN/COMMIT and checksum tracking.
CREATE TABLE IF NOT EXISTS business_provider_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_profile_id INTEGER NOT NULL REFERENCES contractor_profiles(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK (provider IN (
    'STRIPE_PAYMENTS', 'QUICKBOOKS', 'GOOGLE_CALENDAR', 'MICROSOFT_OUTLOOK_CALENDAR'
  )),
  provider_environment TEXT NOT NULL CHECK (provider_environment IN ('TEST', 'LIVE')),
  provider_account_id TEXT CHECK (
    provider_account_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,254}$'
    AND (provider <> 'STRIPE_PAYMENTS' OR provider_account_id !~* '^cus_')
  ),
  connection_status TEXT NOT NULL DEFAULT 'NOT_CONNECTED' CHECK (
    connection_status IN ('NOT_CONNECTED', 'CONNECTED', 'NEEDS_ATTENTION', 'UNAVAILABLE')
  ),
  last_verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  -- Stronger than per-mode uniqueness: one authoritative connection per pair.
  -- Its environment cannot be silently changed; TEST and LIVE reads stay isolated.
  UNIQUE (contractor_profile_id, provider),
  CHECK (connection_status <> 'CONNECTED' OR
    (provider_account_id IS NOT NULL AND last_verified_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS business_provider_connections_account_uidx
  ON business_provider_connections(provider, provider_environment, provider_account_id)
  WHERE provider_account_id IS NOT NULL;

CREATE OR REPLACE FUNCTION protect_business_provider_connection_authority()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Business provider connection authority cannot be deleted';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.contractor_profile_id IS DISTINCT FROM OLD.contractor_profile_id
     OR NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.provider_environment IS DISTINCT FROM OLD.provider_environment
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (OLD.provider_account_id IS NOT NULL AND
         NEW.provider_account_id IS DISTINCT FROM OLD.provider_account_id)
     OR (OLD.last_verified_at IS NOT NULL AND
         (NEW.last_verified_at IS NULL OR NEW.last_verified_at < OLD.last_verified_at)) THEN
    RAISE EXCEPTION 'Business provider connection ownership and verified history are immutable';
  END IF;
  NEW.version := OLD.version + 1;
  NEW.updated_at := CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS business_provider_connection_authority_guard ON business_provider_connections;
CREATE TRIGGER business_provider_connection_authority_guard
BEFORE UPDATE OR DELETE ON business_provider_connections
FOR EACH ROW EXECUTE FUNCTION protect_business_provider_connection_authority();
