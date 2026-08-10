-- MC-JOB-LIFECYCLE-004C-A Slice 002: extend the canonical Evaluation aggregate
-- with ordinary Job subjects and first-class, versioned Finding persistence.
-- Existing Emergency Evaluation rows and JSON content remain unchanged.

INSERT INTO lifecycle_capabilities (capability)
VALUES
  ('evaluation.perform'),
  ('finding.submit'),
  ('finding.confirm')
ON CONFLICT (capability) DO NOTHING;

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
      'evaluation.complete',
      'finding.submit',
      'finding.concern.link',
      'finding.evidence.add',
      'finding.confirm'
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS
  commercial_authority_aggregates_ordinary_subject_uidx
ON commercial_authority_aggregates(
  id,
  source_context_type,
  ordinary_request_id,
  relationship_id
);

CREATE UNIQUE INDEX IF NOT EXISTS
  canonical_evaluations_identity_relationship_uidx
ON canonical_evaluations(id, relationship_id);

CREATE UNIQUE INDEX IF NOT EXISTS
  jobs_identity_request_relationship_uidx
ON jobs(id, job_request_id, source_request_relationship_id);

CREATE UNIQUE INDEX IF NOT EXISTS jobs_identity_request_uidx
ON jobs(id, job_request_id);

CREATE UNIQUE INDEX IF NOT EXISTS
  reported_concerns_identity_request_uidx
ON reported_concerns(id, job_request_id);

