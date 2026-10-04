-- Meetro three-path canonical Evaluation Job-source generalization.
--
-- This migration generalizes canonical Evaluation persistence from an
-- ordinary Request-Relationship-only model to a governed Job-centered model.
--
-- Supported full-workflow Job origins:
--
--   1. ordinary_request_selection
--      Request + Request Relationship + Request Selection
--
--   2. existing_customer_request
--      Request + fresh Request Relationship
--      NO Request Selection
--
--   3. business_customer
--      durable business-owned Customer + business-customer Job source
--      NO Request / Request Relationship / Request Selection
--
-- business_document remains a compatibility / Quick Quote source and is
-- intentionally NOT admitted to the full-workflow Evaluation Job subject.
--
-- Emergency Evaluation authority remains separate and unchanged.
--
-- This migration creates no Evaluation, Finding, Visit, Quote, payment,
-- Invoice, or historical business row.


-- =========================================================================
-- SUPPORTING SOURCE IDENTITIES
-- =========================================================================

CREATE UNIQUE INDEX IF NOT EXISTS
  business_customer_job_sources_evaluation_owner_uidx
ON business_customer_job_sources(
  id,
  contractor_profile_id,
  created_by_user_id
);

CREATE UNIQUE INDEX IF NOT EXISTS
  jobs_evaluation_source_identity_uidx
ON jobs(
  id,
  source_type,
  source_business_customer_job_id
);

CREATE UNIQUE INDEX IF NOT EXISTS
  commercial_authority_aggregate_identity_source_context_uidx
ON commercial_authority_aggregates(
  id,
  source_context_type
);


-- =========================================================================
-- COMMERCIAL AUTHORITY AGGREGATE — BUSINESS CUSTOMER SOURCE
-- =========================================================================

ALTER TABLE commercial_authority_aggregates
  ADD COLUMN IF NOT EXISTS
    business_customer_job_source_id UUID;

ALTER TABLE commercial_authority_aggregates
  DROP CONSTRAINT IF EXISTS
    commercial_authority_aggregates_source_context_type_check;

ALTER TABLE commercial_authority_aggregates
  ADD CONSTRAINT
    commercial_authority_aggregates_source_context_type_check
  CHECK (
    source_context_type IN (
      'ordinary_request',
      'emergency_request',
      'business_document',
      'business_customer'
    )
  );

ALTER TABLE commercial_authority_aggregates
  DROP CONSTRAINT IF EXISTS
    commercial_authority_aggregate_source_check;

ALTER TABLE commercial_authority_aggregates
  ADD CONSTRAINT
    commercial_authority_aggregate_source_check
  CHECK (
    (
      source_context_type = 'ordinary_request'
      AND ordinary_request_id IS NOT NULL
      AND emergency_request_id IS NULL
      AND business_document_id IS NULL
      AND contractor_profile_id IS NULL
      AND business_customer_job_source_id IS NULL
    )
    OR
    (
      source_context_type = 'emergency_request'
      AND ordinary_request_id IS NULL
      AND emergency_request_id IS NOT NULL
      AND business_document_id IS NULL
      AND contractor_profile_id IS NULL
      AND business_customer_job_source_id IS NULL
    )
    OR
    (
      source_context_type = 'business_document'
      AND ordinary_request_id IS NULL
      AND emergency_request_id IS NULL
      AND relationship_id IS NULL
      AND business_document_id IS NOT NULL
      AND contractor_profile_id IS NOT NULL
      AND business_customer_job_source_id IS NULL
    )
    OR
    (
      source_context_type = 'business_customer'
      AND ordinary_request_id IS NULL
      AND emergency_request_id IS NULL
      AND relationship_id IS NULL
      AND business_document_id IS NULL
      AND contractor_profile_id IS NOT NULL
      AND business_customer_job_source_id IS NOT NULL
    )
  );

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname =
      'commercial_authority_aggregate_business_customer_source_fkey'
      AND conrelid =
        'commercial_authority_aggregates'::regclass
  ) THEN
    ALTER TABLE commercial_authority_aggregates
      ADD CONSTRAINT
        commercial_authority_aggregate_business_customer_source_fkey
      FOREIGN KEY (
        business_customer_job_source_id,
        contractor_profile_id,
        source_owner_user_id
      )
      REFERENCES business_customer_job_sources(
        id,
        contractor_profile_id,
        created_by_user_id
      )
      ON DELETE RESTRICT;
  END IF;
