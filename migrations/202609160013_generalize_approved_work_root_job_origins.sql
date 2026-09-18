-- ============================================================================
-- Four-origin Approved Work / Work Preparation root approval authority.
--
-- Relationship-backed authenticated Meetro Jobs:
--
--   ordinary_request_selection + MEETRO_CUSTOMER
--   existing_customer_request   + MEETRO_CUSTOMER
--
-- Relationship-neutral business-owned Jobs:
--
--   business_document + EXTERNAL_EVIDENCE
--   business_customer + EXTERNAL_EVIDENCE
--
-- This migration replaces only the shared root approval trigger function
-- introduced by 202609020006.
--
-- It does NOT:
--   * modify historical migrations;
--   * create Quote approvals;
--   * create customer decisions or external approval evidence;
--   * create Request Selections;
--   * fabricate Meetro customer participants for external customers;
--   * mutate existing Work Preparation or Approved Work rows;
--   * change child approval propagation;
--   * change deposit, scheduling, completion, or invoice authority.
-- ============================================================================


CREATE OR REPLACE FUNCTION
bind_common_execution_root_approval()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  approval RECORD;
  origin RECORD;
BEGIN
  -- Bind the root to one exact immutable common Quote approval.
  SELECT a.*
  INTO approval
  FROM canonical_quote_approvals a
  WHERE a.job_id = NEW.job_id
    AND a.quote_id = NEW.quote_id
    AND a.issued_quote_version =
        NEW.issued_quote_version
    AND a.issued_integrity_hash =
        NEW.source_integrity_hash
    AND (
      (
        NEW.quote_approval_id IS NOT NULL
        AND a.id = NEW.quote_approval_id
      )
      OR
      (
        NEW.quote_approval_id IS NULL
        AND a.customer_decision_id =
            NEW.approved_customer_decision_id
      )
    );

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Exact common Quote approval required for preparation/execution.'
      USING ERRCODE = '23503';
  END IF;

  IF NEW.approval_source IS NOT NULL
     AND NEW.approval_source <>
         approval.approval_source THEN
    RAISE EXCEPTION
      'Common approval source mismatch.'
      USING ERRCODE = '23503';
  END IF;

  NEW.quote_approval_id :=
    approval.id;

  NEW.approval_source :=
    approval.approval_source;


  -- Load immutable Job-origin truth.
  SELECT
    jobs.*,
    profiles.user_id AS professional_user_id
  INTO origin
  FROM jobs
  LEFT JOIN contractor_profiles profiles
    ON profiles.id = jobs.contractor_profile_id
  WHERE jobs.id = NEW.job_id;


  -- Both Meetro origins retain their exact Request + fresh Request Relationship.
  -- Both business-owned origins remain Request/Relationship neutral.
  IF NEW.job_request_id
       IS DISTINCT FROM origin.job_request_id

     OR NEW.relationship_id
       IS DISTINCT FROM
          origin.source_request_relationship_id

     OR NEW.approved_customer_decision_id
       IS DISTINCT FROM
          approval.customer_decision_id
  THEN
    RAISE EXCEPTION
      'Preparation/execution origin provenance mismatch.'
      USING ERRCODE = '23503';
  END IF;


  -- -------------------------------------------------------------------------
  -- Business-owned external approval.
  --
  -- Quick Quote:
  --   business_document + EXTERNAL_EVIDENCE
  --
  -- Full external customer:
  --   business_customer + EXTERNAL_EVIDENCE
  --
  -- Neither path fabricates a Meetro customer participant or customer decision.
  -- -------------------------------------------------------------------------
  IF approval.approval_source =
       'EXTERNAL_EVIDENCE' THEN

    IF origin.source_type NOT IN (
         'business_document',
         'business_customer'
       )

       OR NEW.customer_participant_id
            IS NOT NULL

       OR NEW.approved_customer_decision
            IS NOT NULL

       OR NOT EXISTS (
         SELECT 1
         FROM relationship_participants actor
         WHERE actor.id =
               NEW.created_by_professional_participant_id

           AND actor.job_id =
               NEW.job_id

           AND actor.user_id =
               origin.professional_user_id

           AND actor.request_relationship_id
               IS NULL
       )
    THEN
      RAISE EXCEPTION
        'External preparation/execution requires the real business professional.'
        USING ERRCODE = '23503';
    END IF;


  -- -------------------------------------------------------------------------
  -- Authenticated Meetro customer approval.
  --
  -- Marketplace:
  --   ordinary_request_selection + MEETRO_CUSTOMER
  --
  -- Repeat Meetro:
  --   existing_customer_request + MEETRO_CUSTOMER
  --
  -- The latter remains Selection-free for the new Job.
  -- -------------------------------------------------------------------------
  ELSIF approval.approval_source =
          'MEETRO_CUSTOMER' THEN

    IF origin.source_type NOT IN (
         'ordinary_request_selection',
         'existing_customer_request'
       )
    THEN
      RAISE EXCEPTION
        'Meetro approval requires an authenticated Meetro-customer Job origin.'
        USING ERRCODE = '23503';
    END IF;

    -- Legacy direct insert callers may omit only the constant decision label.
    NEW.approved_customer_decision :=
      COALESCE(
        NEW.approved_customer_decision,
        'APPROVED'
      );


  ELSE
    RAISE EXCEPTION
      'Unsupported common Quote approval source.'
      USING ERRCODE = '23503';
  END IF;


  RETURN NEW;
END;
$$;
