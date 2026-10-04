-- ============================================================================
-- Four-origin canonical Invoice authority.
--
-- Authenticated Meetro customer Jobs:
--
--   ordinary_request_selection + MEETRO_CUSTOMER
--   existing_customer_request   + MEETRO_CUSTOMER
--
-- Business-owned external Jobs:
--
--   business_document + EXTERNAL_EVIDENCE
--   business_customer + EXTERNAL_EVIDENCE
--
-- This migration generalizes only existing Invoice origin guards.
--
-- It does NOT:
--   * modify historical migrations;
--   * create Jobs, Quotes, approvals, Invoices, payments, or customer parties;
--   * fabricate a Request, Request Selection, Request Relationship,
--     Conversation, homeowner, or customer participant;
--   * change Quick Quote source identity;
--   * change Invoice arithmetic or payment arithmetic;
--   * change canonical Invoice append-only behavior.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- Canonical Invoice -> exact Job-origin binding.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION
assert_canonical_invoice_job_origin()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  job jobs%ROWTYPE;
BEGIN
  SELECT *
  INTO job
  FROM jobs
  WHERE id = NEW.job_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Invoice Job unavailable';
  END IF;


  -- Marketplace and Repeat Meetro remain Request Relationship backed.
  IF job.source_type IN (
    'ordinary_request_selection',
    'existing_customer_request'
  ) THEN

    IF NEW.job_request_id
         IS DISTINCT FROM job.job_request_id

       OR NEW.relationship_id
         IS DISTINCT FROM
            job.source_request_relationship_id

       OR job.job_request_id IS NULL

       OR job.source_request_relationship_id IS NULL
    THEN
      RAISE EXCEPTION
        'Invoice Meetro customer authority mismatch';
    END IF;

    IF job.source_type =
         'existing_customer_request'

       AND (
         job.source_request_selection_id IS NOT NULL

         OR job.originating_business_document_id IS NOT NULL
       )
    THEN
      RAISE EXCEPTION
        'Repeat Meetro Invoice origin mismatch';
    END IF;


  -- Quick Quote remains business_document.
  ELSIF job.source_type =
          'business_document' THEN

    IF NEW.job_request_id IS NOT NULL

       OR NEW.relationship_id IS NOT NULL

       OR job.job_request_id IS NOT NULL

       OR job.source_request_relationship_id IS NOT NULL

       OR job.originating_business_document_id IS NULL

       OR job.business_contact_id IS NULL

       OR job.business_customer_relationship_id IS NULL
    THEN
      RAISE EXCEPTION
        'Invoice business-document authority mismatch';
    END IF;


  -- Full external-customer Job.
  ELSIF job.source_type =
          'business_customer' THEN

    IF NEW.job_request_id IS NOT NULL

       OR NEW.relationship_id IS NOT NULL

       OR job.job_request_id IS NOT NULL

       OR job.source_request_selection_id IS NOT NULL

       OR job.source_request_relationship_id IS NOT NULL

       OR job.originating_business_document_id IS NOT NULL

       OR job.business_contact_id IS NULL

       OR job.business_customer_relationship_id IS NULL

       OR job.source_business_customer_job_id IS NULL
    THEN
      RAISE EXCEPTION
        'Invoice business-customer authority mismatch';
    END IF;


  ELSE
    RAISE EXCEPTION
      'Unsupported Invoice Job origin';
  END IF;

  RETURN NEW;
END;
$$;


-- ---------------------------------------------------------------------------
-- External Invoice issuance is valid for both business-owned Job origins.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION
assert_external_invoice_issuance_origin()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.delivery_channel =
       'EXTERNAL'

     AND NOT EXISTS (
       SELECT 1

       FROM jobs

       WHERE jobs.id =
             NEW.job_id

         AND jobs.business_contact_id
             IS NOT NULL

         AND jobs.business_customer_relationship_id
             IS NOT NULL

         AND (
           (
             jobs.source_type =
               'business_document'

             AND jobs.job_request_id IS NULL

             AND jobs.source_request_relationship_id
                 IS NULL

             AND jobs.originating_business_document_id
                 IS NOT NULL
           )

           OR

           (
             jobs.source_type =
               'business_customer'

             AND jobs.job_request_id IS NULL

             AND jobs.source_request_selection_id
                 IS NULL

             AND jobs.source_request_relationship_id
                 IS NULL

             AND jobs.originating_business_document_id
                 IS NULL

             AND jobs.source_business_customer_job_id
                 IS NOT NULL
           )
         )
     )
  THEN
    RAISE EXCEPTION
      'External Invoice issuance requires an exact business-owned Job';
  END IF;

  RETURN NEW;
END;
$$;


-- ---------------------------------------------------------------------------
-- Every approved-Quote Invoice line must bind to the correct common approval
-- source for its Job origin.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION
assert_business_invoice_line_approval()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_source_type TEXT;
  v_expected_approval_source TEXT;
BEGIN
  IF NEW.source_type <>
       'APPROVED_QUOTE_SCOPE' THEN
    RETURN NEW;
  END IF;


  SELECT jobs.source_type
  INTO v_source_type
  FROM jobs
  WHERE jobs.id =
        NEW.job_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Invoice line Job unavailable';
  END IF;


  IF v_source_type IN (
    'ordinary_request_selection',
    'existing_customer_request'
  ) THEN
    v_expected_approval_source :=
      'MEETRO_CUSTOMER';

  ELSIF v_source_type IN (
    'business_document',
    'business_customer'
  ) THEN
    v_expected_approval_source :=
      'EXTERNAL_EVIDENCE';

  ELSE
    RAISE EXCEPTION
      'Unsupported Invoice line Job origin';
  END IF;


  IF NEW.source_quote_approval_id IS NULL

     OR NOT EXISTS (
       SELECT 1

       FROM canonical_quote_approvals approvals

       WHERE approvals.id =
             NEW.source_quote_approval_id

         AND approvals.job_id =
             NEW.job_id

         AND approvals.quote_id =
             NEW.source_quote_id

         AND approvals.issued_quote_version =
             NEW.source_quote_version

         AND approvals.decision =
             'APPROVED'

         AND approvals.approval_source =
             v_expected_approval_source
     )
  THEN
    RAISE EXCEPTION
      'Invoice scope requires exact approved Quote evidence';
  END IF;

  RETURN NEW;
END;
$$;


-- No lifecycle business rows are inserted, updated, or deleted.
