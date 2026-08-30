CREATE TABLE IF NOT EXISTS professional_subscription_accounts (
  contractor_profile_id INTEGER PRIMARY KEY REFERENCES contractor_profiles(id) ON DELETE CASCADE,
  app_account_token UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS professional_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_profile_id INTEGER NOT NULL UNIQUE REFERENCES contractor_profiles(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('APPLE_APP_STORE')),
  provider_environment TEXT NOT NULL CHECK (provider_environment IN ('SANDBOX', 'PRODUCTION', 'XCODE')),
  provider_product_id TEXT NOT NULL,
  provider_original_transaction_id TEXT NOT NULL UNIQUE,
  latest_provider_transaction_id TEXT NOT NULL UNIQUE,
  effective_plan TEXT NOT NULL CHECK (effective_plan IN ('COMMUNITY_2_USER_MONTHLY', 'COMMUNITY_5_USER_MONTHLY')),
  status TEXT NOT NULL CHECK (status IN ('TRIAL', 'ACTIVE', 'GRACE', 'CANCELED_AT_PERIOD_END', 'EXPIRED', 'REVOKED')),
  seat_limit INTEGER NOT NULL CHECK (seat_limit IN (2, 5)),
  access_started_at TIMESTAMPTZ NOT NULL,
  access_ends_at TIMESTAMPTZ NOT NULL,
  trial_eligible BOOLEAN,
  trial_ends_at TIMESTAMPTZ,
  will_auto_renew BOOLEAN,
  grace_period_ends_at TIMESTAMPTZ,
  canceled_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  last_verified_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (access_ends_at > access_started_at),
  CHECK ((status = 'TRIAL') = (trial_ends_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS professional_subscriptions_access_idx
  ON professional_subscriptions(contractor_profile_id, status, access_ends_at DESC);

CREATE TABLE IF NOT EXISTS professional_subscription_provider_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL CHECK (provider IN ('APPLE_APP_STORE')),
  provider_event_id TEXT NOT NULL,
  provider_original_transaction_id TEXT NOT NULL,
  provider_transaction_id TEXT NOT NULL,
  contractor_profile_id INTEGER NOT NULL REFERENCES contractor_profiles(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (provider, provider_event_id)
);

CREATE INDEX IF NOT EXISTS professional_subscription_events_owner_idx
  ON professional_subscription_provider_events(contractor_profile_id, received_at DESC);

CREATE OR REPLACE FUNCTION prevent_professional_subscription_identity_rewrite()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.contractor_profile_id IS DISTINCT FROM OLD.contractor_profile_id
     OR NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.provider_original_transaction_id IS DISTINCT FROM OLD.provider_original_transaction_id THEN
    RAISE EXCEPTION 'Professional subscription identity is immutable';
  END IF;
  NEW.version := OLD.version + 1;
  NEW.updated_at := CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS professional_subscription_identity_guard ON professional_subscriptions;
CREATE TRIGGER professional_subscription_identity_guard
BEFORE UPDATE ON professional_subscriptions
FOR EACH ROW EXECUTE FUNCTION prevent_professional_subscription_identity_rewrite();