END;
$migration$;

CREATE UNIQUE INDEX IF NOT EXISTS
  commercial_authority_aggregate_business_customer_subject_uidx
ON commercial_authority_aggregates(
  id,
  source_context_type,
  business_customer_job_source_id
);

CREATE INDEX IF NOT EXISTS
  commercial_authority_aggregate_business_customer_idx
ON commercial_authority_aggregates(
  contractor_profile_id,
  business_customer_job_source_id,
  aggregate_type,
  created_at ASC,
  id ASC
)
WHERE source_context_type = 'business_customer';


-- =========================================================================
-- CANONICAL EVALUATION — REQUEST RELATIONSHIP IS SOURCE-SPECIFIC
-- =========================================================================

ALTER TABLE canonical_evaluations
  ALTER COLUMN relationship_id DROP NOT NULL;

-- Preserve the existing request-backed uniqueness rule.
-- PostgreSQL permits multiple NULL relationship values, so external
-- business-customer Evaluations are governed by the one-Job subject below.
CREATE UNIQUE INDEX IF NOT EXISTS
  canonical_evaluations_relationship_professional_nonnull_uidx
ON canonical_evaluations(
  relationship_id,
  professional_user_id
)
WHERE relationship_id IS NOT NULL;


-- =========================================================================
-- CANONICAL EVALUATION JOB SUBJECT — JOB CENTERED
-- =========================================================================

ALTER TABLE canonical_evaluation_job_subjects
  ADD COLUMN IF NOT EXISTS
    job_source_type TEXT NOT NULL
      DEFAULT 'ordinary_request_selection',
  ADD COLUMN IF NOT EXISTS
    business_customer_job_source_id UUID;

ALTER TABLE canonical_evaluation_job_subjects
  ALTER COLUMN job_request_id DROP NOT NULL,
  ALTER COLUMN relationship_id DROP NOT NULL,
  ALTER COLUMN subject_type SET DEFAULT 'job';

ALTER TABLE canonical_evaluation_job_subjects
  DROP CONSTRAINT IF EXISTS
    canonical_evaluation_job_subjects_subject_type_check;

ALTER TABLE canonical_evaluation_job_subjects
  ADD CONSTRAINT
    canonical_evaluation_job_subjects_subject_type_check
  CHECK (
    subject_type IN (
      'ordinary_job',
      'job'
    )
  );

ALTER TABLE canonical_evaluation_job_subjects
  DROP CONSTRAINT IF EXISTS
    canonical_evaluation_job_subjects_source_context_type_check;

ALTER TABLE canonical_evaluation_job_subjects
  ADD CONSTRAINT
    canonical_evaluation_job_subjects_source_context_type_check
  CHECK (
    source_context_type IN (
      'ordinary_request',
      'business_customer'
    )
  );

ALTER TABLE canonical_evaluation_job_subjects
  ADD CONSTRAINT
    canonical_evaluation_job_subject_job_source_type_check
  CHECK (
    job_source_type IN (
      'ordinary_request_selection',
      'existing_customer_request',
      'business_customer'
    )
  );

ALTER TABLE canonical_evaluation_job_subjects
  ADD CONSTRAINT
    canonical_evaluation_job_subject_source_shape_check
  CHECK (
    (
      source_context_type = 'ordinary_request'
      AND job_source_type IN (
        'ordinary_request_selection',
        'existing_customer_request'
      )
      AND job_request_id IS NOT NULL
      AND relationship_id IS NOT NULL
      AND business_customer_job_source_id IS NULL
    )
    OR
    (
      source_context_type = 'business_customer'
      AND job_source_type = 'business_customer'
      AND job_request_id IS NULL
      AND relationship_id IS NULL
      AND business_customer_job_source_id IS NOT NULL
    )
  );


-- -------------------------------------------------------------------------
-- Replace the old ordinary-only subject FKs with generic + source-specific
-- proofs. Existing ordinary rows remain valid.
-- -------------------------------------------------------------------------

ALTER TABLE canonical_evaluation_job_subjects
  DROP CONSTRAINT IF EXISTS
    canonical_evaluation_job_subject_evaluation_fk;

ALTER TABLE canonical_evaluation_job_subjects
  DROP CONSTRAINT IF EXISTS
    canonical_evaluation_job_subject_aggregate_fk;

