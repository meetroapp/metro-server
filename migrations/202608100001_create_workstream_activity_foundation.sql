-- MC-JOB-LIFECYCLE-004D-A Slice 003: additive Workstream, Work Activity,
-- Finding-resolution evidence, obligation persistence, and bounded runtime
-- capability/idempotency foundation. It fabricates no lifecycle business rows.

INSERT INTO lifecycle_capabilities (capability)
VALUES
  ('workstream.create'),
  ('workstream.read'),
  ('finding.assign_workstream'),
  ('work_activity.create'),
  ('work_activity.progress'),
  ('work_activity.read'),
  ('work_obligation.create'),
  ('work_obligation.read'),
  ('finding.resolve'),
  ('work_obligation.transition'),
  ('workstream.complete')
ON CONFLICT (capability) DO NOTHING;

CREATE TABLE IF NOT EXISTS canonical_workflow_command_idempotency (
  id UUID PRIMARY KEY,

  actor_participant_id UUID NOT NULL,
  job_id UUID NOT NULL,

  command_name TEXT NOT NULL
    CHECK (
      command_name IN (
        'workstream.create',
        'finding.assign_workstream',
        'work_activity.create',
        'work_activity.progress',
        'work_obligation.create',
        'finding.resolve',
        'work_obligation.transition',
        'workstream.complete'
      )
    ),

  command_scope TEXT NOT NULL
    CHECK (char_length(btrim(command_scope)) BETWEEN 1 AND 300),

  idempotency_key TEXT NOT NULL
    CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),

  request_fingerprint TEXT NOT NULL
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),

  result_reference JSONB,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT canonical_workflow_command_actor_fk
    FOREIGN KEY (actor_participant_id, job_id)
    REFERENCES relationship_participants(id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_workflow_command_result_check
    CHECK (
      (
        result_reference IS NULL
        AND completed_at IS NULL
      )
      OR
      (
        result_reference IS NOT NULL
        AND jsonb_typeof(result_reference) = 'object'
        AND completed_at IS NOT NULL
      )
    ),

  CONSTRAINT canonical_workflow_command_key
    UNIQUE (
      actor_participant_id,
      command_name,
      command_scope,
      idempotency_key
    )
);

CREATE INDEX IF NOT EXISTS canonical_workflow_command_job_idx
ON canonical_workflow_command_idempotency(
  job_id,
  command_name,
  created_at DESC,
  id DESC
);

CREATE TABLE IF NOT EXISTS canonical_workstreams (
  id UUID PRIMARY KEY,

  job_id UUID NOT NULL
    REFERENCES jobs(id)
    ON DELETE RESTRICT,

  sequence INTEGER NOT NULL
    CHECK (sequence >= 1),

  created_by_participant_id UUID NOT NULL,

  source_evidence_type TEXT NOT NULL
    CHECK (char_length(btrim(source_evidence_type)) BETWEEN 1 AND 120),

  source_evidence_reference TEXT NOT NULL
    CHECK (char_length(btrim(source_evidence_reference)) BETWEEN 1 AND 200),

  idempotency_key TEXT NOT NULL
    CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),

  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT canonical_workstream_creator_fk
    FOREIGN KEY (created_by_participant_id, job_id)
    REFERENCES relationship_participants(id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_workstream_job_sequence_key
    UNIQUE (job_id, sequence),

  CONSTRAINT canonical_workstream_command_key
    UNIQUE (created_by_participant_id, job_id, idempotency_key),

  CONSTRAINT canonical_workstream_job_identity_key
    UNIQUE (id, job_id)
);

