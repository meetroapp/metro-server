-- MC-PL-002D: exact approved-Quote-decision-scoped Visit authority.
--
-- Quote approval authorizes scope. Approved Work Visit authority governs only
-- timing and attendance. This migration creates no grants, activations,
-- Visits, Workstreams, Activities, Quote decisions, or other business rows.

ALTER TABLE lifecycle_authority_grants
ADD COLUMN IF NOT EXISTS scope_approved_quote_decision_id UUID;

ALTER TABLE lifecycle_authority_grants
ADD COLUMN IF NOT EXISTS scope_approved_quote_decision TEXT;

ALTER TABLE lifecycle_authority_grants
DROP CONSTRAINT IF EXISTS lifecycle_authority_grants_scope_type_check;

ALTER TABLE lifecycle_authority_grants
ADD CONSTRAINT lifecycle_authority_grants_scope_type_check
CHECK (scope_type IN ('job', 'reported_concern', 'evaluation', 'approved_work'));

ALTER TABLE lifecycle_authority_grants
DROP CONSTRAINT IF EXISTS lifecycle_authority_grants_scope_shape_check;

ALTER TABLE lifecycle_authority_grants
ADD CONSTRAINT lifecycle_authority_grants_scope_shape_check
CHECK (
  (
    scope_type = 'job'
    AND scope_concern_id IS NULL
    AND scope_evaluation_id IS NULL
    AND scope_approved_quote_decision_id IS NULL
    AND scope_approved_quote_decision IS NULL
  )
  OR
  (
    scope_type = 'reported_concern'
    AND scope_concern_id IS NOT NULL
    AND scope_evaluation_id IS NULL
    AND scope_approved_quote_decision_id IS NULL
    AND scope_approved_quote_decision IS NULL
  )
  OR
  (
    scope_type = 'evaluation'
    AND scope_concern_id IS NULL
    AND scope_evaluation_id IS NOT NULL
    AND scope_approved_quote_decision_id IS NULL
    AND scope_approved_quote_decision IS NULL
  )
  OR
  (
    scope_type = 'approved_work'
    AND scope_concern_id IS NULL
    AND scope_evaluation_id IS NULL
    AND scope_approved_quote_decision_id IS NOT NULL
    AND scope_approved_quote_decision = 'APPROVED'
  )
);

ALTER TABLE lifecycle_authority_grants
ADD CONSTRAINT lifecycle_authority_grants_approved_work_scope_fk
FOREIGN KEY (
  scope_approved_quote_decision_id,
  job_id,
  scope_approved_quote_decision
)
REFERENCES canonical_quote_customer_decisions(id, job_id, decision)
ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS lifecycle_authority_grants_approved_work_scope_idx
ON lifecycle_authority_grants(
  grantee_participant_id,
  scope_approved_quote_decision_id,
  capability,
  valid_from ASC,
  id ASC
)
WHERE scope_type = 'approved_work' AND valid_until IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS
  canonical_quote_customer_decision_approved_work_evidence_uidx
ON canonical_quote_customer_decisions(id, quote_id, job_id, decision);

CREATE TABLE IF NOT EXISTS canonical_approved_work_visit_authority_activations (
  id UUID PRIMARY KEY,
  quote_id UUID NOT NULL,
  approved_quote_decision_id UUID NOT NULL,
  approved_quote_decision TEXT NOT NULL DEFAULT 'APPROVED'
    CHECK (approved_quote_decision = 'APPROVED'),
  job_id UUID NOT NULL,
  activated_by_participant_id UUID NOT NULL,
  idempotency_key TEXT NOT NULL
    CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  request_fingerprint TEXT NOT NULL
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT canonical_approved_work_visit_activation_decision_fk
    FOREIGN KEY (
      approved_quote_decision_id,
      quote_id,
      job_id,
      approved_quote_decision
    )
    REFERENCES canonical_quote_customer_decisions(
      id,
      quote_id,
      job_id,
      decision
    )
    ON DELETE RESTRICT,

  CONSTRAINT canonical_approved_work_visit_activation_actor_fk
    FOREIGN KEY (activated_by_participant_id, job_id)
    REFERENCES relationship_participants(id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_approved_work_visit_activation_decision_key
    UNIQUE (approved_quote_decision_id, job_id),

  CONSTRAINT canonical_approved_work_visit_activation_quote_key
    UNIQUE (quote_id, job_id),

  CONSTRAINT canonical_approved_work_visit_activation_command_key
    UNIQUE (activated_by_participant_id, job_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS canonical_approved_work_visit_activation_job_idx
ON canonical_approved_work_visit_authority_activations(
  job_id,
  created_at ASC,
  approved_quote_decision_id ASC
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'canonical_approved_work_visit_activations_append_only'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER canonical_approved_work_visit_activations_append_only
    BEFORE UPDATE OR DELETE
    ON canonical_approved_work_visit_authority_activations
    FOR EACH ROW
    EXECUTE FUNCTION prevent_canonical_visit_history_mutation();
  END IF;
END;
$$;

-- This migration creates no activation, capability grant, Visit, Quote,
-- Workstream, Activity, Evaluation, Finding, Recommendation, Invoice, or Job
-- business row and performs no historical inference or backfill.