ALTER TABLE canonical_evaluation_job_subjects
  DROP CONSTRAINT IF EXISTS
    canonical_evaluation_job_subject_job_fk;


ALTER TABLE canonical_evaluation_job_subjects
  ADD CONSTRAINT
    canonical_evaluation_job_subject_evaluation_identity_fk
  FOREIGN KEY (evaluation_id)
  REFERENCES canonical_evaluations(id)
  ON DELETE RESTRICT;


ALTER TABLE canonical_evaluation_job_subjects
  ADD CONSTRAINT
    canonical_evaluation_job_subject_evaluation_relationship_fk
  FOREIGN KEY (
    evaluation_id,
    relationship_id
  )
  REFERENCES canonical_evaluations(
    id,
    relationship_id
  )
  ON DELETE RESTRICT;


ALTER TABLE canonical_evaluation_job_subjects
  ADD CONSTRAINT
    canonical_evaluation_job_subject_aggregate_context_fk
  FOREIGN KEY (
    evaluation_id,
    source_context_type
  )
  REFERENCES commercial_authority_aggregates(
    id,
    source_context_type
  )
  ON DELETE RESTRICT;


-- Request-backed aggregate proof.
-- NULL request fields on business_customer make this FK intentionally
-- inapplicable to that branch.
ALTER TABLE canonical_evaluation_job_subjects
  ADD CONSTRAINT
    canonical_evaluation_job_subject_ordinary_aggregate_fk
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
  ON DELETE RESTRICT;


-- business_customer aggregate proof.
ALTER TABLE canonical_evaluation_job_subjects
  ADD CONSTRAINT
    canonical_evaluation_job_subject_business_customer_aggregate_fk
  FOREIGN KEY (
    evaluation_id,
    source_context_type,
    business_customer_job_source_id
  )
  REFERENCES commercial_authority_aggregates(
    id,
    source_context_type,
    business_customer_job_source_id
  )
  ON DELETE RESTRICT;


ALTER TABLE canonical_evaluation_job_subjects
  ADD CONSTRAINT
    canonical_evaluation_job_subject_job_identity_fk
  FOREIGN KEY (job_id)
  REFERENCES jobs(id)
  ON DELETE RESTRICT;


-- Proves the exact canonical Job origin for all full-workflow branches.
ALTER TABLE canonical_evaluation_job_subjects
  ADD CONSTRAINT
    canonical_evaluation_job_subject_job_source_fk
  FOREIGN KEY (
    job_id,
    job_source_type
  )
  REFERENCES jobs(
    id,
    source_type
  )
  ON DELETE RESTRICT;


-- Request-backed Job proof. business_customer NULL request fields bypass it.
ALTER TABLE canonical_evaluation_job_subjects
  ADD CONSTRAINT
    canonical_evaluation_job_subject_request_job_fk
  FOREIGN KEY (
    job_id,
    job_request_id,
    relationship_id
  )
  REFERENCES jobs(
    id,
    job_request_id,
    source_request_relationship_id
  )
  ON DELETE RESTRICT;


-- External business-customer source proof.
ALTER TABLE canonical_evaluation_job_subjects
  ADD CONSTRAINT
    canonical_evaluation_job_subject_business_customer_job_fk
  FOREIGN KEY (
    job_id,
    job_source_type,
    business_customer_job_source_id
  )
  REFERENCES jobs(
    id,
    source_type,
    source_business_customer_job_id
  )
  ON DELETE RESTRICT;


-- =========================================================================
-- NULL-SAFE CROSS-TABLE SUBJECT ASSERTION
-- =========================================================================

