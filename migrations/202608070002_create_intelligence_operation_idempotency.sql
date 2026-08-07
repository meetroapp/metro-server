-- Durable execution identity for governed Intelligence operations.
-- This table stores bounded replay metadata, never raw operation input or provider transport.

CREATE TABLE IF NOT EXISTS intelligence_operation_idempotency (
  id UUID PRIMARY KEY,

  actor_user_id INTEGER NOT NULL
    REFERENCES users(id)
    ON DELETE RESTRICT,

  authority_scope TEXT NOT NULL
    CHECK (char_length(authority_scope) BETWEEN 1 AND 200),

  operation TEXT NOT NULL
    CHECK (char_length(operation) BETWEEN 3 AND 160)
    CHECK (operation ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),

  idempotency_key TEXT NOT NULL
    CHECK (
      idempotency_key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    ),

  request_fingerprint TEXT NOT NULL
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),

  status TEXT NOT NULL DEFAULT 'reserved'
    CHECK (status IN ('reserved', 'executing', 'completed', 'failed')),

  provider_execution_state TEXT NOT NULL DEFAULT 'not_started'
    CHECK (
      provider_execution_state IN ('not_started', 'started', 'succeeded', 'failed')
    ),

  result_classification TEXT
    CHECK (
      result_classification IS NULL
      OR result_classification ~ '^[a-z][a-z0-9_.-]{0,99}$'
    ),

  result_payload JSONB
    CHECK (
      result_payload IS NULL
      OR (
        jsonb_typeof(result_payload) = 'object'
        AND octet_length(result_payload::TEXT) <= 65536
      )
    ),

  error_classification TEXT
    CHECK (
      error_classification IS NULL
      OR error_classification ~ '^[a-z][a-z0-9_.-]{0,99}$'
    ),

  usage_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (
      usage_state IN (
        'pending',
        'finalizing',
        'finalized',
        'not_configured',
        'not_chargeable',
        'failed',
        'ambiguous'
      )
    ),

  usage_classification TEXT
    CHECK (
      usage_classification IS NULL
      OR usage_classification ~ '^[a-z][a-z0-9_.-]{0,99}$'
    ),

  correlation_id UUID NOT NULL UNIQUE,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT intelligence_operation_authority_scope_check
    CHECK (authority_scope = 'user:' || actor_user_id::TEXT),

  CONSTRAINT intelligence_operation_scope_key
    UNIQUE (
      actor_user_id,
      authority_scope,
      operation,
      idempotency_key
    ),

  CONSTRAINT intelligence_operation_result_pair_check
    CHECK (
      (result_classification IS NULL AND result_payload IS NULL)
      OR
      (result_classification IS NOT NULL AND result_payload IS NOT NULL)
    ),

  CONSTRAINT intelligence_operation_lifecycle_check
    CHECK (
      (
        status = 'reserved'
        AND provider_execution_state = 'not_started'
        AND usage_state = 'pending'
        AND result_payload IS NULL
        AND error_classification IS NULL
        AND started_at IS NULL
        AND completed_at IS NULL
        AND failed_at IS NULL
      )
      OR
      (
        status = 'executing'
        AND started_at IS NOT NULL
        AND completed_at IS NULL
        AND failed_at IS NULL
        AND error_classification IS NULL
        AND (
          (
            provider_execution_state = 'started'
            AND usage_state = 'pending'
            AND result_payload IS NULL
          )
          OR
          (
            provider_execution_state = 'succeeded'
            AND usage_state IN ('pending', 'finalizing')
            AND result_payload IS NOT NULL
          )
        )
      )
      OR
      (
        status = 'completed'
        AND provider_execution_state = 'succeeded'
        AND usage_state IN ('finalized', 'not_configured')
        AND result_payload IS NOT NULL
        AND error_classification IS NULL
        AND started_at IS NOT NULL
        AND completed_at IS NOT NULL
        AND failed_at IS NULL
      )
      OR
      (
        status = 'failed'
        AND provider_execution_state IN ('failed', 'succeeded')
        AND usage_state IN ('not_chargeable', 'failed', 'ambiguous')
        AND error_classification IS NOT NULL
        AND started_at IS NOT NULL
        AND completed_at IS NULL
        AND failed_at IS NOT NULL
        AND (
          provider_execution_state <> 'failed'
          OR (
            result_payload IS NULL
            AND usage_state = 'not_chargeable'
          )
        )
      )
    )
);

CREATE INDEX IF NOT EXISTS intelligence_operation_actor_created_idx
ON intelligence_operation_idempotency(
  actor_user_id,
  operation,
  created_at DESC
);

CREATE INDEX IF NOT EXISTS intelligence_operation_incomplete_idx
ON intelligence_operation_idempotency(
  status,
  updated_at ASC
)
WHERE status IN ('reserved', 'executing');

COMMENT ON TABLE intelligence_operation_idempotency IS
  'Durable execution identity and bounded replay state for governed Intelligence operations.';
