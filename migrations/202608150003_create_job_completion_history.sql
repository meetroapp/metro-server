-- MC-PL-CCH-FINAL: append-only operational Job completion evidence and
-- idempotent completion commands. Financial settlement remains separate.

CREATE TABLE IF NOT EXISTS canonical_job_completion_records (
  id UUID PRIMARY KEY,
  job_id UUID NOT NULL UNIQUE
    REFERENCES jobs(id)
    ON DELETE RESTRICT,
  version INTEGER NOT NULL
    CHECK (version = 1),
  status TEXT NOT NULL DEFAULT 'COMPLETED'
    CHECK (status = 'COMPLETED'),
  completed_by_participant_id UUID NOT NULL,
  workstream_count INTEGER NOT NULL
    CHECK (workstream_count > 0),
  work_item_count INTEGER NOT NULL
    CHECK (work_item_count >= 0),
  customer_update_count INTEGER NOT NULL
    CHECK (customer_update_count >= 0),
  evidence_snapshot JSONB NOT NULL
    CHECK (jsonb_typeof(evidence_snapshot) = 'object'),
  integrity_algorithm TEXT NOT NULL DEFAULT 'sha256'
    CHECK (integrity_algorithm = 'sha256'),
  integrity_hash TEXT NOT NULL
    CHECK (integrity_hash ~ '^[0-9a-f]{64}$'),
  integrity_version SMALLINT NOT NULL DEFAULT 1
    CHECK (integrity_version = 1),
  completed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT canonical_job_completion_actor_fk
    FOREIGN KEY (completed_by_participant_id, job_id)
    REFERENCES relationship_participants(id, job_id)
    ON DELETE RESTRICT,
  CONSTRAINT canonical_job_completion_identity_key UNIQUE (id, job_id)
);

CREATE INDEX IF NOT EXISTS canonical_job_completion_history_idx
ON canonical_job_completion_records(completed_at DESC, job_id DESC);

CREATE TABLE IF NOT EXISTS canonical_job_completion_command_idempotency (
  id UUID PRIMARY KEY,
  actor_participant_id UUID NOT NULL,
  job_id UUID NOT NULL,
  command_name TEXT NOT NULL
    CHECK (command_name = 'job.complete'),
  expected_job_version INTEGER NOT NULL
    CHECK (expected_job_version >= 0),
  idempotency_key TEXT NOT NULL
    CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  request_fingerprint TEXT NOT NULL
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  completion_record_id UUID,
  result_reference JSONB,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT canonical_job_completion_command_actor_fk
    FOREIGN KEY (actor_participant_id, job_id)
    REFERENCES relationship_participants(id, job_id)
    ON DELETE RESTRICT,
  CONSTRAINT canonical_job_completion_command_result_fk
    FOREIGN KEY (completion_record_id, job_id)
    REFERENCES canonical_job_completion_records(id, job_id)
    ON DELETE RESTRICT,
  CONSTRAINT canonical_job_completion_command_result_check
    CHECK (
      (
        completion_record_id IS NULL
        AND result_reference IS NULL
        AND completed_at IS NULL
      )
      OR
      (
        completion_record_id IS NOT NULL
        AND jsonb_typeof(result_reference) = 'object'
        AND completed_at IS NOT NULL
      )
    ),
  CONSTRAINT canonical_job_completion_command_key
    UNIQUE (actor_participant_id, job_id, command_name, idempotency_key)
);

CREATE INDEX IF NOT EXISTS canonical_job_completion_command_job_idx
ON canonical_job_completion_command_idempotency(
  job_id,
  created_at DESC,
  id DESC
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'canonical_job_completion_records_append_only'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER canonical_job_completion_records_append_only
    BEFORE UPDATE OR DELETE ON canonical_job_completion_records
    FOR EACH ROW
    EXECUTE FUNCTION prevent_lifecycle_append_only_mutation();
  END IF;
END $$;
