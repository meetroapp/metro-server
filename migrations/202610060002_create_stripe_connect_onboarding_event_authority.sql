-- Dormant internal Connect authority only. No provider, financial or data backfill.
-- Runner owns transaction/checksum tracking. Migration 111 is immutable.
CREATE TABLE IF NOT EXISTS business_provider_connection_operations (
  id UUID PRIMARY KEY,
  connection_id UUID NOT NULL REFERENCES business_provider_connections(id) ON DELETE RESTRICT,
  provider_scope_id TEXT NOT NULL CHECK (provider_scope_id ~ '^[A-Za-z0-9_.:/-]{1,200}$'),
  operation_kind TEXT NOT NULL DEFAULT 'CREATE_ACCOUNT' CHECK (operation_kind = 'CREATE_ACCOUNT'),
  api_model TEXT NOT NULL DEFAULT 'ACCOUNTS_V2' CHECK (api_model = 'ACCOUNTS_V2'),
  api_version TEXT NOT NULL CHECK (api_version = '2026-08-26.dahlia'),
  stripe_idempotency_key UUID NOT NULL,
  request_sha256 CHAR(64) NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  creation_intent JSONB NOT NULL CHECK (jsonb_typeof(creation_intent) = 'object'),
  created_by_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  operation_status TEXT NOT NULL DEFAULT 'RESERVED' CHECK (operation_status IN
    ('RESERVED','IN_FLIGHT','AMBIGUOUS','SUCCEEDED','REJECTED_NO_ACCOUNT','RECOVERY_REQUIRED')),
  provider_account_id TEXT CHECK (provider_account_id ~ '^acct_[A-Za-z0-9]{1,240}$'),
  provider_request_id TEXT CHECK (provider_request_id ~ '^req_[A-Za-z0-9]{1,240}$'),
  first_dispatched_at TIMESTAMPTZ, replay_deadline_at TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_generation BIGINT NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
  lease_expires_at TIMESTAMPTZ, next_attempt_at TIMESTAMPTZ,
  last_error_code TEXT CHECK (last_error_code IN ('PROVIDER_UNCERTAIN','PROVIDER_REJECTED_NO_ACCOUNT')),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (connection_id,operation_kind), UNIQUE (provider_scope_id,stripe_idempotency_key),
  CHECK ((first_dispatched_at IS NULL) = (replay_deadline_at IS NULL)),
  CHECK (replay_deadline_at IS NULL OR replay_deadline_at = first_dispatched_at + interval '29 days'),
  CHECK (operation_status NOT IN ('IN_FLIGHT','AMBIGUOUS','SUCCEEDED','REJECTED_NO_ACCOUNT') OR first_dispatched_at IS NOT NULL),
  CHECK (operation_status <> 'IN_FLIGHT' OR lease_expires_at IS NOT NULL),
  CHECK ((operation_status = 'SUCCEEDED') = (provider_account_id IS NOT NULL)),
  CHECK ((operation_status = 'SUCCEEDED') = (completed_at IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS business_provider_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL DEFAULT 'STRIPE_PAYMENTS' CHECK (provider = 'STRIPE_PAYMENTS'),
  provider_scope_id TEXT NOT NULL CHECK (provider_scope_id ~ '^[A-Za-z0-9_.:/-]{1,200}$'),
  provider_environment TEXT NOT NULL CHECK (provider_environment IN ('TEST','LIVE')),
  event_domain TEXT NOT NULL DEFAULT 'ACCOUNT_LIFECYCLE' CHECK (event_domain = 'ACCOUNT_LIFECYCLE'),
  provider_event_id TEXT NOT NULL CHECK (provider_event_id ~ '^[A-Za-z0-9_.-]{1,255}$'),
  provider_account_id TEXT CHECK (provider_account_id ~ '^acct_[A-Za-z0-9]{1,240}$'),
  connection_id UUID REFERENCES business_provider_connections(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (length(event_type) BETWEEN 1 AND 255),
  payload_format TEXT NOT NULL CHECK (payload_format IN ('THIN','SNAPSHOT')),
  livemode BOOLEAN NOT NULL,
  event_api_version TEXT CHECK (length(event_api_version) BETWEEN 1 AND 100),
  retrieval_api_version TEXT CHECK (retrieval_api_version = '2026-08-26.dahlia'),
  provider_context TEXT CHECK (length(provider_context) <= 200),
  related_object_type TEXT CHECK (length(related_object_type) <= 100),
  related_object_id TEXT CHECK (length(related_object_id) <= 255),
  provider_created_at TIMESTAMPTZ,
  payload_sha256 CHAR(64) NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  first_received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at TIMESTAMPTZ,
  processing_status TEXT NOT NULL CHECK (processing_status IN
    ('RECEIVED','PROCESSING','PROCESSED','RETRY','IGNORED','QUARANTINED','REVIEW_REQUIRED')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_generation BIGINT NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
  lease_expires_at TIMESTAMPTZ, next_attempt_at TIMESTAMPTZ,
  last_error_code TEXT CHECK (last_error_code IN
    ('PROVIDER_UNAVAILABLE','ACCOUNT_SHAPE_UNSUPPORTED','ACCOUNT_SCOPE_MISMATCH','PAYLOAD_CONFLICT','RECONCILIATION_CONFLICT')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (provider,provider_scope_id,provider_environment,provider_event_id),
  CHECK (livemode = (provider_environment = 'LIVE')),
  CHECK (processing_status <> 'PROCESSED' OR (processed_at IS NOT NULL AND connection_id IS NOT NULL)),
  CHECK (processing_status <> 'PROCESSING' OR (lease_expires_at IS NOT NULL AND connection_id IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS business_provider_connection_readiness (
  connection_id UUID PRIMARY KEY REFERENCES business_provider_connections(id) ON DELETE RESTRICT,
  provider_scope_id TEXT NOT NULL CHECK (provider_scope_id ~ '^[A-Za-z0-9_.:/-]{1,200}$'),
  api_model TEXT NOT NULL DEFAULT 'ACCOUNTS_V2' CHECK (api_model = 'ACCOUNTS_V2'),
  verification_api_version TEXT NOT NULL CHECK (verification_api_version = '2026-08-26.dahlia'),
  verification_status TEXT NOT NULL DEFAULT 'UNVERIFIED' CHECK (verification_status IN ('UNVERIFIED','VERIFIED','FAILED','TERMINAL')),
  merchant_applied BOOLEAN,
  card_payments_status TEXT CHECK (card_payments_status IN ('active','pending','restricted','unsupported')),
  payouts_status TEXT CHECK (payouts_status IN ('active','pending','restricted','unsupported')),
  requirements_currently_due_count INTEGER CHECK (requirements_currently_due_count >= 0),
  requirements_past_due_count INTEGER CHECK (requirements_past_due_count >= 0),
  blocking_error_count INTEGER CHECK (blocking_error_count >= 0),
  future_requirements_due_at TIMESTAMPTZ,
  responsibilities_match BOOLEAN, scope_match BOOLEAN, closed BOOLEAN,
  deauthorized BOOLEAN NOT NULL DEFAULT FALSE,
  last_retrieved_at TIMESTAMPTZ, stale_after TIMESTAMPTZ, invalidated_at TIMESTAMPTZ,
  invalidation_generation BIGINT NOT NULL DEFAULT 0 CHECK (invalidation_generation >= 0),
  last_error_code TEXT CHECK (last_error_code IN ('PROVIDER_UNAVAILABLE','ACCOUNT_SHAPE_UNSUPPORTED','ACCOUNT_SCOPE_MISMATCH')),
  last_successful_event_ledger_id UUID REFERENCES business_provider_events(id) ON DELETE RESTRICT,
  next_reconcile_at TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_generation BIGINT NOT NULL DEFAULT 0 CHECK (lease_generation >= 0), lease_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK ((last_retrieved_at IS NULL) = (stale_after IS NULL)),
  CHECK (stale_after IS NULL OR stale_after > last_retrieved_at),
  CHECK (verification_status <> 'VERIFIED' OR
    (merchant_applied IS NOT NULL AND card_payments_status IS NOT NULL AND payouts_status IS NOT NULL
     AND requirements_currently_due_count IS NOT NULL AND requirements_past_due_count IS NOT NULL
     AND blocking_error_count IS NOT NULL AND responsibilities_match IS NOT NULL AND scope_match IS NOT NULL
     AND closed IS NOT NULL AND last_retrieved_at IS NOT NULL)),
  CHECK (NOT deauthorized OR verification_status = 'TERMINAL'),
  CHECK (closed IS DISTINCT FROM TRUE OR verification_status = 'TERMINAL')
);
CREATE INDEX IF NOT EXISTS business_provider_events_retry_idx ON business_provider_events(processing_status,next_attempt_at);
CREATE INDEX IF NOT EXISTS business_provider_events_account_idx ON business_provider_events(provider_scope_id,provider_environment,provider_account_id,first_received_at);
CREATE INDEX IF NOT EXISTS business_provider_readiness_reconcile_idx ON business_provider_connection_readiness(next_reconcile_at);

CREATE OR REPLACE FUNCTION protect_stripe_connect_operations() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c business_provider_connections%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Connect creation history cannot be deleted'; END IF;
  SELECT * INTO c FROM business_provider_connections WHERE id=NEW.connection_id;
  IF c.provider IS DISTINCT FROM 'STRIPE_PAYMENTS' THEN RAISE EXCEPTION 'Connect operation scope mismatch'; END IF;
  IF NEW.creation_intent - ARRAY['country','currency','dashboard','cardRequested','feesCollector','lossesCollector','operationId','connectionId'] <> '{}'::jsonb
    OR (SELECT count(*) FROM jsonb_object_keys(NEW.creation_intent)) <> 8
    OR NEW.creation_intent->>'country' !~ '^[a-z]{2}$' OR NEW.creation_intent->>'currency' !~ '^[a-z]{3}$'
    OR NEW.creation_intent->>'dashboard' IS DISTINCT FROM 'full'
    OR NEW.creation_intent->'cardRequested' IS DISTINCT FROM 'true'::jsonb
    OR NEW.creation_intent->>'feesCollector' IS DISTINCT FROM 'stripe'
    OR NEW.creation_intent->>'lossesCollector' IS DISTINCT FROM 'stripe'
    OR NEW.creation_intent->>'operationId' IS DISTINCT FROM NEW.id::text
    OR NEW.creation_intent->>'connectionId' IS DISTINCT FROM NEW.connection_id::text THEN
    RAISE EXCEPTION 'Connect creation intent invalid';
  END IF;
  IF NEW.operation_status='SUCCEEDED' AND c.provider_account_id IS DISTINCT FROM NEW.provider_account_id THEN
    RAISE EXCEPTION 'Connect operation account mismatch'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.operation_status <> 'RESERVED' OR NOT EXISTS (SELECT 1 FROM business_team_memberships
      WHERE contractor_profile_id=c.contractor_profile_id AND user_id=NEW.created_by_user_id AND role='OWNER' AND status='ACTIVE') THEN
      RAISE EXCEPTION 'Connect operation requires Owner'; END IF;
  ELSE
    IF ROW(NEW.id,NEW.connection_id,NEW.provider_scope_id,NEW.operation_kind,NEW.api_model,NEW.api_version,
      NEW.stripe_idempotency_key,NEW.request_sha256,NEW.creation_intent,NEW.created_by_user_id,NEW.created_at)
      IS DISTINCT FROM ROW(OLD.id,OLD.connection_id,OLD.provider_scope_id,OLD.operation_kind,OLD.api_model,OLD.api_version,
      OLD.stripe_idempotency_key,OLD.request_sha256,OLD.creation_intent,OLD.created_by_user_id,OLD.created_at)
      OR (OLD.first_dispatched_at IS NOT NULL AND ROW(NEW.first_dispatched_at,NEW.replay_deadline_at) IS DISTINCT FROM ROW(OLD.first_dispatched_at,OLD.replay_deadline_at))
      OR (OLD.provider_account_id IS NOT NULL AND ROW(NEW.provider_account_id,NEW.completed_at) IS DISTINCT FROM ROW(OLD.provider_account_id,OLD.completed_at))
      OR NEW.attempt_count < OLD.attempt_count OR NEW.lease_generation < OLD.lease_generation THEN
      RAISE EXCEPTION 'Connect creation intent/history immutable'; END IF;
    IF NEW.operation_status <> OLD.operation_status AND NOT
      ((OLD.operation_status='RESERVED' AND NEW.operation_status='IN_FLIGHT')
       OR (OLD.operation_status='IN_FLIGHT' AND NEW.operation_status IN ('SUCCEEDED','AMBIGUOUS','REJECTED_NO_ACCOUNT','RECOVERY_REQUIRED'))
       OR (OLD.operation_status='AMBIGUOUS' AND NEW.operation_status IN ('IN_FLIGHT','RECOVERY_REQUIRED'))) THEN
      RAISE EXCEPTION 'Connect operation transition invalid'; END IF;
    NEW.version := OLD.version+1; NEW.updated_at := CURRENT_TIMESTAMP;
  END IF;
  RETURN NEW;
END; $$;
CREATE OR REPLACE FUNCTION protect_stripe_connect_readiness() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c business_provider_connections%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Connect readiness history cannot be deleted'; END IF;
  SELECT * INTO c FROM business_provider_connections WHERE id=NEW.connection_id;
  IF c.provider IS DISTINCT FROM 'STRIPE_PAYMENTS' OR c.provider_account_id IS NULL OR NOT EXISTS
    (SELECT 1 FROM business_provider_connection_operations WHERE connection_id=c.id AND provider_scope_id=NEW.provider_scope_id
      AND operation_status='SUCCEEDED' AND provider_account_id=c.provider_account_id) THEN
    RAISE EXCEPTION 'Connect readiness binding mismatch'; END IF;
  IF NEW.last_successful_event_ledger_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM business_provider_events
      WHERE id=NEW.last_successful_event_ledger_id AND connection_id=c.id AND provider_scope_id=NEW.provider_scope_id) THEN
    RAISE EXCEPTION 'Connect readiness event mismatch'; END IF;
  IF TG_OP='UPDATE' THEN
    IF ROW(NEW.connection_id,NEW.provider_scope_id,NEW.api_model,NEW.verification_api_version,NEW.created_at)
      IS DISTINCT FROM ROW(OLD.connection_id,OLD.provider_scope_id,OLD.api_model,OLD.verification_api_version,OLD.created_at)
      OR (OLD.verification_status='TERMINAL' AND NEW.verification_status<>'TERMINAL')
      OR (OLD.deauthorized AND NOT NEW.deauthorized) OR (OLD.closed AND NEW.closed IS DISTINCT FROM TRUE)
      OR NEW.lease_generation<OLD.lease_generation OR NEW.invalidation_generation<OLD.invalidation_generation
      OR NEW.attempt_count<OLD.attempt_count
      OR (OLD.last_retrieved_at IS NOT NULL AND (NEW.last_retrieved_at IS NULL OR NEW.last_retrieved_at<OLD.last_retrieved_at)) THEN
      RAISE EXCEPTION 'Connect readiness history/fence immutable'; END IF;
    NEW.version:=OLD.version+1; NEW.updated_at:=CURRENT_TIMESTAMP;
  END IF;
  RETURN NEW;
END; $$;
CREATE OR REPLACE FUNCTION protect_stripe_connect_events() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Connect event identity cannot be deleted'; END IF;
  IF NEW.connection_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM business_provider_connections c
      JOIN business_provider_connection_operations o ON o.connection_id=c.id
      WHERE c.id=NEW.connection_id AND c.provider=NEW.provider AND c.provider_environment=NEW.provider_environment
      AND c.provider_account_id=NEW.provider_account_id AND o.provider_scope_id=NEW.provider_scope_id AND o.operation_status='SUCCEEDED') THEN
    RAISE EXCEPTION 'Connect event binding mismatch'; END IF;
  IF TG_OP='UPDATE' THEN
    IF ROW(NEW.id,NEW.provider,NEW.provider_scope_id,NEW.provider_environment,NEW.event_domain,NEW.provider_event_id,
      NEW.provider_account_id,NEW.connection_id,NEW.event_type,NEW.payload_format,NEW.livemode,NEW.event_api_version,
      NEW.provider_context,NEW.related_object_type,NEW.related_object_id,NEW.provider_created_at,NEW.payload_sha256,NEW.first_received_at,NEW.created_at)
      IS DISTINCT FROM ROW(OLD.id,OLD.provider,OLD.provider_scope_id,OLD.provider_environment,OLD.event_domain,OLD.provider_event_id,
      OLD.provider_account_id,OLD.connection_id,OLD.event_type,OLD.payload_format,OLD.livemode,OLD.event_api_version,
      OLD.provider_context,OLD.related_object_type,OLD.related_object_id,OLD.provider_created_at,OLD.payload_sha256,OLD.first_received_at,OLD.created_at)
      OR NEW.lease_generation<OLD.lease_generation OR NEW.attempt_count<OLD.attempt_count
      OR NEW.last_received_at<OLD.last_received_at
      OR (OLD.processing_status='PROCESSED' AND NEW.processing_status NOT IN ('PROCESSED','QUARANTINED'))
      OR (OLD.processed_at IS NOT NULL AND NEW.processed_at IS DISTINCT FROM OLD.processed_at) THEN
      RAISE EXCEPTION 'Connect event identity/history immutable'; END IF;
    NEW.version:=OLD.version+1; NEW.updated_at:=CURRENT_TIMESTAMP;
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS stripe_connect_operations_guard ON business_provider_connection_operations;
CREATE TRIGGER stripe_connect_operations_guard BEFORE INSERT OR UPDATE OR DELETE ON business_provider_connection_operations
FOR EACH ROW EXECUTE FUNCTION protect_stripe_connect_operations();
DROP TRIGGER IF EXISTS stripe_connect_readiness_guard ON business_provider_connection_readiness;
CREATE TRIGGER stripe_connect_readiness_guard BEFORE INSERT OR UPDATE OR DELETE ON business_provider_connection_readiness
FOR EACH ROW EXECUTE FUNCTION protect_stripe_connect_readiness();
DROP TRIGGER IF EXISTS stripe_connect_events_guard ON business_provider_events;
CREATE TRIGGER stripe_connect_events_guard BEFORE INSERT OR UPDATE OR DELETE ON business_provider_events
FOR EACH ROW EXECUTE FUNCTION protect_stripe_connect_events();
