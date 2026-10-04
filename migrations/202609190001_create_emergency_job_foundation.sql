-- MEETRO EMERGENCY CANONICAL JOB FOUNDATION
--
-- Creates the fifth governed full-workflow Job origin:
--
--   emergency_request
--
-- Authority:
--   exact Emergency Request
--   + exact selected ACTIVE Emergency Request Relationship
--   + authenticated homeowner selection authority
--   + authenticated selected professional
--
-- This migration does NOT:
--   create historical Emergency Jobs;
--   create or modify Emergency Requests;
--   create Quotes, approvals, deposits, payments, Visits, Work, Invoices,
--   Completion, or History;
--   fabricate an ordinary Request, Request Selection, Business Contact,
--   or business-owned Customer Relationship.
--
-- The first Emergency Job is created only by the runtime selection
-- transaction after the homeowner selects one professional.


-- -------------------------------------------------------------------------
-- Fifth governed Job source.
-- -------------------------------------------------------------------------

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS
    source_emergency_request_id INTEGER;


DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname =
      'jobs_emergency_request_source_fkey'
      AND conrelid = 'jobs'::regclass
  ) THEN
    ALTER TABLE jobs
      ADD CONSTRAINT
        jobs_emergency_request_source_fkey
      FOREIGN KEY (
        source_emergency_request_id
      )
      REFERENCES emergency_requests(id)
      ON DELETE RESTRICT;
  END IF;
END;
$migration$;


ALTER TABLE jobs
  DROP CONSTRAINT IF EXISTS
    jobs_source_type_check;

ALTER TABLE jobs
  ADD CONSTRAINT
    jobs_source_type_check
  CHECK (
    source_type IN (
      'ordinary_request_selection',
      'existing_customer_request',
      'business_customer',
      'business_document',
      'emergency_request'
    )
  );


ALTER TABLE jobs
  DROP CONSTRAINT IF EXISTS
    jobs_source_shape_check;

ALTER TABLE jobs
  ADD CONSTRAINT
    jobs_source_shape_check
  CHECK (
    (
      source_type =
        'ordinary_request_selection'

      AND job_request_id IS NOT NULL
      AND source_request_selection_id IS NOT NULL
      AND source_request_relationship_id IS NOT NULL

      AND contractor_profile_id IS NULL
      AND business_contact_id IS NULL
      AND business_customer_relationship_id IS NULL
      AND originating_business_document_id IS NULL
      AND source_business_customer_job_id IS NULL
      AND source_emergency_request_id IS NULL
    )

    OR

    (
      source_type =
        'existing_customer_request'

      AND job_request_id IS NOT NULL
      AND source_request_selection_id IS NULL
      AND source_request_relationship_id IS NOT NULL

      AND contractor_profile_id IS NULL
      AND business_contact_id IS NULL
      AND business_customer_relationship_id IS NULL
      AND originating_business_document_id IS NULL
      AND source_business_customer_job_id IS NULL
      AND source_emergency_request_id IS NULL
    )

    OR

    (
      source_type =
        'business_customer'

      AND job_request_id IS NULL
      AND source_request_selection_id IS NULL
      AND source_request_relationship_id IS NULL

      AND contractor_profile_id IS NOT NULL
      AND business_contact_id IS NOT NULL
      AND business_customer_relationship_id IS NOT NULL

      AND originating_business_document_id IS NULL
      AND source_business_customer_job_id IS NOT NULL
      AND source_emergency_request_id IS NULL
    )

    OR

    (
      source_type =
        'business_document'

      AND job_request_id IS NULL
      AND source_request_selection_id IS NULL
      AND source_request_relationship_id IS NULL

      AND contractor_profile_id IS NOT NULL
      AND originating_business_document_id IS NOT NULL
      AND source_business_customer_job_id IS NULL
      AND source_emergency_request_id IS NULL

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

    OR

    (
      source_type =
        'emergency_request'

      AND job_request_id IS NULL
      AND source_request_selection_id IS NULL

      AND source_request_relationship_id IS NOT NULL
      AND source_emergency_request_id IS NOT NULL

      AND contractor_profile_id IS NULL
      AND business_contact_id IS NULL
      AND business_customer_relationship_id IS NULL
      AND originating_business_document_id IS NULL
      AND source_business_customer_job_id IS NULL
    )
  );


-- -------------------------------------------------------------------------
-- Exact source proof.
--
-- The homeowner is the Job source actor because the Job materializes from
-- the homeowner's deliberate professional selection.
--
-- The professional identity comes only from the exact ACTIVE selected
-- Emergency Request Relationship.
-- -------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION
assert_emergency_request_job_source()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.source_type IS DISTINCT FROM
     'emergency_request' THEN
    RETURN NEW;
  END IF;

  IF NEW.lifecycle_contract_version <> 2
     OR NEW.job_request_id IS NOT NULL
     OR NEW.source_request_selection_id IS NOT NULL
     OR NEW.source_request_relationship_id IS NULL
     OR NEW.source_emergency_request_id IS NULL
     OR NEW.contractor_profile_id IS NOT NULL
     OR NEW.business_contact_id IS NOT NULL
     OR NEW.business_customer_relationship_id IS NOT NULL
     OR NEW.originating_business_document_id IS NOT NULL
     OR NEW.source_business_customer_job_id IS NOT NULL
  THEN
    RAISE EXCEPTION
      'Emergency Job source shape is invalid.'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1

    FROM emergency_requests emergency

    INNER JOIN request_relationships relationship
      ON relationship.id =
           NEW.source_request_relationship_id

     AND relationship.emergency_request_id =
           emergency.id

     AND relationship.post_id IS NULL

     AND relationship.homeowner_id =
           emergency.homeowner_id

     AND relationship.status = 'active'

    INNER JOIN contractor_profiles profile
      ON profile.id =
           relationship.contractor_id

     AND profile.user_id =
           relationship.professional_user_id

    WHERE emergency.id =
          NEW.source_emergency_request_id

      AND emergency.homeowner_id =
          NEW.created_by_user_id

      AND emergency.status IN (
        'assigned',
        'professional_en_route',
        'professional_arrived',
        'work_in_progress',
        'completed'
      )
  ) THEN
    RAISE EXCEPTION
      'Emergency Job does not match its selected Emergency relationship.'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;


