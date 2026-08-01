-- MC-WORKFLOW-002A: canonical Commercial Authority foundation.
-- Legacy workflow_events remain separate compatibility records and are not
-- promoted, copied, or interpreted by this migration.

CREATE TABLE IF NOT EXISTS commercial_authority_aggregates (
  id UUID PRIMARY KEY,

  aggregate_type TEXT NOT NULL
    CHECK (
      aggregate_type IN (
        'evaluation',
        'quote',
        'customer_decision',
        'authorization',
        'change_order',
        'invoice',
        'payment',
        'receipt',
        'commercial_completion'
      )
    ),

  owning_engine TEXT NOT NULL DEFAULT 'authorization_engine'
    CHECK (owning_engine = 'authorization_engine'),

  source_context_type TEXT NOT NULL
    CHECK (
      source_context_type IN (
        'ordinary_request',
        'emergency_request'
      )
    ),

  ordinary_request_id INTEGER
    REFERENCES posts(id)
    ON DELETE RESTRICT,

  emergency_request_id INTEGER
    REFERENCES emergency_requests(id)
    ON DELETE RESTRICT,

  relationship_id INTEGER
    REFERENCES request_relationships(id)
    ON DELETE RESTRICT,

  source_owner_user_id INTEGER NOT NULL
    REFERENCES users(id)
    ON DELETE RESTRICT,

  created_by_user_id INTEGER NOT NULL
    REFERENCES users(id)
    ON DELETE RESTRICT,

  current_version INTEGER NOT NULL DEFAULT 1
    CHECK (current_version >= 1),

  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT commercial_authority_aggregate_source_check
    CHECK (
      (
        source_context_type = 'ordinary_request'
        AND ordinary_request_id IS NOT NULL
        AND emergency_request_id IS NULL
      )
      OR
      (
        source_context_type = 'emergency_request'
        AND ordinary_request_id IS NULL
        AND emergency_request_id IS NOT NULL
      )
    ),

  CONSTRAINT commercial_authority_aggregate_identity_key
    UNIQUE (id, aggregate_type, owning_engine)
);

CREATE INDEX IF NOT EXISTS commercial_authority_aggregate_ordinary_request_idx
  ON commercial_authority_aggregates(
    ordinary_request_id,
    aggregate_type,
    created_at ASC,
    id ASC
  )
  WHERE ordinary_request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS commercial_authority_aggregate_emergency_request_idx
  ON commercial_authority_aggregates(
    emergency_request_id,
    aggregate_type,
    created_at ASC,
    id ASC
  )
  WHERE emergency_request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS commercial_authority_aggregate_relationship_idx
  ON commercial_authority_aggregates(
    relationship_id,
    aggregate_type,
    created_at ASC,
    id ASC
  )
  WHERE relationship_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS commercial_command_idempotency (
  id UUID PRIMARY KEY,

  actor_user_id INTEGER NOT NULL
    REFERENCES users(id)
    ON DELETE RESTRICT,

  command_name TEXT NOT NULL
    CHECK (
      command_name IN (
        'commercial.aggregate.create',
        'commercial.aggregate.version.advance'
      )
    ),

  command_scope TEXT NOT NULL
    CHECK (char_length(command_scope) BETWEEN 1 AND 300),

  idempotency_key TEXT NOT NULL
    CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),

  request_fingerprint TEXT NOT NULL
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),

  aggregate_id UUID
    REFERENCES commercial_authority_aggregates(id)
    ON DELETE RESTRICT,

  result_reference JSONB,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT commercial_command_result_object_check
    CHECK (
      result_reference IS NULL
      OR jsonb_typeof(result_reference) = 'object'
    ),

  CONSTRAINT commercial_command_completion_check
    CHECK (
      (
        aggregate_id IS NULL
        AND result_reference IS NULL
        AND completed_at IS NULL
      )
      OR
      (
        aggregate_id IS NOT NULL
        AND result_reference IS NOT NULL
        AND completed_at IS NOT NULL
      )
    ),

  CONSTRAINT commercial_command_idempotency_scope_key
    UNIQUE (
      actor_user_id,
      command_name,
      command_scope,
      idempotency_key
    )
);

CREATE INDEX IF NOT EXISTS commercial_command_aggregate_idx
  ON commercial_command_idempotency(aggregate_id, created_at ASC)
  WHERE aggregate_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS commercial_authority_evidence (
  id UUID PRIMARY KEY,

  aggregate_id UUID NOT NULL,
  aggregate_type TEXT NOT NULL,
  owning_engine TEXT NOT NULL,

  evidence_type TEXT NOT NULL
    CHECK (
      evidence_type IN (
        'commercial.aggregate.created',
        'commercial.aggregate.version_advanced'
      )
    ),

  actor_user_id INTEGER NOT NULL
    REFERENCES users(id)
    ON DELETE RESTRICT,

  actor_role TEXT NOT NULL
    CHECK (actor_role IN ('homeowner', 'professional')),

  relationship_id INTEGER
    REFERENCES request_relationships(id)
    ON DELETE RESTRICT,

  previous_version INTEGER NOT NULL
    CHECK (previous_version >= 0),

  resulting_version INTEGER NOT NULL,

  occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  persisted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  idempotency_id UUID NOT NULL
    REFERENCES commercial_command_idempotency(id)
    ON DELETE RESTRICT,

  evidence_payload JSONB NOT NULL,
  source_command TEXT NOT NULL
    CHECK (
      source_command IN (
        'commercial.aggregate.create',
        'commercial.aggregate.version.advance'
      )
    ),

  governing_charter_id TEXT NOT NULL DEFAULT 'MC-WORKFLOW-001C'
    CHECK (governing_charter_id = 'MC-WORKFLOW-001C'),

  governing_program_id TEXT NOT NULL DEFAULT 'MC-WORKFLOW-001D'
    CHECK (governing_program_id = 'MC-WORKFLOW-001D'),

  implementation_milestone_id TEXT NOT NULL DEFAULT 'MC-WORKFLOW-002A'
    CHECK (implementation_milestone_id = 'MC-WORKFLOW-002A'),

  certification_target TEXT NOT NULL DEFAULT 'MC-WORKFLOW-002R'
    CHECK (certification_target = 'MC-WORKFLOW-002R'),

  CONSTRAINT commercial_authority_evidence_aggregate_fk
    FOREIGN KEY (aggregate_id, aggregate_type, owning_engine)
    REFERENCES commercial_authority_aggregates(
      id,
      aggregate_type,
      owning_engine
    )
    ON DELETE RESTRICT,

  CONSTRAINT commercial_authority_evidence_version_check
    CHECK (resulting_version = previous_version + 1),

  CONSTRAINT commercial_authority_evidence_payload_check
    CHECK (jsonb_typeof(evidence_payload) = 'object'),

  CONSTRAINT commercial_authority_evidence_version_key
    UNIQUE (aggregate_id, resulting_version)
);

CREATE INDEX IF NOT EXISTS commercial_authority_evidence_order_idx
  ON commercial_authority_evidence(
    aggregate_id,
    resulting_version ASC,
    persisted_at ASC,
    id ASC
  );
