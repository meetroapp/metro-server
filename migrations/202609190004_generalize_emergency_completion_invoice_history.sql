-- Generation 104. No new tables or historical business-row writes.
-- Zero Workstreams are an exact Emergency origin shape, not a generic exemption.
ALTER TABLE canonical_job_completion_records
  DROP CONSTRAINT canonical_job_completion_records_workstream_count_check;
ALTER TABLE canonical_job_completion_records
  ADD CONSTRAINT canonical_job_completion_records_workstream_count_check
  CHECK (workstream_count >= 0);

CREATE OR REPLACE FUNCTION assert_canonical_job_completion_origin()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_source_type TEXT;
BEGIN
  SELECT source_type INTO v_source_type FROM jobs WHERE id = NEW.job_id;
  IF v_source_type = 'emergency_request' THEN
    IF NEW.workstream_count <> 0 OR NOT EXISTS (
      SELECT 1 FROM jobs emergency_job
      JOIN emergency_requests emergency ON emergency.id = emergency_job.source_emergency_request_id
      JOIN request_relationships relationship
        ON relationship.id = emergency_job.source_request_relationship_id
       AND relationship.emergency_request_id = emergency.id
       AND relationship.post_id IS NULL
       AND relationship.homeowner_id = emergency.homeowner_id
      JOIN contractor_profiles profile ON profile.id = relationship.contractor_id
       AND profile.user_id = relationship.professional_user_id
      JOIN relationship_participants professional ON professional.job_id = emergency_job.id
       AND professional.request_relationship_id = relationship.id
       AND professional.user_id = relationship.professional_user_id
       AND professional.source_evidence_type = 'emergency_selection'
      JOIN relationship_participants customer ON customer.job_id = emergency_job.id
       AND customer.request_relationship_id = relationship.id
       AND customer.user_id = relationship.homeowner_id
       AND customer.source_evidence_type = 'emergency_selection'
      WHERE emergency_job.id = NEW.job_id
        AND emergency_job.source_type = 'emergency_request'
        AND emergency_job.lifecycle_contract_version = 2
        AND emergency_job.created_by_user_id = emergency.homeowner_id
        AND emergency_job.job_request_id IS NULL
        AND emergency_job.source_request_selection_id IS NULL
        AND emergency_job.source_emergency_request_id IS NOT NULL
        AND emergency_job.source_request_relationship_id IS NOT NULL
        AND emergency_job.contractor_profile_id IS NULL
        AND emergency_job.originating_business_document_id IS NULL
        AND emergency_job.business_contact_id IS NULL
        AND emergency_job.business_customer_relationship_id IS NULL
        AND emergency_job.source_business_customer_job_id IS NULL
        AND professional.id = NEW.completed_by_participant_id
    ) THEN
      RAISE EXCEPTION 'Emergency completion origin mismatch';
    END IF;
  ELSIF v_source_type IN ('ordinary_request_selection', 'existing_customer_request', 'business_document', 'business_customer') THEN
    IF NEW.workstream_count <= 0 THEN
      RAISE EXCEPTION 'Non-Emergency completion requires approved Workstreams';
    END IF;
  ELSE
    RAISE EXCEPTION 'Unsupported Job completion origin';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS canonical_job_completion_origin_guard ON canonical_job_completion_records;
CREATE TRIGGER canonical_job_completion_origin_guard
BEFORE INSERT OR UPDATE ON canonical_job_completion_records
FOR EACH ROW EXECUTE FUNCTION assert_canonical_job_completion_origin();