DROP TRIGGER IF EXISTS
  jobs_emergency_request_source_check
ON jobs;

CREATE TRIGGER
  jobs_emergency_request_source_check
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
  originating_business_document_id,
  source_business_customer_job_id,
  source_emergency_request_id
ON jobs
FOR EACH ROW
EXECUTE FUNCTION
  assert_emergency_request_job_source();


CREATE UNIQUE INDEX IF NOT EXISTS
  jobs_emergency_request_source_uidx
ON jobs(
  source_emergency_request_id
)
WHERE source_type =
  'emergency_request';


CREATE UNIQUE INDEX IF NOT EXISTS
  jobs_emergency_request_source_identity_uidx
ON jobs(
  id,
  source_type,
  source_emergency_request_id
)
WHERE source_type =
  'emergency_request';


CREATE INDEX IF NOT EXISTS
  jobs_emergency_request_created_idx
ON jobs(
  created_by_user_id,
  created_at DESC,
  id
)
WHERE source_type =
  'emergency_request';


-- -------------------------------------------------------------------------
-- Participant provenance.
--
-- Both homeowner and selected professional are real authenticated users.
-- No Request Selection is fabricated.
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
      'business_customer',
      'business_document',
      'emergency_selection'
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
      source_evidence_type =
        'request_selection'
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
      source_evidence_type =
        'emergency_selection'
      AND request_relationship_id IS NOT NULL
    )

    OR

    (
      source_evidence_type =
        'business_customer'
      AND request_relationship_id IS NULL
    )

    OR

    (
      source_evidence_type =
        'business_document'
      AND request_relationship_id IS NULL
    )
  );


COMMENT ON COLUMN jobs.source_type IS
  'Lifecycle Job origin: marketplace Request Selection, direct existing Meetro customer request, business-owned customer/document, or selected Emergency Request.';

COMMENT ON COLUMN
  jobs.source_emergency_request_id IS
  'Exact Emergency Request source for source_type=emergency_request. NULL for every other Job origin.';