CREATE TABLE IF NOT EXISTS canonical_evaluation_job_subjects (
  evaluation_id UUID PRIMARY KEY,

  subject_type TEXT NOT NULL DEFAULT 'ordinary_job'
    CHECK (subject_type = 'ordinary_job'),

  source_context_type TEXT NOT NULL DEFAULT 'ordinary_request'
    CHECK (source_context_type = 'ordinary_request'),

  job_id UUID NOT NULL UNIQUE,
  job_request_id INTEGER NOT NULL,
  relationship_id INTEGER NOT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT canonical_evaluation_job_subject_evaluation_fk
    FOREIGN KEY (evaluation_id, relationship_id)
    REFERENCES canonical_evaluations(id, relationship_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_evaluation_job_subject_aggregate_fk
    FOREIGN KEY (
      evaluation_id,
      source_context_type,
      job_request_id,
      relationship_id
    )
    REFERENCES commercial_authority_aggregates(
      id,
      source_context_type,
      ordinary_request_id,
      relationship_id
    )
    ON DELETE RESTRICT,

  CONSTRAINT canonical_evaluation_job_subject_job_fk
    FOREIGN KEY (job_id, job_request_id, relationship_id)
    REFERENCES jobs(id, job_request_id, source_request_relationship_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_evaluation_job_subject_identity_key
    UNIQUE (evaluation_id, job_id)
);

CREATE INDEX IF NOT EXISTS canonical_evaluation_job_subject_lookup_idx
ON canonical_evaluation_job_subjects(job_id, created_at ASC, evaluation_id ASC);

CREATE TABLE IF NOT EXISTS canonical_evaluation_findings (
  id UUID PRIMARY KEY,

  evaluation_id UUID NOT NULL,
  job_id UUID NOT NULL,
  author_participant_id UUID NOT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT canonical_evaluation_finding_subject_fk
    FOREIGN KEY (evaluation_id, job_id)
    REFERENCES canonical_evaluation_job_subjects(evaluation_id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_evaluation_finding_author_fk
    FOREIGN KEY (author_participant_id, job_id)
    REFERENCES relationship_participants(id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_evaluation_finding_identity_key
    UNIQUE (id, evaluation_id, job_id),

  CONSTRAINT canonical_evaluation_finding_job_identity_key
    UNIQUE (id, job_id)
);

CREATE INDEX IF NOT EXISTS canonical_evaluation_finding_subject_idx
ON canonical_evaluation_findings(
  evaluation_id,
  job_id,
  created_at ASC,
  id ASC
);

CREATE TABLE IF NOT EXISTS canonical_evaluation_finding_versions (
  finding_id UUID NOT NULL,
  version INTEGER NOT NULL
    CHECK (version >= 1),

  evaluation_id UUID NOT NULL,
  evaluation_version INTEGER NOT NULL
    CHECK (evaluation_version >= 1),
  job_id UUID NOT NULL,

  statement TEXT NOT NULL
    CHECK (char_length(btrim(statement)) BETWEEN 1 AND 5000),

  confirmation_state TEXT NOT NULL DEFAULT 'PROPOSED'
    CHECK (
      confirmation_state IN (
        'PROPOSED',
        'CONFIRMED',
        'SUPERSEDED'
      )
    ),

  resolution_state TEXT NOT NULL DEFAULT 'OPEN'
    CHECK (
      resolution_state IN (
        'OPEN',
        'PARTIALLY_RESOLVED',
        'RESOLVED',
        'DEFERRED'
      )
    ),

  created_by_participant_id UUID NOT NULL,

  integrity_algorithm TEXT NOT NULL DEFAULT 'sha256'
    CHECK (integrity_algorithm = 'sha256'),

  integrity_hash TEXT NOT NULL
    CHECK (integrity_hash ~ '^[0-9a-f]{64}$'),

  integrity_version SMALLINT NOT NULL DEFAULT 1
    CHECK (integrity_version = 1),

  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT canonical_evaluation_finding_version_key
    PRIMARY KEY (finding_id, version),

  CONSTRAINT canonical_evaluation_finding_version_identity_fk
    FOREIGN KEY (finding_id, evaluation_id, job_id)
    REFERENCES canonical_evaluation_findings(id, evaluation_id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_evaluation_finding_evaluation_version_fk
    FOREIGN KEY (evaluation_id, evaluation_version)
    REFERENCES canonical_evaluation_versions(evaluation_id, version)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_evaluation_finding_version_author_fk
    FOREIGN KEY (created_by_participant_id, job_id)
    REFERENCES relationship_participants(id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_evaluation_finding_version_job_key
    UNIQUE (finding_id, version, job_id)
);

CREATE INDEX IF NOT EXISTS canonical_evaluation_finding_version_subject_idx
ON canonical_evaluation_finding_versions(
  evaluation_id,
  evaluation_version,
  job_id,
  finding_id,
  version ASC
);

CREATE TABLE IF NOT EXISTS canonical_finding_concern_links (
  id UUID PRIMARY KEY,

  finding_id UUID NOT NULL,
  job_id UUID NOT NULL,
  job_request_id INTEGER NOT NULL,
  concern_id UUID NOT NULL,

  relationship_type TEXT NOT NULL
    CHECK (relationship_type IN ('EXPLAINS', 'RELATED', 'CONTRADICTS')),

  created_by_participant_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT canonical_finding_concern_link_finding_fk
    FOREIGN KEY (finding_id, job_id)
    REFERENCES canonical_evaluation_findings(id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_finding_concern_link_job_fk
    FOREIGN KEY (job_id, job_request_id)
    REFERENCES jobs(id, job_request_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_finding_concern_link_concern_fk
    FOREIGN KEY (concern_id, job_request_id)
    REFERENCES reported_concerns(id, job_request_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_finding_concern_link_actor_fk
    FOREIGN KEY (created_by_participant_id, job_id)
    REFERENCES relationship_participants(id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_finding_concern_link_key
    UNIQUE (finding_id, concern_id, relationship_type)
);

CREATE INDEX IF NOT EXISTS canonical_finding_concern_lookup_idx
ON canonical_finding_concern_links(
  concern_id,
  relationship_type,
  created_at ASC,
  finding_id ASC
);

CREATE TABLE IF NOT EXISTS canonical_finding_evidence_references (
  id UUID PRIMARY KEY,

  finding_id UUID NOT NULL,
  finding_version INTEGER NOT NULL
    CHECK (finding_version >= 1),
  job_id UUID NOT NULL,

  evidence_type TEXT NOT NULL
    CHECK (
      evidence_type IN (
        'PROFESSIONAL_OBSERVATION',
        'PHOTO_MEDIA',
        'SPECIALIST_CONTRIBUTION',
        'MEASUREMENT',
        'COMMUNICATION',
        'AI_PROPOSAL_LINEAGE'
      )
    ),

  reference_namespace TEXT NOT NULL
    CHECK (
      char_length(reference_namespace) BETWEEN 1 AND 120
      AND reference_namespace ~ '^[a-z][a-z0-9_.-]*$'
    ),

  reference_id TEXT NOT NULL
    CHECK (char_length(btrim(reference_id)) BETWEEN 1 AND 200),

  recorded_by_participant_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT canonical_finding_evidence_finding_version_fk
    FOREIGN KEY (finding_id, finding_version, job_id)
    REFERENCES canonical_evaluation_finding_versions(
      finding_id,
      version,
      job_id
    )
    ON DELETE RESTRICT,

  CONSTRAINT canonical_finding_evidence_actor_fk
    FOREIGN KEY (recorded_by_participant_id, job_id)
    REFERENCES relationship_participants(id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_finding_evidence_reference_key
    UNIQUE (
      finding_id,
      finding_version,
      evidence_type,
      reference_namespace,
      reference_id
    )
);

CREATE INDEX IF NOT EXISTS canonical_finding_evidence_lookup_idx
ON canonical_finding_evidence_references(
  finding_id,
  finding_version,
  created_at ASC,
  id ASC
);

-- Workstream linkage is intentionally deferred until Slice 003 can reference a
-- real canonical Workstream identity. No speculative workstream column or FK is
-- introduced here.

DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'canonical_evaluation_job_subjects',
    'canonical_evaluation_findings',
    'canonical_evaluation_finding_versions',
    'canonical_finding_concern_links',
    'canonical_finding_evidence_references'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgname = table_name || '_append_only'
        AND NOT tgisinternal
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION prevent_lifecycle_append_only_mutation()',
        table_name || '_append_only',
        table_name
      );
    END IF;
  END LOOP;
END $$;
