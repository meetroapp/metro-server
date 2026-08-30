ALTER TABLE professional_subscription_accounts
  ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS professional_subscription_accounts_stripe_customer_uidx
  ON professional_subscription_accounts(stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

ALTER TABLE professional_subscriptions
  DROP CONSTRAINT IF EXISTS professional_subscriptions_provider_check;
ALTER TABLE professional_subscriptions
  ADD CONSTRAINT professional_subscriptions_provider_check
  CHECK (provider IN ('APPLE_APP_STORE', 'STRIPE'));

ALTER TABLE professional_subscriptions
  DROP CONSTRAINT IF EXISTS professional_subscriptions_provider_environment_check;
ALTER TABLE professional_subscriptions
  ADD CONSTRAINT professional_subscriptions_provider_environment_check
  CHECK (provider_environment IN ('SANDBOX', 'PRODUCTION', 'XCODE', 'TEST', 'LIVE'));

ALTER TABLE professional_subscription_provider_events
  DROP CONSTRAINT IF EXISTS professional_subscription_provider_events_provider_check;
ALTER TABLE professional_subscription_provider_events
  ADD CONSTRAINT professional_subscription_provider_events_provider_check
  CHECK (provider IN ('APPLE_APP_STORE', 'STRIPE'));
