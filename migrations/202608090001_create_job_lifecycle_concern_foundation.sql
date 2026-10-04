-- MC-JOB-LIFECYCLE-004B Slice 001: lifecycle version, Job identity, and
-- append-only customer Reported Concern truth.

ALTER TABLE posts
  ADD COLUMN IF NOT EXISTS lifecycle_contract_version SMALLINT NOT NULL
    DEFAULT 1;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'posts_lifecycle_contract_version_check'
  ) THEN
    ALTER TABLE posts
      ADD CONSTRAINT posts_lifecycle_contract_version_check
      CHECK (lifecycle_contract_version IN (1, 2));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS posts_lifecycle_v2_idx
ON posts(id, created_at ASC)
WHERE lifecycle_contract_version = 2;

CREATE UNIQUE INDEX IF NOT EXISTS
  request_selections_lifecycle_job_source_uidx
ON request_selections(
  id,
  request_relationship_id,
  post_id,
  selected_by_user_id
);

CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY,

  job_request_id INTEGER NOT NULL
    REFERENCES posts(id)
    ON DELETE RESTRICT,

  source_request_selection_id BIGINT NOT NULL,
  source_request_relationship_id INTEGER NOT NULL
    REFERENCES request_relationships(id)
    ON DELETE RESTRICT,

  created_by_user_id INTEGER NOT NULL
    REFERENCES users(id)
    ON DELETE RESTRICT,

  lifecycle_contract_version SMALLINT NOT NULL DEFAULT 2
    CHECK (lifecycle_contract_version = 2),

  source_type TEXT NOT NULL DEFAULT 'ordinary_request_selection'
    CHECK (source_type = 'ordinary_request_selection'),

  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT jobs_job_request_key UNIQUE (job_request_id),
  CONSTRAINT jobs_request_selection_key UNIQUE (source_request_selection_id),
  CONSTRAINT jobs_request_relationship_key UNIQUE (source_request_relationship_id),

  CONSTRAINT jobs_canonical_selection_source_fk
    FOREIGN KEY (
      source_request_selection_id,
      source_request_relationship_id,
      job_request_id,
      created_by_user_id
    )
    REFERENCES request_selections(
      id,
      request_relationship_id,
      post_id,
      selected_by_user_id
    )
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS jobs_created_by_idx
ON jobs(created_by_user_id, created_at ASC, id ASC);

CREATE TABLE IF NOT EXISTS reported_concerns (
  id UUID PRIMARY KEY,

  job_request_id INTEGER NOT NULL
    REFERENCES posts(id)
    ON DELETE RESTRICT,

  reporter_user_id INTEGER NOT NULL
    REFERENCES users(id)
    ON DELETE RESTRICT,

  original_text TEXT NOT NULL
    CHECK (char_length(btrim(original_text)) BETWEEN 1 AND 5000),

  reported_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  source_evidence_type TEXT NOT NULL DEFAULT 'job_request_create_command'
    CHECK (source_evidence_type = 'job_request_create_command'),

  source_evidence_id UUID NOT NULL
    REFERENCES job_request_create_command_idempotency(id)
    ON DELETE RESTRICT,

  sequence INTEGER NOT NULL
    CHECK (sequence >= 1),

  integrity_algorithm TEXT NOT NULL DEFAULT 'sha256'
    CHECK (integrity_algorithm = 'sha256'),

  integrity_hash TEXT NOT NULL
    CHECK (integrity_hash ~ '^[0-9a-f]{64}$'),

  integrity_version SMALLINT NOT NULL DEFAULT 1
    CHECK (integrity_version = 1),

  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT reported_concerns_request_sequence_key
    UNIQUE (job_request_id, sequence),

  CONSTRAINT reported_concerns_source_evidence_key
    UNIQUE (source_evidence_id, sequence)
);

CREATE INDEX IF NOT EXISTS reported_concerns_request_order_idx
ON reported_concerns(job_request_id, sequence ASC, reported_at ASC, id ASC);

CREATE TABLE IF NOT EXISTS concern_clarifications (
  id UUID PRIMARY KEY,

  concern_id UUID NOT NULL
    REFERENCES reported_concerns(id)
    ON DELETE RESTRICT,

  actor_user_id INTEGER NOT NULL
    REFERENCES users(id)
    ON DELETE RESTRICT,

  actor_participant_id UUID,

  semantics TEXT NOT NULL
    CHECK (
      semantics IN (
        'CLARIFIES',
        'CORRECTS_INTERPRETATION',
        'WITHDRAWS',
        'SUPERSEDES_INTERPRETATION'
      )
    ),

  clarification_text TEXT NOT NULL
    CHECK (char_length(btrim(clarification_text)) BETWEEN 1 AND 5000),

  idempotency_key TEXT NOT NULL
    CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),

  request_fingerprint TEXT NOT NULL
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),

  source_evidence_type TEXT NOT NULL DEFAULT 'concern_clarification_command'
    CHECK (source_evidence_type = 'concern_clarification_command'),

  source_evidence_id UUID NOT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT concern_clarifications_source_identity_check
    CHECK (source_evidence_id = id),

  CONSTRAINT concern_clarifications_command_key
    UNIQUE (actor_user_id, concern_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS concern_clarifications_concern_order_idx
ON concern_clarifications(concern_id, created_at ASC, id ASC);

CREATE OR REPLACE FUNCTION prevent_lifecycle_append_only_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'Lifecycle append-only records cannot be mutated.'
    USING ERRCODE = '55000';
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'jobs_stable_identity'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER jobs_stable_identity
    BEFORE UPDATE OR DELETE ON jobs
    FOR EACH ROW
    EXECUTE FUNCTION prevent_lifecycle_append_only_mutation();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'reported_concerns_append_only'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER reported_concerns_append_only
    BEFORE UPDATE OR DELETE ON reported_concerns
    FOR EACH ROW
    EXECUTE FUNCTION prevent_lifecycle_append_only_mutation();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'concern_clarifications_append_only'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER concern_clarifications_append_only
    BEFORE UPDATE OR DELETE ON concern_clarifications
    FOR EACH ROW
    EXECUTE FUNCTION prevent_lifecycle_append_only_mutation();
  END IF;
END $$;
