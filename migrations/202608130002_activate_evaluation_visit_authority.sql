-- MC-PL-002C: Evaluation-scoped Visit authority activation.
--
-- Visit command capabilities remain generic, but Evaluation activation must
-- not make APPROVED_WORK or FOLLOW_UP Visits available. Extend the existing
-- lifecycle grant scope so each activated grant is bound to the exact
-- canonical Evaluation subject for the same lifecycle-v2 Job.

ALTER TABLE lifecycle_authority_grants
ADD COLUMN IF NOT EXISTS scope_evaluation_id UUID;

ALTER TABLE lifecycle_authority_grants
DROP CONSTRAINT IF EXISTS lifecycle_authority_grants_scope_type_check;

ALTER TABLE lifecycle_authority_grants
ADD CONSTRAINT lifecycle_authority_grants_scope_type_check
CHECK (scope_type IN ('job', 'reported_concern', 'evaluation'));

ALTER TABLE lifecycle_authority_grants
DROP CONSTRAINT IF EXISTS lifecycle_authority_grants_scope_shape_check;

ALTER TABLE lifecycle_authority_grants
ADD CONSTRAINT lifecycle_authority_grants_scope_shape_check
CHECK (
  (
    scope_type = 'job'
    AND scope_concern_id IS NULL
    AND scope_evaluation_id IS NULL
  )
  OR
  (
    scope_type = 'reported_concern'
    AND scope_concern_id IS NOT NULL
    AND scope_evaluation_id IS NULL
  )
  OR
  (
    scope_type = 'evaluation'
    AND scope_concern_id IS NULL
    AND scope_evaluation_id IS NOT NULL
  )
);

ALTER TABLE lifecycle_authority_grants
ADD CONSTRAINT lifecycle_authority_grants_evaluation_scope_fk
FOREIGN KEY (scope_evaluation_id, job_id)
REFERENCES canonical_evaluation_job_subjects(evaluation_id, job_id)
ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS lifecycle_authority_grants_evaluation_scope_idx
ON lifecycle_authority_grants(
  grantee_participant_id,
  scope_evaluation_id,
  capability,
  valid_from ASC,
  id ASC
)
WHERE scope_type = 'evaluation' AND valid_until IS NULL;

CREATE TABLE IF NOT EXISTS canonical_evaluation_visit_authority_activations (
  id UUID PRIMARY KEY,
  evaluation_id UUID NOT NULL,
  job_id UUID NOT NULL,
  activated_by_participant_id UUID NOT NULL,
  idempotency_key TEXT NOT NULL
    CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  request_fingerprint TEXT NOT NULL
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT canonical_evaluation_visit_activation_subject_fk
    FOREIGN KEY (evaluation_id, job_id)
    REFERENCES canonical_evaluation_job_subjects(evaluation_id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_evaluation_visit_activation_actor_fk
    FOREIGN KEY (activated_by_participant_id, job_id)
    REFERENCES relationship_participants(id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_evaluation_visit_activation_subject_key
    UNIQUE (evaluation_id, job_id),

  CONSTRAINT canonical_evaluation_visit_activation_command_key
    UNIQUE (activated_by_participant_id, job_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS canonical_evaluation_visit_activation_job_idx
ON canonical_evaluation_visit_authority_activations(
  job_id,
  created_at ASC,
  evaluation_id ASC
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'canonical_evaluation_visit_activations_append_only'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER canonical_evaluation_visit_activations_append_only
    BEFORE UPDATE OR DELETE
    ON canonical_evaluation_visit_authority_activations
    FOR EACH ROW
    EXECUTE FUNCTION prevent_canonical_visit_history_mutation();
  END IF;
END;
$$;

-- This migration creates no activation, capability grant, Visit, Evaluation,
-- Finding, Recommendation, Quote, Workstream, Activity, Invoice, or Job row.
