-- ============================================================================
-- Four-path pre-work deposit/payment Job-origin authority.
--
-- Relationship-backed Meetro Jobs:
--
--   ordinary_request_selection + MEETRO_CUSTOMER
--   existing_customer_request   + MEETRO_CUSTOMER
--
-- Relationship-neutral business-owned Jobs:
--
--   business_document + EXTERNAL_EVIDENCE
--   business_customer + EXTERNAL_EVIDENCE
--
-- This migration changes Job-origin validation only.
--
-- It does NOT:
--   * create Quote approvals;
--   * create deposit obligations;
--   * create payment receipts;
--   * change deposit arithmetic;
--   * change payment allocation arithmetic;
--   * change the SATISFIED scheduling gate;
--   * fabricate Request Relationships for business-owned Jobs;
--   * fabricate Meetro customer decisions for external customers.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- Deposit-obligation Job-origin guard.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION
assert_pre_work_deposit_obligation_job_origin()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_source_type TEXT;
  v_job_request_id INTEGER;
  v_relationship_id INTEGER;
  v_originating_business_document_id UUID;
  v_business_contact_id UUID;
  v_business_customer_relationship_id UUID;
  v_business_customer_job_source_id UUID;
BEGIN
  SELECT
    jobs.source_type,
    jobs.job_request_id,
    jobs.source_request_relationship_id,
    jobs.originating_business_document_id,
    jobs.business_contact_id,
    jobs.business_customer_relationship_id,
    jobs.source_business_customer_job_id
  INTO
    v_source_type,
    v_job_request_id,
    v_relationship_id,
    v_originating_business_document_id,
    v_business_contact_id,
    v_business_customer_relationship_id,
    v_business_customer_job_source_id
  FROM jobs
  WHERE jobs.id = NEW.job_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Pre-work deposit obligation Job is unavailable.';
  END IF;


  -- Authenticated Meetro customer approval.
  IF v_source_type IN (
    'ordinary_request_selection',
    'existing_customer_request'
  ) THEN
    IF NEW.approval_source
         IS DISTINCT FROM 'MEETRO_CUSTOMER'

       OR NEW.job_request_id
         IS DISTINCT FROM v_job_request_id

       OR NEW.relationship_id
         IS DISTINCT FROM v_relationship_id

       OR v_job_request_id IS NULL

       OR v_relationship_id IS NULL
    THEN
      RAISE EXCEPTION
        'Meetro-customer deposit obligation source does not match its Job.';
    END IF;


  -- Quick Quote / business-document external approval.
  ELSIF v_source_type = 'business_document' THEN
    IF NEW.approval_source
         IS DISTINCT FROM 'EXTERNAL_EVIDENCE'

       OR NEW.job_request_id IS NOT NULL

       OR NEW.relationship_id IS NOT NULL

       OR v_job_request_id IS NOT NULL

       OR v_relationship_id IS NOT NULL

       OR v_originating_business_document_id IS NULL
    THEN
      RAISE EXCEPTION
        'Business-document deposit obligation does not match its Job.';
    END IF;


  -- Full external-customer Job approval.
  ELSIF v_source_type = 'business_customer' THEN
    IF NEW.approval_source
         IS DISTINCT FROM 'EXTERNAL_EVIDENCE'

       OR NEW.job_request_id IS NOT NULL

       OR NEW.relationship_id IS NOT NULL

       OR v_job_request_id IS NOT NULL

       OR v_relationship_id IS NOT NULL

       OR v_originating_business_document_id IS NOT NULL

       OR v_business_contact_id IS NULL

       OR v_business_customer_relationship_id IS NULL

       OR v_business_customer_job_source_id IS NULL
    THEN
      RAISE EXCEPTION
        'Business-customer deposit obligation does not match its Job.';
    END IF;


  ELSE
    RAISE EXCEPTION
      'Unsupported pre-work deposit Job source type.';
  END IF;

  RETURN NEW;
END;
$$;


-- ---------------------------------------------------------------------------
-- Deposit/payment ledger Job-origin guard.
--
-- Request-backed Meetro Jobs retain their exact Request Relationship.
-- Both business-owned external paths remain relationship-neutral.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION
assert_pre_work_payment_relationship_job_origin()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_source_type TEXT;
  v_job_request_id INTEGER;
  v_relationship_id INTEGER;
  v_originating_business_document_id UUID;
  v_business_contact_id UUID;
  v_business_customer_relationship_id UUID;
  v_business_customer_job_source_id UUID;