CREATE OR REPLACE FUNCTION
assert_canonical_evaluation_job_subject_source()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM canonical_evaluations evaluations
    INNER JOIN commercial_authority_aggregates aggregates
      ON aggregates.id = evaluations.id
     AND aggregates.aggregate_type = 'evaluation'
     AND aggregates.owning_engine =
           'authorization_engine'
    INNER JOIN jobs
      ON jobs.id = NEW.job_id
     AND jobs.source_type =
           NEW.job_source_type
    WHERE evaluations.id =
          NEW.evaluation_id
      AND evaluations.relationship_id
          IS NOT DISTINCT FROM
          NEW.relationship_id
      AND aggregates.source_context_type =
          NEW.source_context_type
      AND (
        (
          NEW.source_context_type =
            'ordinary_request'
          AND NEW.job_source_type IN (
            'ordinary_request_selection',
            'existing_customer_request'
          )
          AND aggregates.ordinary_request_id =
              NEW.job_request_id
          AND aggregates.relationship_id =
              NEW.relationship_id
          AND jobs.job_request_id =
              NEW.job_request_id
          AND jobs.source_request_relationship_id =
              NEW.relationship_id
          AND jobs.source_business_customer_job_id
              IS NULL
        )
        OR
        (
          NEW.source_context_type =
            'business_customer'
          AND NEW.job_source_type =
              'business_customer'
          AND aggregates.relationship_id IS NULL
          AND aggregates.ordinary_request_id IS NULL
          AND aggregates.emergency_request_id IS NULL
          AND aggregates.business_document_id IS NULL
          AND aggregates.business_customer_job_source_id =
              NEW.business_customer_job_source_id
          AND jobs.job_request_id IS NULL
          AND jobs.source_request_selection_id IS NULL
          AND jobs.source_request_relationship_id IS NULL
          AND jobs.originating_business_document_id IS NULL
          AND jobs.source_business_customer_job_id =
              NEW.business_customer_job_source_id
        )
      )
  ) THEN
    RAISE EXCEPTION
      'Canonical Evaluation Job subject source identity is invalid.'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  canonical_evaluation_job_subject_source_guard
ON canonical_evaluation_job_subjects;

CREATE TRIGGER
  canonical_evaluation_job_subject_source_guard
BEFORE INSERT OR UPDATE
ON canonical_evaluation_job_subjects
FOR EACH ROW
EXECUTE FUNCTION
  assert_canonical_evaluation_job_subject_source();


-- =========================================================================
-- REMOTE EVALUATION PROVENANCE — JOB SOURCE AWARE
-- =========================================================================

CREATE OR REPLACE FUNCTION
assert_evaluation_remote_provenance_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  evaluation_relationship_id INTEGER;
  evaluation_professional_user_id INTEGER;
  evaluation_state TEXT;
  evaluation_source_context_type TEXT;
  aggregate_version INTEGER;
  command_completed_at TIMESTAMPTZ;
