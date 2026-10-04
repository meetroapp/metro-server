-- ============================================================================
-- MEETRO EMERGENCY JOB EVALUATION + QUOTE SOURCE GENERALIZATION
--
-- Extends the canonical Job commercial authority model so the exact
-- emergency_request Job created from homeowner professional selection can own:
--
--   Emergency Evaluation
--   -> completed Evaluation
--   -> canonical Draft Quote source
--
-- This migration changes SOURCE IDENTITY ONLY.
--
-- It does NOT:
--   * create an Emergency Request;
--   * create a Job;
--   * create an Evaluation;
--   * create a Quote;
--   * approve a Quote;
--   * create a Deposit or payment;
--   * unlock Start Work;
--   * create an Invoice;
--   * modify historical business rows.
-- ============================================================================


-- ============================================================================
-- SUPPORTING EXACT EMERGENCY SOURCE IDENTITIES
-- ============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS
  commercial_authority_aggregate_emergency_subject_uidx
ON commercial_authority_aggregates(
  id,
  source_context_type,
  emergency_request_id,
  relationship_id
);


-- PostgreSQL foreign keys cannot target the partial Emergency-only unique
-- index created by migration 101. Provide the exact non-partial composite
-- uniqueness required by the canonical Evaluation and Quote source FKs.
--
-- `id` is already the Job primary key, so this does not broaden Job authority
-- or create new business rows. It only exposes the immutable source tuple as
-- a valid referenced key.
CREATE UNIQUE INDEX IF NOT EXISTS
  jobs_emergency_request_source_identity_fk_uidx
ON jobs(
  id,
  source_type,
  source_emergency_request_id
);


-- ============================================================================
-- CANONICAL EVALUATION JOB SUBJECT — EMERGENCY SOURCE
-- ============================================================================

ALTER TABLE canonical_evaluation_job_subjects
  ADD COLUMN IF NOT EXISTS
    emergency_request_id INTEGER;


DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname =
      'canonical_evaluation_job_subject_emergency_request_fkey'
      AND conrelid =
        'canonical_evaluation_job_subjects'::regclass
  ) THEN
    ALTER TABLE canonical_evaluation_job_subjects
      ADD CONSTRAINT
        canonical_evaluation_job_subject_emergency_request_fkey
      FOREIGN KEY (
        emergency_request_id
      )
      REFERENCES emergency_requests(id)
      ON DELETE RESTRICT;
  END IF;
END;
$migration$;


ALTER TABLE canonical_evaluation_job_subjects
  DROP CONSTRAINT IF EXISTS
    canonical_evaluation_job_subjects_source_context_type_check;

ALTER TABLE canonical_evaluation_job_subjects
  ADD CONSTRAINT
    canonical_evaluation_job_subjects_source_context_type_check
  CHECK (
    source_context_type IN (
      'ordinary_request',
      'business_customer',
      'emergency_request'
    )
  );


ALTER TABLE canonical_evaluation_job_subjects
  DROP CONSTRAINT IF EXISTS
    canonical_evaluation_job_subject_job_source_type_check;

ALTER TABLE canonical_evaluation_job_subjects
  ADD CONSTRAINT
    canonical_evaluation_job_subject_job_source_type_check
  CHECK (
    job_source_type IN (
      'ordinary_request_selection',
      'existing_customer_request',
      'business_customer',
      'emergency_request'
    )
  );


ALTER TABLE canonical_evaluation_job_subjects
  DROP CONSTRAINT IF EXISTS
    canonical_evaluation_job_subject_source_shape_check;

ALTER TABLE canonical_evaluation_job_subjects
  ADD CONSTRAINT
    canonical_evaluation_job_subject_source_shape_check
  CHECK (
    (
      source_context_type =
        'ordinary_request'

      AND job_source_type IN (
        'ordinary_request_selection',
        'existing_customer_request'
      )

      AND job_request_id IS NOT NULL
      AND relationship_id IS NOT NULL
      AND business_customer_job_source_id IS NULL
      AND emergency_request_id IS NULL
    )

    OR

    (
      source_context_type =
        'business_customer'

      AND job_source_type =
        'business_customer'

      AND job_request_id IS NULL
      AND relationship_id IS NULL
      AND business_customer_job_source_id IS NOT NULL
      AND emergency_request_id IS NULL
    )

    OR

    (
      source_context_type =
        'emergency_request'

      AND job_source_type =
        'emergency_request'

      AND job_request_id IS NULL
      AND relationship_id IS NOT NULL
      AND business_customer_job_source_id IS NULL
      AND emergency_request_id IS NOT NULL
    )
  );


DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname =
      'canonical_evaluation_job_subject_emergency_aggregate_fkey'
      AND conrelid =
        'canonical_evaluation_job_subjects'::regclass
  ) THEN
    ALTER TABLE canonical_evaluation_job_subjects
      ADD CONSTRAINT
        canonical_evaluation_job_subject_emergency_aggregate_fkey

      FOREIGN KEY (
        evaluation_id,
        source_context_type,
        emergency_request_id,
        relationship_id
      )

      REFERENCES commercial_authority_aggregates(
        id,
        source_context_type,
        emergency_request_id,
        relationship_id
      )

      ON DELETE RESTRICT;
  END IF;
END;
$migration$;


DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname =
      'canonical_evaluation_job_subject_emergency_job_fkey'
      AND conrelid =
        'canonical_evaluation_job_subjects'::regclass
  ) THEN
    ALTER TABLE canonical_evaluation_job_subjects
      ADD CONSTRAINT
        canonical_evaluation_job_subject_emergency_job_fkey

      FOREIGN KEY (
        job_id,
        job_source_type,
        emergency_request_id
      )

      REFERENCES jobs(
        id,
        source_type,
        source_emergency_request_id
      )

      ON DELETE RESTRICT;
  END IF;
END;
$migration$;


CREATE INDEX IF NOT EXISTS
  canonical_evaluation_emergency_job_idx
ON canonical_evaluation_job_subjects(
  emergency_request_id,
  job_id,
  evaluation_id
)
WHERE
  source_context_type =
    'emergency_request'
  AND job_source_type =
    'emergency_request';


-- ============================================================================
-- NULL-SAFE EVALUATION SUBJECT ASSERTION
-- ============================================================================

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
      ON aggregates.id =
           evaluations.id

     AND aggregates.aggregate_type =
           'evaluation'

     AND aggregates.owning_engine =
           'authorization_engine'

    INNER JOIN jobs
      ON jobs.id =
           NEW.job_id

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

          AND NEW.emergency_request_id
              IS NULL

          AND aggregates.ordinary_request_id =
              NEW.job_request_id

          AND aggregates.emergency_request_id
              IS NULL

          AND aggregates.relationship_id =
              NEW.relationship_id

          AND jobs.job_request_id =
              NEW.job_request_id

          AND jobs.source_request_relationship_id =
              NEW.relationship_id

          AND jobs.source_emergency_request_id
              IS NULL

          AND jobs.source_business_customer_job_id
              IS NULL
        )

        OR

        (
          NEW.source_context_type =
            'business_customer'

          AND NEW.job_source_type =
              'business_customer'

          AND NEW.emergency_request_id
              IS NULL

          AND aggregates.relationship_id
              IS NULL

          AND aggregates.ordinary_request_id
              IS NULL

          AND aggregates.emergency_request_id
              IS NULL

          AND aggregates.business_document_id
              IS NULL

          AND aggregates.business_customer_job_source_id =
              NEW.business_customer_job_source_id

          AND jobs.job_request_id
              IS NULL

          AND jobs.source_request_selection_id
              IS NULL

          AND jobs.source_request_relationship_id
              IS NULL

          AND jobs.source_emergency_request_id
              IS NULL

          AND jobs.originating_business_document_id
              IS NULL

          AND jobs.source_business_customer_job_id =
              NEW.business_customer_job_source_id
        )

        OR

        (
          NEW.source_context_type =
            'emergency_request'

          AND NEW.job_source_type =
              'emergency_request'

          AND NEW.job_request_id
              IS NULL

          AND NEW.business_customer_job_source_id
              IS NULL

          AND NEW.emergency_request_id
              IS NOT NULL

          AND NEW.relationship_id
              IS NOT NULL

          AND aggregates.ordinary_request_id
              IS NULL

          AND aggregates.emergency_request_id =
              NEW.emergency_request_id

          AND aggregates.relationship_id =
              NEW.relationship_id

          AND aggregates.business_document_id
              IS NULL

          AND aggregates.business_customer_job_source_id
              IS NULL

          AND jobs.job_request_id
              IS NULL

          AND jobs.source_request_selection_id
              IS NULL

          AND jobs.source_request_relationship_id =
              NEW.relationship_id

          AND jobs.source_emergency_request_id =
              NEW.emergency_request_id

          AND jobs.originating_business_document_id
              IS NULL

          AND jobs.source_business_customer_job_id
              IS NULL
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


-- ============================================================================
-- CANONICAL QUOTE — EXACT EMERGENCY JOB SOURCE
-- ============================================================================

ALTER TABLE canonical_quotes
  ADD COLUMN IF NOT EXISTS
    emergency_request_id INTEGER;


DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname =
      'canonical_quote_emergency_request_fkey'
      AND conrelid =
        'canonical_quotes'::regclass
  ) THEN
    ALTER TABLE canonical_quotes
      ADD CONSTRAINT
        canonical_quote_emergency_request_fkey

      FOREIGN KEY (
        emergency_request_id
      )

      REFERENCES emergency_requests(id)

      ON DELETE RESTRICT;
  END IF;