BEGIN
  SELECT
    jobs.source_type,
    jobs.job_request_id,
    jobs.source_request_relationship_id,
    jobs.originating_business_document_id,
    jobs.business_contact_id,
    jobs.business_customer_relationship_id,
    jobs.source_business_customer_job_id
  INTO
    v_source_type,
    v_job_request_id,
    v_relationship_id,
    v_originating_business_document_id,
    v_business_contact_id,
    v_business_customer_relationship_id,
    v_business_customer_job_source_id
  FROM jobs
  WHERE jobs.id = NEW.job_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Pre-work payment Job is unavailable.';
  END IF;


  IF v_source_type IN (
    'ordinary_request_selection',
    'existing_customer_request'
  ) THEN
    IF NEW.relationship_id IS NULL

       OR NEW.relationship_id
         IS DISTINCT FROM v_relationship_id

       OR v_job_request_id IS NULL

       OR v_relationship_id IS NULL
    THEN
      RAISE EXCEPTION
        'Meetro-customer pre-work payment relationship does not match its Job.';
    END IF;


  ELSIF v_source_type = 'business_document' THEN
    IF NEW.relationship_id IS NOT NULL

       OR v_job_request_id IS NOT NULL

       OR v_relationship_id IS NOT NULL

       OR v_originating_business_document_id IS NULL
    THEN
      RAISE EXCEPTION
        'Business-document pre-work payment evidence does not match its Job.';
    END IF;


  ELSIF v_source_type = 'business_customer' THEN
    IF NEW.relationship_id IS NOT NULL

       OR v_job_request_id IS NOT NULL

       OR v_relationship_id IS NOT NULL

       OR v_originating_business_document_id IS NOT NULL

       OR v_business_contact_id IS NULL

       OR v_business_customer_relationship_id IS NULL

       OR v_business_customer_job_source_id IS NULL
    THEN
      RAISE EXCEPTION
        'Business-customer pre-work payment evidence does not match its Job.';
    END IF;


  ELSE
    RAISE EXCEPTION
      'Unsupported pre-work payment Job source type.';
  END IF;

  RETURN NEW;
END;
$$;


-- ---------------------------------------------------------------------------
-- Historical provenance verification.
--
-- Existing rows are append-only. This validation writes nothing.
-- ---------------------------------------------------------------------------

DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM canonical_pre_work_deposit_obligations obligations
    INNER JOIN jobs
      ON jobs.id = obligations.job_id
    WHERE
      jobs.source_type NOT IN (
        'ordinary_request_selection',
        'existing_customer_request',
        'business_document',
        'business_customer'
      )

      OR

      (
        jobs.source_type IN (
          'ordinary_request_selection',
          'existing_customer_request'
        )
        AND (
          COALESCE(
            obligations.approval_source,
            'MEETRO_CUSTOMER'
          ) <> 'MEETRO_CUSTOMER'

          OR obligations.job_request_id
             IS DISTINCT FROM jobs.job_request_id

          OR obligations.relationship_id
             IS DISTINCT FROM
                jobs.source_request_relationship_id

          OR jobs.job_request_id IS NULL

          OR jobs.source_request_relationship_id IS NULL
        )
      )

      OR

      (
        jobs.source_type = 'business_document'
        AND (
          obligations.approval_source
            <> 'EXTERNAL_EVIDENCE'

          OR obligations.job_request_id IS NOT NULL

          OR obligations.relationship_id IS NOT NULL

          OR jobs.job_request_id IS NOT NULL

          OR jobs.source_request_relationship_id IS NOT NULL

          OR jobs.originating_business_document_id IS NULL
        )
      )

      OR

      (
        jobs.source_type = 'business_customer'
        AND (
          obligations.approval_source
            <> 'EXTERNAL_EVIDENCE'

          OR obligations.job_request_id IS NOT NULL

          OR obligations.relationship_id IS NOT NULL

          OR jobs.job_request_id IS NOT NULL

          OR jobs.source_request_relationship_id IS NOT NULL

          OR jobs.originating_business_document_id IS NOT NULL

          OR jobs.business_contact_id IS NULL

          OR jobs.business_customer_relationship_id IS NULL

          OR jobs.source_business_customer_job_id IS NULL
        )
      )
  ) THEN
    RAISE EXCEPTION
      'Historical deposit obligation Job-origin provenance is invalid.';
  END IF;


  IF EXISTS (
    SELECT 1
    FROM canonical_pre_work_deposit_versions records
    INNER JOIN jobs
      ON jobs.id = records.job_id
    WHERE
      jobs.source_type NOT IN (
        'ordinary_request_selection',
        'existing_customer_request',
        'business_document',
        'business_customer'
      )

      OR

      (
        jobs.source_type IN (
          'ordinary_request_selection',
          'existing_customer_request'
        )
        AND (
          records.relationship_id
            IS DISTINCT FROM
              jobs.source_request_relationship_id

          OR jobs.source_request_relationship_id IS NULL
        )
      )

      OR

      (
        jobs.source_type IN (
          'business_document',
          'business_customer'
        )
        AND records.relationship_id IS NOT NULL
      )
  ) THEN
    RAISE EXCEPTION
      'Historical deposit version Job-origin provenance is invalid.';
  END IF;


  IF EXISTS (
    SELECT 1
    FROM canonical_pre_work_payment_receipts records
    INNER JOIN jobs
      ON jobs.id = records.job_id
    WHERE
      jobs.source_type NOT IN (
        'ordinary_request_selection',
        'existing_customer_request',
        'business_document',
        'business_customer'
      )

      OR

      (
        jobs.source_type IN (
          'ordinary_request_selection',
          'existing_customer_request'
        )
        AND (
          records.relationship_id
            IS DISTINCT FROM
              jobs.source_request_relationship_id

          OR jobs.source_request_relationship_id IS NULL
        )
      )

      OR

      (
        jobs.source_type IN (
          'business_document',
          'business_customer'
        )
        AND records.relationship_id IS NOT NULL
      )
  ) THEN
    RAISE EXCEPTION
      'Historical payment receipt Job-origin provenance is invalid.';
  END IF;


  IF EXISTS (
    SELECT 1
    FROM canonical_pre_work_payment_allocations records
    INNER JOIN jobs
      ON jobs.id = records.job_id
    WHERE
      jobs.source_type NOT IN (
        'ordinary_request_selection',
        'existing_customer_request',
        'business_document',
        'business_customer'
      )

      OR

      (
        jobs.source_type IN (
          'ordinary_request_selection',
          'existing_customer_request'
        )
        AND (
          records.relationship_id
            IS DISTINCT FROM
              jobs.source_request_relationship_id

          OR jobs.source_request_relationship_id IS NULL
        )
      )

      OR

      (
        jobs.source_type IN (
          'business_document',
          'business_customer'
        )
        AND records.relationship_id IS NOT NULL
      )
  ) THEN
    RAISE EXCEPTION
      'Historical payment allocation Job-origin provenance is invalid.';
  END IF;


  IF EXISTS (
    SELECT 1
    FROM canonical_pre_work_payment_allocation_reversals records
    INNER JOIN jobs
      ON jobs.id = records.job_id
    WHERE
      jobs.source_type NOT IN (
        'ordinary_request_selection',
        'existing_customer_request',
        'business_document',
        'business_customer'
      )

      OR

      (
        jobs.source_type IN (
          'ordinary_request_selection',
          'existing_customer_request'
        )
        AND (
          records.relationship_id
            IS DISTINCT FROM
              jobs.source_request_relationship_id

          OR jobs.source_request_relationship_id IS NULL
        )
      )

      OR

      (
        jobs.source_type IN (
          'business_document',
          'business_customer'
        )
        AND records.relationship_id IS NOT NULL
      )
  ) THEN
    RAISE EXCEPTION
      'Historical payment reversal Job-origin provenance is invalid.';
  END IF;
END;
$migration$;


COMMENT ON COLUMN
canonical_pre_work_deposit_obligations.relationship_id IS
  'Exact Request Relationship for ordinary_request_selection and existing_customer_request Jobs; NULL for business_document and business_customer Jobs.';


COMMENT ON COLUMN
canonical_pre_work_payment_receipts.relationship_id IS
  'Exact Request Relationship for ordinary_request_selection and existing_customer_request Jobs; NULL for business_document and business_customer Jobs.';


COMMENT ON COLUMN
canonical_pre_work_payment_allocations.relationship_id IS
  'Exact Request Relationship for ordinary_request_selection and existing_customer_request Jobs; NULL for business_document and business_customer Jobs.';


COMMENT ON COLUMN
canonical_pre_work_payment_allocation_reversals.relationship_id IS
  'Exact Request Relationship for ordinary_request_selection and existing_customer_request Jobs; NULL for business_document and business_customer Jobs.';