BEGIN
  SELECT
    evaluations.relationship_id,
    evaluations.professional_user_id,
    evaluations.status,
    aggregates.source_context_type,
    aggregates.current_version
  INTO
    evaluation_relationship_id,
    evaluation_professional_user_id,
    evaluation_state,
    evaluation_source_context_type,
    aggregate_version
  FROM canonical_evaluations evaluations
  INNER JOIN commercial_authority_aggregates aggregates
    ON aggregates.id = evaluations.id
   AND aggregates.aggregate_type = 'evaluation'
   AND aggregates.owning_engine =
         'authorization_engine'
   AND aggregates.source_context_type IN (
     'ordinary_request',
     'business_customer'
   )
  WHERE evaluations.id =
        NEW.evaluation_id
  FOR UPDATE OF evaluations;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Remote provenance requires a canonical Job Evaluation.'
      USING ERRCODE = '23503';
  END IF;

  IF evaluation_state <> 'completed'
     OR aggregate_version <>
        NEW.evaluation_version
     OR NOT EXISTS (
       SELECT 1
       FROM canonical_evaluation_versions versions
       WHERE versions.evaluation_id =
             NEW.evaluation_id
         AND versions.version =
             NEW.evaluation_version
         AND versions.status =
             'completed'
     )
  THEN
    RAISE EXCEPTION
      'Remote provenance requires the current completed Evaluation version.'
      USING ERRCODE = '23514';
  END IF;

  SELECT commands.completed_at
  INTO command_completed_at
  FROM commercial_command_idempotency commands
  WHERE commands.id =
        NEW.completion_command_idempotency_id
    AND commands.actor_user_id =
        evaluation_professional_user_id
    AND commands.command_name =
        'evaluation.complete'
    AND commands.command_scope =
        'evaluation:' ||
        NEW.evaluation_id::text
    AND commands.aggregate_id =
        NEW.evaluation_id
    AND commands.result_reference
        IS NOT NULL
    AND commands.completed_at
        IS NOT NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Remote provenance requires the completed Evaluation command.'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM canonical_evaluation_job_subjects subjects
    INNER JOIN jobs
      ON jobs.id = subjects.job_id
     AND jobs.source_type =
           subjects.job_source_type
    INNER JOIN relationship_participants participants
      ON participants.id =
           NEW.professional_participant_id
     AND participants.job_id =
           subjects.job_id
     AND participants.user_id =
           evaluation_professional_user_id
     AND participants.created_at <=
           command_completed_at
    WHERE subjects.evaluation_id =
          NEW.evaluation_id
      AND subjects.job_id =
          NEW.job_id
      AND subjects.relationship_id
          IS NOT DISTINCT FROM
          evaluation_relationship_id
      AND subjects.source_context_type =
          evaluation_source_context_type
      AND (
        (
          subjects.job_source_type =
            'ordinary_request_selection'
          AND participants.request_relationship_id =
              subjects.relationship_id
          AND participants.source_evidence_type =
              'request_selection'
        )
        OR
        (
          subjects.job_source_type =
            'existing_customer_request'
          AND participants.request_relationship_id =
              subjects.relationship_id
          AND participants.source_evidence_type =
              'existing_customer_request'
        )
        OR
        (
          subjects.job_source_type =
            'business_customer'
          AND subjects.relationship_id IS NULL
          AND participants.request_relationship_id
              IS NULL
          AND participants.source_evidence_type =
              'business_customer'
          AND jobs.source_business_customer_job_id =
              subjects.business_customer_job_source_id
        )
      )
  )
  THEN
    RAISE EXCEPTION
      'Remote provenance participant does not own this Evaluation Job.'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM participant_role_assignments assignments
    WHERE assignments.participant_id =
          NEW.professional_participant_id
      AND assignments.job_id =
          NEW.job_id
      AND assignments.role =
          'PRIMARY_PROFESSIONAL'
      AND assignments.valid_from <=
          command_completed_at
      AND (
        assignments.valid_until IS NULL
        OR assignments.valid_until >
           command_completed_at
      )
      AND NOT EXISTS (
        SELECT 1
        FROM participant_role_revocations revocations
        WHERE revocations.role_assignment_id =
              assignments.id
          AND revocations.job_id =
              assignments.job_id
          AND revocations.revoked_at <=
              command_completed_at
      )
  )
  THEN
    RAISE EXCEPTION
      'Remote provenance requires the active primary professional.'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM lifecycle_authority_grants grants
    WHERE grants.grantee_participant_id =
          NEW.professional_participant_id
      AND grants.job_id =
          NEW.job_id
      AND grants.scope_job_id =
          NEW.job_id
      AND grants.capability =
          'evaluation.perform'
      AND grants.valid_from <=
          command_completed_at
      AND (
        grants.valid_until IS NULL
        OR grants.valid_until >
           command_completed_at
      )
      AND (
        grants.scope_type = 'job'
        OR (
          grants.scope_type =
            'evaluation'
          AND grants.scope_evaluation_id =
              NEW.evaluation_id
        )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM lifecycle_authority_grant_revocations revocations
        WHERE revocations.authority_grant_id =
              grants.id
          AND revocations.job_id =
              grants.job_id
          AND revocations.revoked_at <=
              command_completed_at
      )
  )
  THEN
    RAISE EXCEPTION
      'Remote provenance requires active Evaluation authority.'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM canonical_visit_evaluation_links links
    WHERE links.evaluation_id =
          NEW.evaluation_id
  )
  THEN
    RAISE EXCEPTION
      'Physical and remote Evaluation provenance are mutually exclusive.'
      USING ERRCODE = '23514';
  END IF;

  PERFORM claim_evaluation_provenance(
    NEW.evaluation_id,
    'REMOTE'
  );

  RETURN NEW;
END;
$$;


COMMENT ON COLUMN
  commercial_authority_aggregates.business_customer_job_source_id IS
  'Canonical pre-Quote business-customer Job source for source_context_type=business_customer; NULL for ordinary, Emergency, and business-document sources.';

COMMENT ON COLUMN
  canonical_evaluation_job_subjects.job_source_type IS
  'Exact governed Job origin for the Evaluation subject. Full-workflow values are ordinary_request_selection, existing_customer_request, and business_customer.';

COMMENT ON COLUMN
  canonical_evaluation_job_subjects.business_customer_job_source_id IS
  'Exact pre-Quote business-customer Job source for a business_customer Evaluation; NULL for request-backed Evaluation subjects.';
