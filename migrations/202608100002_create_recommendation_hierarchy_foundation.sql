-- MC-JOB-LIFECYCLE-004E-A Slice 004: additive Recommendation hierarchy,
-- customer-constraint evidence, and append-only disposition history.
-- Existing Evaluation JSON, Findings, Workstreams, and Quote authority remain unchanged.

INSERT INTO lifecycle_capabilities (capability)
VALUES
  ('recommendation.create'),
  ('recommendation.read'),
  ('recommendation.transition'),
  ('customer_constraint.record')
ON CONFLICT (capability) DO NOTHING;

CREATE TABLE IF NOT EXISTS canonical_recommendation_command_idempotency (
  id UUID PRIMARY KEY,
  actor_participant_id UUID NOT NULL,
  job_id UUID NOT NULL,
  command_name TEXT NOT NULL
    CHECK (command_name IN (
      'recommendation.create',
      'recommendation.transition',
      'customer_constraint.record'
    )),
  command_scope TEXT NOT NULL
    CHECK (char_length(btrim(command_scope)) BETWEEN 1 AND 300),
  idempotency_key TEXT NOT NULL
    CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  request_fingerprint TEXT NOT NULL
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  result_reference JSONB,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT canonical_recommendation_command_actor_fk
    FOREIGN KEY (actor_participant_id, job_id)
    REFERENCES relationship_participants(id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_recommendation_command_result_check
    CHECK (
      (result_reference IS NULL AND completed_at IS NULL)
      OR
      (result_reference IS NOT NULL
        AND jsonb_typeof(result_reference) = 'object'
        AND completed_at IS NOT NULL)
    ),

  CONSTRAINT canonical_recommendation_command_key
    UNIQUE (actor_participant_id, command_name, command_scope, idempotency_key)
);

CREATE INDEX IF NOT EXISTS canonical_recommendation_command_job_idx
ON canonical_recommendation_command_idempotency(
  job_id,
  command_name,
  created_at DESC,
  id DESC
);

CREATE TABLE IF NOT EXISTS canonical_recommendations (
  id UUID PRIMARY KEY,
  job_id UUID NOT NULL,
  finding_id UUID NOT NULL,
  evaluation_id UUID NOT NULL,
  author_participant_id UUID NOT NULL,
  kind TEXT NOT NULL
    CHECK (kind IN ('PRIMARY', 'ALTERNATIVE')),
  primary_recommendation_id UUID,
  primary_recommendation_kind TEXT,
  statement_fingerprint TEXT NOT NULL
    CHECK (statement_fingerprint ~ '^[0-9a-f]{64}$'),
  source_evidence_type TEXT NOT NULL
    CHECK (source_evidence_type = 'recommendation_command'),
  source_evidence_reference TEXT NOT NULL
    CHECK (char_length(btrim(source_evidence_reference)) BETWEEN 1 AND 200),
  idempotency_key TEXT NOT NULL
    CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT canonical_recommendation_finding_fk
    FOREIGN KEY (finding_id, evaluation_id, job_id)
    REFERENCES canonical_evaluation_findings(id, evaluation_id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_recommendation_author_fk
    FOREIGN KEY (author_participant_id, job_id)
    REFERENCES relationship_participants(id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_recommendation_kind_lineage_check
    CHECK (
      (kind = 'PRIMARY'
        AND primary_recommendation_id IS NULL
        AND primary_recommendation_kind IS NULL)
      OR
      (kind = 'ALTERNATIVE'
        AND primary_recommendation_id IS NOT NULL
        AND primary_recommendation_kind = 'PRIMARY'
        AND primary_recommendation_id <> id)
    ),

  CONSTRAINT canonical_recommendation_identity_key
    UNIQUE (id, job_id, finding_id, evaluation_id),

  CONSTRAINT canonical_recommendation_job_finding_identity_key
    UNIQUE (id, job_id, finding_id),

  CONSTRAINT canonical_recommendation_lineage_identity_key
    UNIQUE (id, job_id, finding_id, kind),

  CONSTRAINT canonical_recommendation_semantic_key
    UNIQUE (finding_id, kind, statement_fingerprint),

  CONSTRAINT canonical_recommendation_primary_fk
    FOREIGN KEY (
      primary_recommendation_id,
      job_id,
      finding_id,
      primary_recommendation_kind
    )
    REFERENCES canonical_recommendations(id, job_id, finding_id, kind)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS canonical_recommendation_finding_idx
ON canonical_recommendations(
  finding_id,
  created_at ASC,
  id ASC
);

CREATE INDEX IF NOT EXISTS canonical_recommendation_primary_idx
ON canonical_recommendations(
  primary_recommendation_id,
  created_at ASC,
  id ASC
)
WHERE primary_recommendation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS canonical_recommendation_versions (
  recommendation_id UUID NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  job_id UUID NOT NULL,
  finding_id UUID NOT NULL,
  evaluation_id UUID NOT NULL,
  evaluation_version INTEGER NOT NULL CHECK (evaluation_version >= 1),
  statement TEXT NOT NULL
    CHECK (char_length(btrim(statement)) BETWEEN 1 AND 5000),
  status TEXT NOT NULL
    CHECK (status IN (
      'ACTIVE',
      'ACCEPTED',
      'DECLINED',
      'DEFERRED',
      'SUPERSEDED',
      'WITHDRAWN',
      'EXCLUDED_FROM_CURRENT_QUOTE',
      'SEPARATE_PROPOSAL_REQUIRED'
    )),
  created_by_participant_id UUID NOT NULL,
  integrity_algorithm TEXT NOT NULL DEFAULT 'sha256'
    CHECK (integrity_algorithm = 'sha256'),
  integrity_hash TEXT NOT NULL
    CHECK (integrity_hash ~ '^[0-9a-f]{64}$'),
  integrity_version SMALLINT NOT NULL DEFAULT 1
    CHECK (integrity_version = 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT canonical_recommendation_version_key
    PRIMARY KEY (recommendation_id, version),

  CONSTRAINT canonical_recommendation_version_identity_fk
    FOREIGN KEY (recommendation_id, job_id, finding_id, evaluation_id)
    REFERENCES canonical_recommendations(id, job_id, finding_id, evaluation_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_recommendation_version_evaluation_fk
    FOREIGN KEY (evaluation_id, evaluation_version)
    REFERENCES canonical_evaluation_versions(evaluation_id, version)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_recommendation_version_actor_fk
    FOREIGN KEY (created_by_participant_id, job_id)
    REFERENCES relationship_participants(id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_recommendation_version_scope_key
    UNIQUE (recommendation_id, version, job_id, finding_id, status)
);

CREATE INDEX IF NOT EXISTS canonical_recommendation_version_history_idx
ON canonical_recommendation_versions(
  recommendation_id,
  version ASC
);

CREATE INDEX IF NOT EXISTS canonical_recommendation_finding_status_idx
ON canonical_recommendation_versions(
  finding_id,
  status,
  created_at DESC,
  recommendation_id ASC
);

CREATE TABLE IF NOT EXISTS canonical_customer_constraints (
  id UUID PRIMARY KEY,
  recommendation_id UUID NOT NULL,
  job_id UUID NOT NULL,
  finding_id UUID NOT NULL,
  evaluation_id UUID NOT NULL,
  constraint_type TEXT NOT NULL
    CHECK (constraint_type IN (
      'BUDGET',
      'AVAILABILITY',
      'ACCESS',
      'CUSTOMER_SUPPLIED_MATERIAL',
      'OTHER'
    )),
  statement TEXT NOT NULL
    CHECK (char_length(btrim(statement)) BETWEEN 1 AND 2000),
  recorded_by_participant_id UUID NOT NULL,
  request_fingerprint TEXT NOT NULL
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  source_evidence_type TEXT NOT NULL
    CHECK (source_evidence_type = 'professional_recorded_customer_constraint'),
  source_evidence_reference TEXT NOT NULL
    CHECK (char_length(btrim(source_evidence_reference)) BETWEEN 1 AND 200),
  idempotency_key TEXT NOT NULL
    CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT canonical_customer_constraint_recommendation_fk
    FOREIGN KEY (recommendation_id, job_id, finding_id, evaluation_id)
    REFERENCES canonical_recommendations(id, job_id, finding_id, evaluation_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_customer_constraint_actor_fk
    FOREIGN KEY (recorded_by_participant_id, job_id)
    REFERENCES relationship_participants(id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_customer_constraint_command_key
    UNIQUE (recorded_by_participant_id, recommendation_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS canonical_customer_constraint_thread_idx
ON canonical_customer_constraints(
  recommendation_id,
  created_at ASC,
  id ASC
);

CREATE TABLE IF NOT EXISTS canonical_recommendation_disposition_events (
  id UUID PRIMARY KEY,
  recommendation_id UUID NOT NULL,
  previous_recommendation_version INTEGER NOT NULL CHECK (previous_recommendation_version >= 1),
  recommendation_version INTEGER NOT NULL CHECK (recommendation_version >= 2),
  job_id UUID NOT NULL,
  finding_id UUID NOT NULL,
  previous_status TEXT NOT NULL,
  disposition TEXT NOT NULL,
  authority_classification TEXT NOT NULL
    CHECK (authority_classification IN (
      'PROFESSIONAL_DISPOSITION',
      'PROFESSIONAL_RECORDED_CUSTOMER_DECISION'
    )),
  decision_evidence_note TEXT
    CHECK (
      decision_evidence_note IS NULL
      OR char_length(btrim(decision_evidence_note)) BETWEEN 1 AND 2000
    ),
  replacement_recommendation_id UUID,
  recorded_by_participant_id UUID NOT NULL,
  source_evidence_type TEXT NOT NULL
    CHECK (source_evidence_type = 'recommendation_transition_command'),
  source_evidence_reference TEXT NOT NULL
    CHECK (char_length(btrim(source_evidence_reference)) BETWEEN 1 AND 200),
  idempotency_key TEXT NOT NULL
    CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT canonical_recommendation_disposition_sequence_check
    CHECK (recommendation_version = previous_recommendation_version + 1),

  CONSTRAINT canonical_recommendation_disposition_transition_check
    CHECK (
      previous_status = 'ACTIVE'
      AND disposition IN (
        'ACCEPTED',
        'DECLINED',
        'DEFERRED',
        'SUPERSEDED',
        'WITHDRAWN',
        'EXCLUDED_FROM_CURRENT_QUOTE',
        'SEPARATE_PROPOSAL_REQUIRED'
      )
    ),

  CONSTRAINT canonical_recommendation_disposition_replacement_check
    CHECK (
      (disposition = 'SUPERSEDED' AND replacement_recommendation_id IS NOT NULL)
      OR
      (disposition <> 'SUPERSEDED' AND replacement_recommendation_id IS NULL)
    ),

  CONSTRAINT canonical_recommendation_disposition_previous_fk
    FOREIGN KEY (
      recommendation_id,
      previous_recommendation_version,
      job_id,
      finding_id,
      previous_status
    )
    REFERENCES canonical_recommendation_versions(
      recommendation_id,
      version,
      job_id,
      finding_id,
      status
    )
    ON DELETE RESTRICT,

  CONSTRAINT canonical_recommendation_disposition_version_fk
    FOREIGN KEY (
      recommendation_id,
      recommendation_version,
      job_id,
      finding_id,
      disposition
    )
    REFERENCES canonical_recommendation_versions(
      recommendation_id,
      version,
      job_id,
      finding_id,
      status
    )
    ON DELETE RESTRICT,

  CONSTRAINT canonical_recommendation_disposition_actor_fk
    FOREIGN KEY (recorded_by_participant_id, job_id)
    REFERENCES relationship_participants(id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_recommendation_disposition_replacement_fk
    FOREIGN KEY (replacement_recommendation_id, job_id, finding_id)
    REFERENCES canonical_recommendations(id, job_id, finding_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_recommendation_disposition_version_key
    UNIQUE (recommendation_id, recommendation_version),

  CONSTRAINT canonical_recommendation_disposition_command_key
    UNIQUE (recorded_by_participant_id, recommendation_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS canonical_recommendation_disposition_history_idx
ON canonical_recommendation_disposition_events(
  recommendation_id,
  created_at ASC,
  id ASC
);

DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'canonical_recommendations',
    'canonical_recommendation_versions',
    'canonical_customer_constraints',
    'canonical_recommendation_disposition_events'
  ]
  LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS %I ON %I',
      table_name || '_append_only',
      table_name
    );
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I '
      || 'FOR EACH ROW EXECUTE FUNCTION prevent_lifecycle_append_only_mutation()',
      table_name || '_append_only',
      table_name
    );
  END LOOP;
END $$;
