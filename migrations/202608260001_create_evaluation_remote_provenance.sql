-- MC-EVALUATION-VISIT-R1-R4-R5: immutable remote/no-Visit Evaluation
-- provenance. This migration creates no historical business rows, performs no
-- backfill, and does not infer remote assessment from missing Visit history.

-- This internal claim relation is the single PostgreSQL arbitration key for
-- the physical and remote provenance branches. It is not a lifecycle record or
-- customer-facing authority: the canonical physical and remote records remain
-- authoritative. Both insert paths must win this same unique Evaluation key,
-- so snapshot isolation cannot admit one row on each branch.
CREATE TABLE IF NOT EXISTS canonical_evaluation_provenance_claims (
  evaluation_id UUID PRIMARY KEY
    REFERENCES canonical_evaluations(id)
    ON DELETE RESTRICT,

  provenance_kind TEXT NOT NULL
    CHECK (provenance_kind IN ('PHYSICAL', 'REMOTE')),

  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS canonical_evaluation_remote_provenance (
  id UUID PRIMARY KEY,

  evaluation_id UUID NOT NULL,
  evaluation_version INTEGER NOT NULL
    CHECK (evaluation_version >= 1),
  job_id UUID NOT NULL,
  professional_participant_id UUID NOT NULL,

  assessment_method TEXT NOT NULL
    CHECK (
      assessment_method IN (
        'PHONE',
        'VIDEO',
        'CUSTOMER_PHOTOS',
        'DOCUMENT_REVIEW',
        'OTHER_REMOTE'
      )
    ),

  assessment_basis TEXT NOT NULL
    CHECK (
      assessment_basis = btrim(assessment_basis)
      AND char_length(assessment_basis) BETWEEN 1 AND 2000
    ),

  completion_command_idempotency_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT evaluation_remote_provenance_evaluation_key
    UNIQUE (evaluation_id),

  CONSTRAINT evaluation_remote_provenance_command_key
    UNIQUE (completion_command_idempotency_id),

  CONSTRAINT evaluation_remote_provenance_version_fk
    FOREIGN KEY (evaluation_id, evaluation_version)
    REFERENCES canonical_evaluation_versions(evaluation_id, version)
    ON DELETE RESTRICT,

  CONSTRAINT evaluation_remote_provenance_job_fk
    FOREIGN KEY (evaluation_id, job_id)
    REFERENCES canonical_evaluation_job_subjects(evaluation_id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT evaluation_remote_provenance_participant_fk
    FOREIGN KEY (professional_participant_id, job_id)
    REFERENCES relationship_participants(id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT evaluation_remote_provenance_command_fk
    FOREIGN KEY (completion_command_idempotency_id)
    REFERENCES commercial_command_idempotency(id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS evaluation_remote_provenance_job_history_idx
ON canonical_evaluation_remote_provenance(
  job_id,
  created_at DESC,
  id ASC
);

CREATE OR REPLACE FUNCTION claim_evaluation_provenance(
  claimed_evaluation_id UUID,
  claimed_provenance_kind TEXT
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  existing_provenance_kind TEXT;
BEGIN
  IF claimed_provenance_kind NOT IN ('PHYSICAL', 'REMOTE') THEN
    RAISE EXCEPTION 'Evaluation provenance claim kind is invalid.'
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO canonical_evaluation_provenance_claims (
    evaluation_id,
    provenance_kind
  ) VALUES (
    claimed_evaluation_id,
    claimed_provenance_kind
  )
  ON CONFLICT (evaluation_id) DO NOTHING;

  IF FOUND THEN
    RETURN;
  END IF;

  SELECT claims.provenance_kind
  INTO existing_provenance_kind
  FROM canonical_evaluation_provenance_claims claims
  WHERE claims.evaluation_id = claimed_evaluation_id;

  -- Under REPEATABLE READ a concurrently committed unique-key winner may not
  -- be visible in this transaction's older snapshot. Fail closed rather than
  -- inferring that no claim exists.
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Evaluation provenance claim changed concurrently.'
      USING ERRCODE = '40001';
  END IF;

  IF existing_provenance_kind <> claimed_provenance_kind THEN
    RAISE EXCEPTION 'Physical and remote Evaluation provenance are mutually exclusive.'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION assert_evaluation_remote_provenance_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  evaluation_relationship_id INTEGER;
  evaluation_professional_user_id INTEGER;
  evaluation_state TEXT;
  aggregate_version INTEGER;
  command_completed_at TIMESTAMPTZ;
BEGIN
  -- Preserve the project lock order while validating canonical Evaluation
  -- state. Strict cross-branch arbitration is enforced later by the shared
  -- unique Evaluation claim, not by post-wait snapshot visibility.
  SELECT
    evaluations.relationship_id,
    evaluations.professional_user_id,
    evaluations.status,
    aggregates.current_version
  INTO
    evaluation_relationship_id,
    evaluation_professional_user_id,
    evaluation_state,
    aggregate_version
  FROM canonical_evaluations evaluations
  INNER JOIN commercial_authority_aggregates aggregates
    ON aggregates.id = evaluations.id
    AND aggregates.aggregate_type = 'evaluation'
    AND aggregates.owning_engine = 'authorization_engine'
    AND aggregates.source_context_type = 'ordinary_request'
  WHERE evaluations.id = NEW.evaluation_id
  FOR UPDATE OF evaluations;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Remote provenance requires an ordinary canonical Evaluation.'
      USING ERRCODE = '23503';
  END IF;

  IF evaluation_state <> 'completed'
    OR aggregate_version <> NEW.evaluation_version
    OR NOT EXISTS (
      SELECT 1
      FROM canonical_evaluation_versions versions
      WHERE versions.evaluation_id = NEW.evaluation_id
        AND versions.version = NEW.evaluation_version
        AND versions.status = 'completed'
    )
  THEN
    RAISE EXCEPTION 'Remote provenance requires the current completed Evaluation version.'
      USING ERRCODE = '23514';
  END IF;

  SELECT commands.completed_at
  INTO command_completed_at
  FROM commercial_command_idempotency commands
  WHERE commands.id = NEW.completion_command_idempotency_id
    AND commands.actor_user_id = evaluation_professional_user_id
    AND commands.command_name = 'evaluation.complete'
    AND commands.command_scope = 'evaluation:' || NEW.evaluation_id::text
    AND commands.aggregate_id = NEW.evaluation_id
    AND commands.result_reference IS NOT NULL
    AND commands.completed_at IS NOT NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Remote provenance requires the completed Evaluation command.'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM canonical_evaluation_job_subjects subjects
    INNER JOIN relationship_participants participants
      ON participants.id = NEW.professional_participant_id
      AND participants.job_id = subjects.job_id
      AND participants.request_relationship_id = subjects.relationship_id
      AND participants.user_id = evaluation_professional_user_id
      AND participants.created_at <= command_completed_at
    WHERE subjects.evaluation_id = NEW.evaluation_id
      AND subjects.job_id = NEW.job_id
      AND subjects.relationship_id = evaluation_relationship_id
  )
  THEN
    RAISE EXCEPTION 'Remote provenance participant does not own this Evaluation Job.'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM participant_role_assignments assignments
    WHERE assignments.participant_id = NEW.professional_participant_id
      AND assignments.job_id = NEW.job_id
      AND assignments.role = 'PRIMARY_PROFESSIONAL'
      AND assignments.valid_from <= command_completed_at
      AND (
        assignments.valid_until IS NULL
        OR assignments.valid_until > command_completed_at
      )
      AND NOT EXISTS (
        SELECT 1
        FROM participant_role_revocations revocations
          WHERE revocations.role_assignment_id = assignments.id
          AND revocations.job_id = assignments.job_id
          AND revocations.revoked_at <= command_completed_at
      )
  )
  THEN
    RAISE EXCEPTION 'Remote provenance requires the active primary professional.'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM lifecycle_authority_grants grants
    WHERE grants.grantee_participant_id = NEW.professional_participant_id
      AND grants.job_id = NEW.job_id
      AND grants.scope_job_id = NEW.job_id
      AND grants.capability = 'evaluation.perform'
      AND grants.valid_from <= command_completed_at
      AND (grants.valid_until IS NULL OR grants.valid_until > command_completed_at)
      AND (
        grants.scope_type = 'job'
        OR (
          grants.scope_type = 'evaluation'
          AND grants.scope_evaluation_id = NEW.evaluation_id
        )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM lifecycle_authority_grant_revocations revocations
          WHERE revocations.authority_grant_id = grants.id
          AND revocations.job_id = grants.job_id
          AND revocations.revoked_at <= command_completed_at
      )
  )
  THEN
    RAISE EXCEPTION 'Remote provenance requires active Evaluation authority.'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM canonical_visit_evaluation_links links
    WHERE links.evaluation_id = NEW.evaluation_id
  )
  THEN
    RAISE EXCEPTION 'Physical and remote Evaluation provenance are mutually exclusive.'
      USING ERRCODE = '23514';
  END IF;

  PERFORM claim_evaluation_provenance(NEW.evaluation_id, 'REMOTE');

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION assert_visit_evaluation_link_not_remote()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Preserve the same Evaluation-first lock order as remote provenance. The
  -- shared unique claim below remains authoritative across snapshot isolation;
  -- the existing FK remains authoritative for missing Evaluation rows.
  PERFORM 1
  FROM canonical_evaluations evaluations
  WHERE evaluations.id = NEW.evaluation_id
  FOR UPDATE;

  IF EXISTS (
    SELECT 1
    FROM canonical_evaluation_remote_provenance provenance
    WHERE provenance.evaluation_id = NEW.evaluation_id
  )
  THEN
    RAISE EXCEPTION 'Physical and remote Evaluation provenance are mutually exclusive.'
      USING ERRCODE = '23514';
  END IF;

  PERFORM claim_evaluation_provenance(NEW.evaluation_id, 'PHYSICAL');

  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'evaluation_remote_provenance_validate_insert'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER evaluation_remote_provenance_validate_insert
    BEFORE INSERT ON canonical_evaluation_remote_provenance
    FOR EACH ROW
    EXECUTE FUNCTION assert_evaluation_remote_provenance_insert();
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'visit_evaluation_link_reject_remote'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER visit_evaluation_link_reject_remote
    BEFORE INSERT ON canonical_visit_evaluation_links
    FOR EACH ROW
    EXECUTE FUNCTION assert_visit_evaluation_link_not_remote();
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'canonical_evaluation_provenance_claims_append_only'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER canonical_evaluation_provenance_claims_append_only
    BEFORE UPDATE OR DELETE ON canonical_evaluation_provenance_claims
    FOR EACH ROW
    EXECUTE FUNCTION prevent_lifecycle_append_only_mutation();
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'canonical_evaluation_remote_provenance_append_only'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER canonical_evaluation_remote_provenance_append_only
    BEFORE UPDATE OR DELETE ON canonical_evaluation_remote_provenance
    FOR EACH ROW
    EXECUTE FUNCTION prevent_lifecycle_append_only_mutation();
  END IF;
END;
$$;

-- Migration 57 creates storage and guards only. It creates no provenance
-- claim, remote provenance, Visit, Evaluation, Job, participant, Relationship,
-- authority grant, completion evidence, Quote, or other lifecycle business row.
