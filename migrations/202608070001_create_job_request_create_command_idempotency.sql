-- Durable command identity for ordinary Job Request creation.
-- The canonical Job Request aggregate remains posts.

CREATE TABLE IF NOT EXISTS job_request_create_command_idempotency (
  id UUID PRIMARY KEY,

  actor_user_id INTEGER NOT NULL
    REFERENCES users(id)
    ON DELETE RESTRICT,

  post_id INTEGER
    REFERENCES posts(id)
    ON DELETE RESTRICT,

  command_name TEXT NOT NULL DEFAULT 'job_request.create'
    CHECK (command_name = 'job_request.create'),

  command_scope TEXT NOT NULL DEFAULT 'ordinary'
    CHECK (command_scope = 'ordinary'),

  idempotency_key TEXT NOT NULL
    CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),

  request_fingerprint TEXT NOT NULL
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),

  result_classification TEXT
    CHECK (
      result_classification IS NULL
      OR result_classification IN ('created')
    ),

  result_reference JSONB
    CHECK (
      result_reference IS NULL
      OR jsonb_typeof(result_reference) = 'object'
    ),

  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT job_request_create_command_scope_key
    UNIQUE (
      actor_user_id,
      command_name,
      command_scope,
      idempotency_key
    ),

  CONSTRAINT job_request_create_command_completion_check
    CHECK (
      (
        post_id IS NULL
        AND result_classification IS NULL
        AND result_reference IS NULL
        AND completed_at IS NULL
      )
      OR
      (
        post_id IS NOT NULL
        AND result_classification IS NOT NULL
        AND result_reference IS NOT NULL
        AND completed_at IS NOT NULL
      )
    )
);

CREATE INDEX IF NOT EXISTS job_request_create_command_result_idx
ON job_request_create_command_idempotency(
  post_id,
  created_at ASC
)
WHERE post_id IS NOT NULL;
