-- MC-WORKFLOW-002B: canonical Evaluation Authority.
-- This migration is additive. It does not promote browser records or reinterpret
-- historical compatibility data, and it does not change request, relationship, or Emergency state.

ALTER TABLE commercial_command_idempotency
  DROP CONSTRAINT IF EXISTS commercial_command_idempotency_command_name_check;

ALTER TABLE commercial_command_idempotency
  ADD CONSTRAINT commercial_command_idempotency_command_name_check
  CHECK (
    command_name IN (
      'commercial.aggregate.create',
      'commercial.aggregate.version.advance',
      'evaluation.create',
      'evaluation.draft.update',
      'evaluation.complete'
    )
  );

ALTER TABLE commercial_authority_evidence
  DROP CONSTRAINT IF EXISTS commercial_authority_evidence_evidence_type_check;

ALTER TABLE commercial_authority_evidence
  ADD CONSTRAINT commercial_authority_evidence_evidence_type_check
  CHECK (
    evidence_type IN (
      'commercial.aggregate.created',
      'commercial.aggregate.version_advanced',
      'evaluation_created',
      'evaluation_draft_updated',
      'evaluation_completed'
    )
  );

ALTER TABLE commercial_authority_evidence
  DROP CONSTRAINT IF EXISTS commercial_authority_evidence_source_command_check;

ALTER TABLE commercial_authority_evidence
  ADD CONSTRAINT commercial_authority_evidence_source_command_check
  CHECK (
    source_command IN (
      'commercial.aggregate.create',
      'commercial.aggregate.version.advance',
      'evaluation.create',
      'evaluation.draft.update',
      'evaluation.complete'
    )
  );

ALTER TABLE commercial_authority_evidence
  ADD COLUMN IF NOT EXISTS capability_milestone_id TEXT
    NOT NULL DEFAULT 'MC-WORKFLOW-002A';

ALTER TABLE commercial_authority_evidence
  ADD CONSTRAINT commercial_authority_evidence_capability_milestone_check
  CHECK (
    capability_milestone_id IN (
      'MC-WORKFLOW-002A',
      'MC-WORKFLOW-002B'
    )
  );

CREATE TABLE IF NOT EXISTS canonical_evaluations (
  id UUID PRIMARY KEY,

  aggregate_type TEXT NOT NULL DEFAULT 'evaluation'
    CHECK (aggregate_type = 'evaluation'),

  owning_engine TEXT NOT NULL DEFAULT 'authorization_engine'
    CHECK (owning_engine = 'authorization_engine'),

  relationship_id INTEGER NOT NULL
    REFERENCES request_relationships(id)
    ON DELETE RESTRICT,

  professional_user_id INTEGER NOT NULL
    REFERENCES users(id)
    ON DELETE RESTRICT,

  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'completed')),

  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ,

  CONSTRAINT canonical_evaluation_aggregate_fk
    FOREIGN KEY (id, aggregate_type, owning_engine)
    REFERENCES commercial_authority_aggregates(
      id,
      aggregate_type,
      owning_engine
    )
    ON DELETE RESTRICT,

  CONSTRAINT canonical_evaluation_completion_check
    CHECK (
      (status = 'draft' AND completed_at IS NULL)
      OR
      (status = 'completed' AND completed_at IS NOT NULL)
    ),

  CONSTRAINT canonical_evaluation_relationship_professional_key
    UNIQUE (relationship_id, professional_user_id)
);

CREATE INDEX IF NOT EXISTS canonical_evaluation_professional_lookup_idx
  ON canonical_evaluations(
    professional_user_id,
    updated_at DESC,
    id ASC
  );

CREATE TABLE IF NOT EXISTS canonical_evaluation_versions (
  evaluation_id UUID NOT NULL
    REFERENCES canonical_evaluations(id)
    ON DELETE RESTRICT,

  version INTEGER NOT NULL
    CHECK (version >= 1),

  status TEXT NOT NULL
    CHECK (status IN ('draft', 'completed')),

  service_type TEXT
    CHECK (service_type IS NULL OR char_length(service_type) BETWEEN 1 AND 120),

  evaluation_context TEXT
    CHECK (
      evaluation_context IS NULL
      OR char_length(evaluation_context) BETWEEN 1 AND 120
    ),

  template_key TEXT
    CHECK (template_key IS NULL OR char_length(template_key) BETWEEN 1 AND 160),

  observations TEXT NOT NULL DEFAULT ''
    CHECK (char_length(observations) <= 5000),

  measurements JSONB NOT NULL DEFAULT '[]'::jsonb,
  findings JSONB NOT NULL DEFAULT '[]'::jsonb,

  diagnosis_summary TEXT NOT NULL DEFAULT ''
    CHECK (char_length(diagnosis_summary) <= 5000),

  limitations TEXT NOT NULL DEFAULT ''
    CHECK (char_length(limitations) <= 5000),

  scope_recommendations JSONB NOT NULL DEFAULT '[]'::jsonb,
  relevant_conditions JSONB NOT NULL DEFAULT '[]'::jsonb,
  supporting_media_references JSONB NOT NULL DEFAULT '[]'::jsonb,

  internal_notes TEXT NOT NULL DEFAULT ''
    CHECK (char_length(internal_notes) <= 5000),

  created_by_user_id INTEGER NOT NULL
    REFERENCES users(id)
    ON DELETE RESTRICT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT canonical_evaluation_version_key
    PRIMARY KEY (evaluation_id, version),

  CONSTRAINT canonical_evaluation_measurements_array_check
    CHECK (jsonb_typeof(measurements) = 'array'),

  CONSTRAINT canonical_evaluation_findings_array_check
    CHECK (jsonb_typeof(findings) = 'array'),

  CONSTRAINT canonical_evaluation_scope_recommendations_array_check
    CHECK (jsonb_typeof(scope_recommendations) = 'array'),

  CONSTRAINT canonical_evaluation_relevant_conditions_array_check
    CHECK (jsonb_typeof(relevant_conditions) = 'array'),

  CONSTRAINT canonical_evaluation_media_references_array_check
    CHECK (jsonb_typeof(supporting_media_references) = 'array')
);

CREATE INDEX IF NOT EXISTS canonical_evaluation_version_history_idx
  ON canonical_evaluation_versions(
    evaluation_id,
    version ASC,
    created_at ASC
  );
