-- MEETRO EXISTING CUSTOMER REQUEST JOB FOUNDATION
--
-- Adds a third governed lifecycle Job source for fresh work requested by an
-- authenticated homeowner from a professional with whom the homeowner has
-- immutable prior Meetro relationship provenance.
--
-- This source uses:
--   fresh Job Request
--   fresh active Request Relationship
--   fresh Conversation
--
-- It does NOT fabricate:
--   Professional Response
--   Request Selection
--   Business Contact
--   business-owned Customer Relationship
--   Business Document
--
-- Downstream Evaluation / Quote / Deposit / Schedule / Work / Invoice
-- generalization is intentionally outside this migration.


-- -------------------------------------------------------------------------
-- Job source type.
-- -------------------------------------------------------------------------

ALTER TABLE jobs
  DROP CONSTRAINT IF EXISTS jobs_source_type_check;

ALTER TABLE jobs
  ADD CONSTRAINT jobs_source_type_check
  CHECK (
    source_type IN (
      'ordinary_request_selection',
      'existing_customer_request',
      'business_document'
    )
  );

ALTER TABLE jobs
  DROP CONSTRAINT IF EXISTS jobs_source_shape_check;

ALTER TABLE jobs
  ADD CONSTRAINT jobs_source_shape_check
  CHECK (
    (
      source_type = 'ordinary_request_selection'
      AND job_request_id IS NOT NULL
      AND source_request_selection_id IS NOT NULL
      AND source_request_relationship_id IS NOT NULL
      AND contractor_profile_id IS NULL
      AND business_contact_id IS NULL
      AND business_customer_relationship_id IS NULL
      AND originating_business_document_id IS NULL
    )
    OR
    (
      source_type = 'existing_customer_request'
      AND job_request_id IS NOT NULL
      AND source_request_selection_id IS NULL
      AND source_request_relationship_id IS NOT NULL
      AND contractor_profile_id IS NULL
      AND business_contact_id IS NULL
      AND business_customer_relationship_id IS NULL
      AND originating_business_document_id IS NULL
    )
    OR
    (
      source_type = 'business_document'
      AND job_request_id IS NULL
      AND source_request_selection_id IS NULL
      AND source_request_relationship_id IS NULL
      AND contractor_profile_id IS NOT NULL
      AND originating_business_document_id IS NOT NULL
      AND (
        (
          business_contact_id IS NULL
          AND business_customer_relationship_id IS NULL
        )
        OR
        (
          business_contact_id IS NOT NULL
          AND business_customer_relationship_id IS NOT NULL
        )
      )
    )
  );


-- -------------------------------------------------------------------------
-- Database proof for the direct Meetro-customer Job.
--
-- The old Worked With relationship is NOT the Job source.
-- It already governs the fresh request/relationship provenance upstream.
-- This Job is bound to the NEW request and NEW Request Relationship.
-- -------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION
assert_existing_customer_request_job_source()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.source_type IS DISTINCT FROM
     'existing_customer_request' THEN
    RETURN NEW;
  END IF;

  IF NEW.lifecycle_contract_version <> 2
     OR NEW.job_request_id IS NULL
     OR NEW.source_request_selection_id IS NOT NULL
     OR NEW.source_request_relationship_id IS NULL
     OR NEW.contractor_profile_id IS NOT NULL
     OR NEW.business_contact_id IS NOT NULL
     OR NEW.business_customer_relationship_id IS NOT NULL
     OR NEW.originating_business_document_id IS NOT NULL THEN
    RAISE EXCEPTION
      'Existing Customer Job source shape is invalid.'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM posts
    INNER JOIN request_relationships relationships
      ON relationships.id =
           NEW.source_request_relationship_id
     AND relationships.post_id =
           posts.id
    WHERE posts.id = NEW.job_request_id
      AND posts.user_id = NEW.created_by_user_id
      AND posts.lifecycle_contract_version = 2
      AND posts.request_origin =
        'existing_customer_request'
      AND relationships.homeowner_id =
        posts.user_id
      AND relationships.contractor_id =
        posts.target_contractor_profile_id
      AND relationships.professional_user_id =
        posts.target_professional_user_id
      AND relationships.status = 'active'
      AND relationships.professional_response_id
        IS NULL
      AND relationships.ordinary_authority_source =
        'existing_customer_request'
      AND relationships.source_meetro_relationship_id =
        posts.source_meetro_relationship_id
  ) THEN
    RAISE EXCEPTION
      'Existing Customer Job does not match its governed request relationship.'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  jobs_existing_customer_request_source_check
ON jobs;

CREATE TRIGGER
  jobs_existing_customer_request_source_check
BEFORE INSERT OR UPDATE OF
  job_request_id,
  source_request_selection_id,
  source_request_relationship_id,
  created_by_user_id,
  lifecycle_contract_version,
  source_type,
  contractor_profile_id,
  business_contact_id,
  business_customer_relationship_id,
  originating_business_document_id
ON jobs
FOR EACH ROW
EXECUTE FUNCTION
  assert_existing_customer_request_job_source();


CREATE INDEX IF NOT EXISTS
  jobs_existing_customer_request_created_idx
ON jobs(
  created_by_user_id,
  created_at DESC,
  id
)
WHERE source_type = 'existing_customer_request';


-- -------------------------------------------------------------------------
-- Authenticated participant evidence.
--
-- Both homeowner and professional are real authenticated participants.
-- Evidence points to THIS fresh existing-customer request relationship.
-- -------------------------------------------------------------------------

ALTER TABLE relationship_participants
  DROP CONSTRAINT IF EXISTS
    relationship_participants_source_evidence_type_check;

ALTER TABLE relationship_participants
  ADD CONSTRAINT
    relationship_participants_source_evidence_type_check
  CHECK (
    source_evidence_type IN (
      'request_selection',
      'existing_customer_request',
      'business_document'
    )
  );

ALTER TABLE relationship_participants
  DROP CONSTRAINT IF EXISTS
    relationship_participants_source_shape_check;

ALTER TABLE relationship_participants
  ADD CONSTRAINT
    relationship_participants_source_shape_check
  CHECK (
    (
      source_evidence_type = 'request_selection'
      AND request_relationship_id IS NOT NULL
    )
    OR
    (
      source_evidence_type =
        'existing_customer_request'
      AND request_relationship_id IS NOT NULL
    )
    OR
    (
      source_evidence_type = 'business_document'
      AND request_relationship_id IS NULL
    )
  );


COMMENT ON COLUMN jobs.source_type IS
  'Lifecycle Job origin: marketplace Request Selection, direct existing Meetro customer request, or business-owned document.';

COMMENT ON COLUMN jobs.contractor_profile_id IS
  'Owning Business only for source_type=business_document; NULL for marketplace and existing_customer_request Jobs.';

COMMENT ON COLUMN jobs.source_request_selection_id IS
  'Canonical Request Selection for ordinary_request_selection Jobs; NULL for existing_customer_request and business_document Jobs.';

COMMENT ON COLUMN jobs.source_request_relationship_id IS
  'Fresh Request Relationship for authenticated Meetro-customer Jobs; NULL for business_document Jobs.';
