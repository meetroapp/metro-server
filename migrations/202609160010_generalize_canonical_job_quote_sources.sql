-- ============================================================================
-- Canonical Job Quote source generalization.
--
-- JOB / LEAD QUOTE SOURCES
--
-- ordinary_request_selection
--   source_context_type = ordinary_request
--
-- existing_customer_request
--   source_context_type = ordinary_request
--   fresh Request + fresh Request Relationship
--   no Request Selection
--
-- business_customer
--   source_context_type = business_customer
--   exact business_customer_job_source_id
--   no Request / Request Relationship / Request Selection
--
-- QUICK QUOTE / QUICK INVOICE
--
-- business_document
--   source_context_type = business_document
--   remains unchanged
--
-- This migration changes Quote source identity only.
-- It does not change Evaluation, approval, deposit, scheduling,
-- Quick Quote customer selection, or document behavior.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- Exact external-customer Job source on canonical Quote.
-- ---------------------------------------------------------------------------

ALTER TABLE canonical_quotes
  ADD COLUMN IF NOT EXISTS
    business_customer_job_source_id UUID;


-- ---------------------------------------------------------------------------
-- Canonical Quote source shape.
-- ---------------------------------------------------------------------------

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

      AND job_request_id
          IS NOT NULL

      AND relationship_id
          IS NOT NULL

      AND business_customer_job_source_id
          IS NULL
    )

    OR

    (
      source_context_type =
        'business_customer'

      AND job_source_type =
        'business_customer'

      AND job_request_id
          IS NULL

      AND relationship_id
          IS NULL

      AND business_customer_job_source_id
          IS NOT NULL
    )

    OR

    (
      source_context_type =
        'business_document'

      AND job_source_type =
        'business_document'

      AND job_request_id
          IS NULL

      AND relationship_id
          IS NULL

      AND business_customer_job_source_id
          IS NULL
    )
  );


-- ---------------------------------------------------------------------------
-- Exact business_customer Job-source proof.
--
-- Migration 008 already provides:
--
-- jobs(
--   id,
--   source_type,
--   source_business_customer_job_id
-- )
--
-- as a unique source identity.
-- ---------------------------------------------------------------------------

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1

    FROM pg_constraint

    WHERE conname =
      'canonical_quote_business_customer_job_source_fkey'

      AND conrelid =
        'canonical_quotes'::regclass
  ) THEN
    ALTER TABLE canonical_quotes
      ADD CONSTRAINT
        canonical_quote_business_customer_job_source_fkey

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
  END IF;
END;
$migration$;


-- ---------------------------------------------------------------------------
-- Exact commercial aggregate source proof.
--
-- Migration 008 already provides:
--
-- commercial_authority_aggregates(
--   id,
--   source_context_type,
--   business_customer_job_source_id
-- )
--
-- as a unique source identity.
-- ---------------------------------------------------------------------------

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1

    FROM pg_constraint

    WHERE conname =
      'canonical_quote_business_customer_aggregate_source_fkey'

      AND conrelid =
        'canonical_quotes'::regclass
  ) THEN
    ALTER TABLE canonical_quotes
      ADD CONSTRAINT
        canonical_quote_business_customer_aggregate_source_fkey

      FOREIGN KEY (
        id,
        source_context_type,
        business_customer_job_source_id
      )

      REFERENCES commercial_authority_aggregates(
        id,
        source_context_type,
        business_customer_job_source_id
      )

      ON DELETE RESTRICT;
  END IF;
END;
$migration$;


-- ---------------------------------------------------------------------------
-- Source lookup indexes.
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS
  canonical_quote_business_customer_source_uidx
ON canonical_quotes(
  id,
  job_id,
  business_customer_job_source_id
)
WHERE
  source_context_type =
    'business_customer'
  AND job_source_type =
    'business_customer';


CREATE INDEX IF NOT EXISTS
  canonical_quote_business_customer_job_idx
ON canonical_quotes(
  job_id,
  created_at ASC,
  id ASC
)
WHERE
  source_context_type =
    'business_customer'
  AND job_source_type =
    'business_customer';


-- ---------------------------------------------------------------------------
-- External Job source identity is immutable.
-- Existing Quote source_context_type/job_source_type immutability stays intact.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION
prevent_canonical_quote_business_customer_source_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF
    NEW.business_customer_job_source_id
      IS DISTINCT FROM
    OLD.business_customer_job_source_id
  THEN
    RAISE EXCEPTION
      'canonical Quote business-customer source is immutable';
  END IF;

  RETURN NEW;
END;
$$;


DROP TRIGGER IF EXISTS
  canonical_quote_business_customer_source_immutable
ON canonical_quotes;


CREATE TRIGGER
  canonical_quote_business_customer_source_immutable
BEFORE UPDATE
ON canonical_quotes
FOR EACH ROW
EXECUTE FUNCTION
  prevent_canonical_quote_business_customer_source_mutation();


COMMENT ON COLUMN
  canonical_quotes.business_customer_job_source_id
IS
  'Exact pre-Quote business-customer Job source for Job Quote source_context_type=business_customer. NULL for marketplace, repeat Meetro, and Quick Quote business_document origins.';


-- No Quote, Evaluation, Job, approval, payment, participant,
-- customer-party, business-document, or lifecycle business row
-- is inserted, updated, or deleted.