-- Historical validation is read-only and fails the migration atomically.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM canonical_job_completion_records records
    LEFT JOIN jobs ON jobs.id = records.job_id
    WHERE jobs.id IS NULL
      OR jobs.source_type NOT IN ('ordinary_request_selection', 'existing_customer_request', 'business_document', 'business_customer', 'emergency_request')
      OR (jobs.source_type <> 'emergency_request' AND records.workstream_count <= 0)
      OR (jobs.source_type = 'emergency_request' AND (records.workstream_count <> 0 OR NOT EXISTS (
        SELECT 1 FROM jobs emergency_job
      JOIN emergency_requests emergency ON emergency.id = emergency_job.source_emergency_request_id
      JOIN request_relationships relationship
        ON relationship.id = emergency_job.source_request_relationship_id
       AND relationship.emergency_request_id = emergency.id
       AND relationship.post_id IS NULL
       AND relationship.homeowner_id = emergency.homeowner_id
      JOIN contractor_profiles profile ON profile.id = relationship.contractor_id
       AND profile.user_id = relationship.professional_user_id
      JOIN relationship_participants professional ON professional.job_id = emergency_job.id
       AND professional.request_relationship_id = relationship.id
       AND professional.user_id = relationship.professional_user_id
       AND professional.source_evidence_type = 'emergency_selection'
      JOIN relationship_participants customer ON customer.job_id = emergency_job.id
       AND customer.request_relationship_id = relationship.id
       AND customer.user_id = relationship.homeowner_id
       AND customer.source_evidence_type = 'emergency_selection'
      WHERE emergency_job.id = records.job_id
        AND emergency_job.source_type = 'emergency_request'
        AND emergency_job.lifecycle_contract_version = 2
        AND emergency_job.created_by_user_id = emergency.homeowner_id
        AND emergency_job.job_request_id IS NULL
        AND emergency_job.source_request_selection_id IS NULL
        AND emergency_job.source_emergency_request_id IS NOT NULL
        AND emergency_job.source_request_relationship_id IS NOT NULL
        AND emergency_job.contractor_profile_id IS NULL
        AND emergency_job.originating_business_document_id IS NULL
        AND emergency_job.business_contact_id IS NULL
        AND emergency_job.business_customer_relationship_id IS NULL
        AND emergency_job.source_business_customer_job_id IS NULL
          AND professional.id = records.completed_by_participant_id
      )))
  ) THEN
    RAISE EXCEPTION 'Historical canonical Job completion origin mismatch';
  END IF;
END;
$$;

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


  ELSIF job.source_type = 'emergency_request' THEN
    IF NEW.job_request_id IS NOT NULL
       OR NEW.relationship_id IS NULL
       OR NEW.relationship_id IS DISTINCT FROM job.source_request_relationship_id
       OR NOT EXISTS (
         SELECT 1 FROM jobs emergency_job
      JOIN emergency_requests emergency ON emergency.id = emergency_job.source_emergency_request_id
      JOIN request_relationships relationship
        ON relationship.id = emergency_job.source_request_relationship_id
       AND relationship.emergency_request_id = emergency.id
       AND relationship.post_id IS NULL
       AND relationship.homeowner_id = emergency.homeowner_id
      JOIN contractor_profiles profile ON profile.id = relationship.contractor_id
       AND profile.user_id = relationship.professional_user_id
      JOIN relationship_participants professional ON professional.job_id = emergency_job.id
       AND professional.request_relationship_id = relationship.id
       AND professional.user_id = relationship.professional_user_id
       AND professional.source_evidence_type = 'emergency_selection'
      JOIN relationship_participants customer ON customer.job_id = emergency_job.id
       AND customer.request_relationship_id = relationship.id
       AND customer.user_id = relationship.homeowner_id
       AND customer.source_evidence_type = 'emergency_selection'
      WHERE emergency_job.id = NEW.job_id
        AND emergency_job.source_type = 'emergency_request'
        AND emergency_job.lifecycle_contract_version = 2
        AND emergency_job.created_by_user_id = emergency.homeowner_id
        AND emergency_job.job_request_id IS NULL
        AND emergency_job.source_request_selection_id IS NULL
        AND emergency_job.source_emergency_request_id IS NOT NULL
        AND emergency_job.source_request_relationship_id IS NOT NULL
        AND emergency_job.contractor_profile_id IS NULL
        AND emergency_job.originating_business_document_id IS NULL
        AND emergency_job.business_contact_id IS NULL
        AND emergency_job.business_customer_relationship_id IS NULL
        AND emergency_job.source_business_customer_job_id IS NULL
           AND professional.id = NEW.issuer_participant_id
       ) THEN
      RAISE EXCEPTION 'Emergency Invoice origin mismatch';
    END IF;

  ELSE
    RAISE EXCEPTION
      'Unsupported Invoice Job origin';
  END IF;

  RETURN NEW;
END;
$$;


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
    'existing_customer_request',
    'emergency_request'
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

-- assert_external_invoice_issuance_origin() is intentionally unchanged:
-- only business_document and business_customer may issue EXTERNAL invoices.