CREATE TABLE IF NOT EXISTS canonical_workstream_versions (
  workstream_id UUID NOT NULL,
  version INTEGER NOT NULL
    CHECK (version >= 1),
  job_id UUID NOT NULL,

  title TEXT NOT NULL
    CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),

  state TEXT NOT NULL DEFAULT 'OPEN'
    CHECK (
      state IN (
        'OPEN',
        'ACTIVE',
        'BLOCKED',
        'COMPLETED',
        'DEFERRED',
        'EXCLUDED'
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

  CONSTRAINT canonical_workstream_version_key
    PRIMARY KEY (workstream_id, version),

  CONSTRAINT canonical_workstream_version_identity_fk
    FOREIGN KEY (workstream_id, job_id)
    REFERENCES canonical_workstreams(id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_workstream_version_actor_fk
    FOREIGN KEY (created_by_participant_id, job_id)
    REFERENCES relationship_participants(id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_workstream_version_job_key
    UNIQUE (workstream_id, version, job_id)
);

CREATE INDEX IF NOT EXISTS canonical_workstream_job_order_idx
ON canonical_workstreams(job_id, sequence ASC, created_at ASC, id ASC);

CREATE INDEX IF NOT EXISTS canonical_workstream_job_state_idx
ON canonical_workstream_versions(
  job_id,
  state,
  workstream_id,
  version DESC
);

CREATE TABLE IF NOT EXISTS canonical_finding_workstream_assignments (
  id UUID PRIMARY KEY,

  finding_id UUID NOT NULL UNIQUE,
  workstream_id UUID NOT NULL,
  job_id UUID NOT NULL,
  assigned_by_participant_id UUID NOT NULL,

  source_evidence_type TEXT NOT NULL
    CHECK (char_length(btrim(source_evidence_type)) BETWEEN 1 AND 120),

  source_evidence_reference TEXT NOT NULL
    CHECK (char_length(btrim(source_evidence_reference)) BETWEEN 1 AND 200),

  idempotency_key TEXT NOT NULL
    CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),

  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT canonical_finding_workstream_finding_fk
    FOREIGN KEY (finding_id, job_id)
    REFERENCES canonical_evaluation_findings(id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_finding_workstream_workstream_fk
    FOREIGN KEY (workstream_id, job_id)
    REFERENCES canonical_workstreams(id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_finding_workstream_actor_fk
    FOREIGN KEY (assigned_by_participant_id, job_id)
    REFERENCES relationship_participants(id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_finding_workstream_command_key
    UNIQUE (assigned_by_participant_id, finding_id, idempotency_key),

  CONSTRAINT canonical_finding_workstream_scope_key
    UNIQUE (finding_id, workstream_id, job_id)
);

CREATE INDEX IF NOT EXISTS canonical_finding_workstream_lookup_idx
ON canonical_finding_workstream_assignments(
  workstream_id,
  created_at ASC,
  finding_id ASC
);

CREATE TABLE IF NOT EXISTS canonical_work_activities (
  id UUID PRIMARY KEY,

  workstream_id UUID NOT NULL,
  job_id UUID NOT NULL,
  actor_participant_id UUID NOT NULL,

  source_evidence_type TEXT NOT NULL
    CHECK (char_length(btrim(source_evidence_type)) BETWEEN 1 AND 120),

  source_evidence_reference TEXT NOT NULL
    CHECK (char_length(btrim(source_evidence_reference)) BETWEEN 1 AND 200),

  idempotency_key TEXT NOT NULL
    CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),

  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT canonical_work_activity_workstream_fk
    FOREIGN KEY (workstream_id, job_id)
    REFERENCES canonical_workstreams(id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_work_activity_actor_fk
    FOREIGN KEY (actor_participant_id, job_id)
    REFERENCES relationship_participants(id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_work_activity_command_key
    UNIQUE (actor_participant_id, workstream_id, idempotency_key),

  CONSTRAINT canonical_work_activity_scope_key
    UNIQUE (id, workstream_id, job_id)
);

CREATE TABLE IF NOT EXISTS canonical_work_activity_versions (
  activity_id UUID NOT NULL,
  version INTEGER NOT NULL
    CHECK (version >= 1),
  workstream_id UUID NOT NULL,
  job_id UUID NOT NULL,

  activity_type TEXT NOT NULL
    CHECK (activity_type ~ '^[A-Z][A-Z0-9_]{2,79}$'),

  statement TEXT NOT NULL
    CHECK (char_length(btrim(statement)) BETWEEN 1 AND 5000),

  status TEXT NOT NULL DEFAULT 'PLANNED'
    CHECK (status IN ('PLANNED', 'IN_PROGRESS', 'DONE', 'CANCELLED')),

  temporary_intervention BOOLEAN NOT NULL DEFAULT FALSE,

  temporary_details TEXT,

  performed_at TIMESTAMPTZ,

  created_by_participant_id UUID NOT NULL,

  integrity_algorithm TEXT NOT NULL DEFAULT 'sha256'
    CHECK (integrity_algorithm = 'sha256'),

  integrity_hash TEXT NOT NULL
    CHECK (integrity_hash ~ '^[0-9a-f]{64}$'),

  integrity_version SMALLINT NOT NULL DEFAULT 1
    CHECK (integrity_version = 1),

  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT canonical_work_activity_version_key
    PRIMARY KEY (activity_id, version),

  CONSTRAINT canonical_work_activity_version_identity_fk
    FOREIGN KEY (activity_id, workstream_id, job_id)
    REFERENCES canonical_work_activities(id, workstream_id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_work_activity_version_actor_fk
    FOREIGN KEY (created_by_participant_id, job_id)
    REFERENCES relationship_participants(id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_work_activity_done_time_check
    CHECK (status <> 'DONE' OR performed_at IS NOT NULL),

  CONSTRAINT canonical_work_activity_temporary_shape_check
    CHECK (
      (
        temporary_intervention = FALSE
        AND temporary_details IS NULL
      )
      OR
      (
        temporary_intervention = TRUE
        AND temporary_details IS NOT NULL
        AND char_length(btrim(temporary_details)) BETWEEN 1 AND 2000
      )
    ),

  CONSTRAINT canonical_work_activity_version_scope_key
    UNIQUE (activity_id, version, workstream_id, job_id)
);

CREATE INDEX IF NOT EXISTS canonical_work_activity_state_time_idx
ON canonical_work_activity_versions(
  workstream_id,
  status,
  performed_at ASC,
  activity_id,
  version DESC
);

CREATE UNIQUE INDEX IF NOT EXISTS
  canonical_evaluation_finding_version_resolution_uidx
ON canonical_evaluation_finding_versions(
  finding_id,
  version,
  job_id,
  resolution_state
);

CREATE TABLE IF NOT EXISTS canonical_finding_resolution_events (
  id UUID PRIMARY KEY,

  finding_id UUID NOT NULL,
  previous_finding_version INTEGER NOT NULL
    CHECK (previous_finding_version >= 1),
  finding_version INTEGER NOT NULL
    CHECK (finding_version >= 2),
  job_id UUID NOT NULL,

  previous_resolution_state TEXT NOT NULL
    CHECK (
      previous_resolution_state IN (
        'OPEN',
        'PARTIALLY_RESOLVED',
        'RESOLVED',
        'DEFERRED'
      )
    ),

  resolution_state TEXT NOT NULL
    CHECK (
      resolution_state IN (
        'OPEN',
        'PARTIALLY_RESOLVED',
        'RESOLVED',
        'DEFERRED'
      )
    ),

  resolution_statement TEXT NOT NULL
    CHECK (char_length(btrim(resolution_statement)) BETWEEN 1 AND 5000),

  recorded_by_participant_id UUID NOT NULL,

  source_evidence_type TEXT NOT NULL
    CHECK (char_length(btrim(source_evidence_type)) BETWEEN 1 AND 120),

  source_evidence_reference TEXT NOT NULL
    CHECK (char_length(btrim(source_evidence_reference)) BETWEEN 1 AND 200),

  idempotency_key TEXT NOT NULL
    CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),

  integrity_algorithm TEXT NOT NULL DEFAULT 'sha256'
    CHECK (integrity_algorithm = 'sha256'),

  integrity_hash TEXT NOT NULL
    CHECK (integrity_hash ~ '^[0-9a-f]{64}$'),

  integrity_version SMALLINT NOT NULL DEFAULT 1
    CHECK (integrity_version = 1),

  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT canonical_finding_resolution_sequence_check
    CHECK (finding_version = previous_finding_version + 1),

  CONSTRAINT canonical_finding_resolution_transition_check
    CHECK (
      (
        previous_resolution_state = 'OPEN'
        AND resolution_state IN ('PARTIALLY_RESOLVED', 'RESOLVED', 'DEFERRED')
      )
      OR
      (
        previous_resolution_state = 'PARTIALLY_RESOLVED'
        AND resolution_state IN ('RESOLVED', 'DEFERRED')
      )
    ),

  CONSTRAINT canonical_finding_resolution_previous_version_fk
    FOREIGN KEY (
      finding_id,
      previous_finding_version,
      job_id,
      previous_resolution_state
    )
    REFERENCES canonical_evaluation_finding_versions(
      finding_id,
      version,
      job_id,
      resolution_state
    )
    ON DELETE RESTRICT,

  CONSTRAINT canonical_finding_resolution_version_fk
    FOREIGN KEY (
      finding_id,
      finding_version,
      job_id,
      resolution_state
    )
    REFERENCES canonical_evaluation_finding_versions(
      finding_id,
      version,
      job_id,
      resolution_state
    )
    ON DELETE RESTRICT,

  CONSTRAINT canonical_finding_resolution_actor_fk
    FOREIGN KEY (recorded_by_participant_id, job_id)
    REFERENCES relationship_participants(id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_finding_resolution_version_key
    UNIQUE (finding_id, finding_version),

  CONSTRAINT canonical_finding_resolution_command_key
    UNIQUE (recorded_by_participant_id, finding_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS canonical_finding_resolution_history_idx
ON canonical_finding_resolution_events(
  finding_id,
  created_at ASC,
  id ASC
);

CREATE TABLE IF NOT EXISTS canonical_workstream_obligations (
  id UUID PRIMARY KEY,

  workstream_id UUID NOT NULL,
  job_id UUID NOT NULL,
  sequence INTEGER NOT NULL
    CHECK (sequence >= 1),

  source_finding_id UUID,
  created_by_participant_id UUID NOT NULL,

  source_evidence_type TEXT NOT NULL
    CHECK (char_length(btrim(source_evidence_type)) BETWEEN 1 AND 120),

  source_evidence_reference TEXT NOT NULL
    CHECK (char_length(btrim(source_evidence_reference)) BETWEEN 1 AND 200),

  idempotency_key TEXT NOT NULL
    CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),

  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT canonical_workstream_obligation_workstream_fk
    FOREIGN KEY (workstream_id, job_id)
    REFERENCES canonical_workstreams(id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_workstream_obligation_finding_fk
    FOREIGN KEY (source_finding_id, workstream_id, job_id)
    REFERENCES canonical_finding_workstream_assignments(
      finding_id,
      workstream_id,
      job_id
    )
    ON DELETE RESTRICT,

  CONSTRAINT canonical_workstream_obligation_actor_fk
    FOREIGN KEY (created_by_participant_id, job_id)
    REFERENCES relationship_participants(id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_workstream_obligation_sequence_key
    UNIQUE (workstream_id, sequence),

  CONSTRAINT canonical_workstream_obligation_command_key
    UNIQUE (created_by_participant_id, workstream_id, idempotency_key),

  CONSTRAINT canonical_workstream_obligation_scope_key
    UNIQUE (id, workstream_id, job_id)
);

CREATE TABLE IF NOT EXISTS canonical_workstream_obligation_versions (
  obligation_id UUID NOT NULL,
  version INTEGER NOT NULL
    CHECK (version >= 1),
  workstream_id UUID NOT NULL,
  job_id UUID NOT NULL,

  statement TEXT NOT NULL
    CHECK (char_length(btrim(statement)) BETWEEN 1 AND 5000),

  status TEXT NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN', 'SATISFIED', 'DEFERRED', 'EXCLUDED')),

  created_by_participant_id UUID NOT NULL,

  integrity_algorithm TEXT NOT NULL DEFAULT 'sha256'
    CHECK (integrity_algorithm = 'sha256'),

  integrity_hash TEXT NOT NULL
    CHECK (integrity_hash ~ '^[0-9a-f]{64}$'),

  integrity_version SMALLINT NOT NULL DEFAULT 1
    CHECK (integrity_version = 1),

  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT canonical_workstream_obligation_version_key
    PRIMARY KEY (obligation_id, version),

  CONSTRAINT canonical_workstream_obligation_version_identity_fk
    FOREIGN KEY (obligation_id, workstream_id, job_id)
    REFERENCES canonical_workstream_obligations(id, workstream_id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_workstream_obligation_version_actor_fk
    FOREIGN KEY (created_by_participant_id, job_id)
    REFERENCES relationship_participants(id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_workstream_obligation_version_scope_key
    UNIQUE (obligation_id, version, workstream_id, job_id)
);

CREATE INDEX IF NOT EXISTS canonical_workstream_obligation_state_idx
ON canonical_workstream_obligation_versions(
  workstream_id,
  status,
  obligation_id,
  version DESC
);

-- Workstream state, Work Activity status, Finding resolution, obligation state,
-- and overall Job state remain independent. No trigger in this migration moves
-- one state because another row is inserted or completed. Existing Job state
-- projection remains owned by the established request/relationship/workflow
-- persistence outside this schema foundation.

DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'canonical_workstreams',
    'canonical_workstream_versions',
    'canonical_finding_workstream_assignments',
    'canonical_work_activities',
    'canonical_work_activity_versions',
    'canonical_finding_resolution_events',
    'canonical_workstream_obligations',
    'canonical_workstream_obligation_versions'
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