END;
$migration$;


ALTER TABLE canonical_quotes
  DROP CONSTRAINT IF EXISTS
    canonical_quote_source_shape_check;

ALTER TABLE canonical_quotes
  ADD CONSTRAINT
    canonical_quote_source_shape_check
  CHECK (
    (
      source_context_type =
        'ordinary_request'

      AND job_source_type IN (
        'ordinary_request_selection',
        'existing_customer_request'
      )

      AND job_request_id IS NOT NULL
      AND relationship_id IS NOT NULL
      AND business_customer_job_source_id IS NULL
      AND emergency_request_id IS NULL
    )

    OR

    (
      source_context_type =
        'business_customer'

      AND job_source_type =
        'business_customer'

      AND job_request_id IS NULL
      AND relationship_id IS NULL
      AND business_customer_job_source_id IS NOT NULL
      AND emergency_request_id IS NULL
    )

    OR

    (
      source_context_type =
        'business_document'

      AND job_source_type =
        'business_document'

      AND job_request_id IS NULL
      AND relationship_id IS NULL
      AND business_customer_job_source_id IS NULL
      AND emergency_request_id IS NULL
    )

    OR

    (
      source_context_type =
        'emergency_request'

      AND job_source_type =
        'emergency_request'

      AND job_request_id IS NULL
      AND relationship_id IS NOT NULL
      AND business_customer_job_source_id IS NULL
      AND emergency_request_id IS NOT NULL
    )
  );


DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname =
      'canonical_quote_emergency_job_source_fkey'
      AND conrelid =
        'canonical_quotes'::regclass
  ) THEN
    ALTER TABLE canonical_quotes
      ADD CONSTRAINT
        canonical_quote_emergency_job_source_fkey

      FOREIGN KEY (
        job_id,
        job_source_type,
        emergency_request_id
      )

      REFERENCES jobs(
        id,
        source_type,
        source_emergency_request_id
      )

      ON DELETE RESTRICT;
  END IF;
END;
$migration$;


DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname =
      'canonical_quote_emergency_aggregate_source_fkey'
      AND conrelid =
        'canonical_quotes'::regclass
  ) THEN
    ALTER TABLE canonical_quotes
      ADD CONSTRAINT
        canonical_quote_emergency_aggregate_source_fkey

      FOREIGN KEY (
        id,
        source_context_type,
        emergency_request_id,
        relationship_id
      )

      REFERENCES commercial_authority_aggregates(
        id,
        source_context_type,
        emergency_request_id,
        relationship_id
      )

      ON DELETE RESTRICT;
  END IF;
END;
$migration$;


CREATE UNIQUE INDEX IF NOT EXISTS
  canonical_quote_emergency_source_uidx
ON canonical_quotes(
  id,
  job_id,
  emergency_request_id,
  relationship_id
)
WHERE
  source_context_type =
    'emergency_request'
  AND job_source_type =
    'emergency_request';


CREATE INDEX IF NOT EXISTS
  canonical_quote_emergency_job_idx
ON canonical_quotes(
  job_id,
  created_at ASC,
  id ASC
)
WHERE
  source_context_type =
    'emergency_request'
  AND job_source_type =
    'emergency_request';


-- Emergency Quote source identity becomes immutable immediately after creation.
CREATE OR REPLACE FUNCTION
prevent_canonical_quote_emergency_source_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF
    NEW.emergency_request_id
      IS DISTINCT FROM
    OLD.emergency_request_id
  THEN
    RAISE EXCEPTION
      'canonical Quote Emergency source is immutable'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;


DROP TRIGGER IF EXISTS
  canonical_quote_emergency_source_immutable
ON canonical_quotes;

CREATE TRIGGER
  canonical_quote_emergency_source_immutable
BEFORE UPDATE
ON canonical_quotes
FOR EACH ROW
EXECUTE FUNCTION
  prevent_canonical_quote_emergency_source_mutation();


COMMENT ON COLUMN
  canonical_evaluation_job_subjects.emergency_request_id
IS
  'Exact Emergency Request identity for a Job-bound Emergency Evaluation. NULL for every non-Emergency Evaluation Job origin.';


COMMENT ON COLUMN
  canonical_quotes.emergency_request_id
IS
  'Exact Emergency Request identity for a canonical Quote whose Job origin is emergency_request. NULL for all other Quote origins.';


-- No Evaluation, Quote, Job, approval, Deposit, payment, Work,
-- Invoice, completion, or historical business row is created or modified.
