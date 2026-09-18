-- ============================================================================
-- Canonical external Quote approval source generalization.
--
-- QUICK QUOTE / business_document
--
--   External approval customer identity remains:
--
--     canonical_quote_customer_snapshots
--       -> customer_snapshot_hash
--
-- FULL EXTERNAL JOB / business_customer
--
--   External approval customer identity is:
--
--     canonical_quote_customer_parties
--       -> business_contact_id
--       -> business_customer_relationship_id
--
-- The two identity branches are mutually exclusive.
--
-- This migration does NOT:
--
--   * create or modify a Quote decision;
--   * create external approval evidence;
--   * create canonical Quote approval;
--   * create deposits or payments;
--   * change authenticated Meetro customer approval;
--   * convert business_customer into business_document;
--   * modify Quick Quote customer snapshot provenance.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- Exact immutable Quote customer-party source key.
--
-- Migration 007 already requires a business_customer Quote customer party
-- to equal the Job's exact:
--
--   contractor_profile_id
--   business_contact_id
--   business_customer_relationship_id
--
-- canonical_quote_customer_parties is append-only.
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS
  canonical_quote_customer_parties_external_approval_source_uidx
ON canonical_quote_customer_parties(
  quote_id,
  job_id,
  contractor_profile_id,
  business_contact_id,
  business_customer_relationship_id
);


-- ---------------------------------------------------------------------------
-- Generalize the external-approval customer identity.
--
-- Existing Quick Quote evidence keeps customer_snapshot_hash.
-- business_customer evidence uses the exact canonical Quote customer party.
-- ---------------------------------------------------------------------------

ALTER TABLE canonical_quote_external_approval_evidence
  ALTER COLUMN customer_snapshot_hash
    DROP NOT NULL;


ALTER TABLE canonical_quote_external_approval_evidence
  ADD COLUMN IF NOT EXISTS
    business_contact_id UUID,
  ADD COLUMN IF NOT EXISTS
    business_customer_relationship_id UUID;


ALTER TABLE canonical_quote_external_approval_evidence
  DROP CONSTRAINT IF EXISTS
    canonical_quote_external_approval_customer_identity_shape_check;


ALTER TABLE canonical_quote_external_approval_evidence
  ADD CONSTRAINT
    canonical_quote_external_approval_customer_identity_shape_check
  CHECK (
    (
      customer_snapshot_hash IS NOT NULL

      AND business_contact_id IS NULL

      AND business_customer_relationship_id IS NULL
    )

    OR

    (
      customer_snapshot_hash IS NULL

      AND business_contact_id IS NOT NULL

      AND business_customer_relationship_id IS NOT NULL
    )
  );


-- ---------------------------------------------------------------------------
-- Exact business_customer Quote customer-party proof.
--
-- For business_document rows the new Contact/Relationship columns are NULL,
-- so this MATCH SIMPLE foreign key is not invoked.
-- ---------------------------------------------------------------------------

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname =
      'canonical_quote_external_approval_customer_party_fk'
      AND conrelid =
        'canonical_quote_external_approval_evidence'::regclass
  ) THEN
    ALTER TABLE canonical_quote_external_approval_evidence
      ADD CONSTRAINT
        canonical_quote_external_approval_customer_party_fk

      FOREIGN KEY (
        quote_id,
        job_id,
        contractor_profile_id,
        business_contact_id,
        business_customer_relationship_id
      )

      REFERENCES canonical_quote_customer_parties(
        quote_id,
        job_id,
        contractor_profile_id,
        business_contact_id,
        business_customer_relationship_id
      )

      ON DELETE RESTRICT;
  END IF;
END;
$migration$;


CREATE INDEX IF NOT EXISTS
  canonical_quote_external_approval_customer_party_idx
ON canonical_quote_external_approval_evidence(
  contractor_profile_id,
  business_contact_id,
  business_customer_relationship_id,
  approved_at DESC,
  quote_id
)
WHERE
  business_contact_id IS NOT NULL
  AND business_customer_relationship_id IS NOT NULL;


-- ---------------------------------------------------------------------------
-- Source-aware external-approval origin guard.
--
-- Quick Quote:
--   business_document + exact immutable customer snapshot
--
-- Full external Job:
--   business_customer + exact immutable canonical Quote customer party
--
-- No Meetro customer participant is fabricated for either external path.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION
assert_external_quote_approval_business_origin()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Quick Quote / Quick Invoice document workflow.
  IF EXISTS (
    SELECT 1

    FROM canonical_quotes quotes

    INNER JOIN canonical_quote_customer_snapshots snapshots
      ON snapshots.quote_id =
           quotes.id
     AND snapshots.job_id =
           quotes.job_id
     AND snapshots.contractor_profile_id =
           NEW.contractor_profile_id
     AND snapshots.snapshot_hash =
           NEW.customer_snapshot_hash

    WHERE quotes.id =
            NEW.quote_id

      AND quotes.job_id =
            NEW.job_id

      AND quotes.source_context_type =
            'business_document'

      AND quotes.job_source_type =
            'business_document'

      AND NEW.customer_snapshot_hash
            IS NOT NULL

      AND NEW.business_contact_id
            IS NULL

      AND NEW.business_customer_relationship_id
            IS NULL
  ) THEN
    RETURN NEW;
  END IF;


  -- Full-workflow External Customer Job.
  IF EXISTS (
    SELECT 1

    FROM canonical_quotes quotes

    INNER JOIN canonical_quote_customer_parties parties
      ON parties.quote_id =
           quotes.id
     AND parties.job_id =
           quotes.job_id
     AND parties.contractor_profile_id =
           NEW.contractor_profile_id
     AND parties.business_contact_id =
           NEW.business_contact_id
     AND parties.business_customer_relationship_id =
           NEW.business_customer_relationship_id

    WHERE quotes.id =
            NEW.quote_id

      AND quotes.job_id =
            NEW.job_id

      AND quotes.source_context_type =
            'business_customer'

      AND quotes.job_source_type =
            'business_customer'

      AND quotes.business_customer_job_source_id
            IS NOT NULL

      AND NEW.customer_snapshot_hash
            IS NULL

      AND NEW.business_contact_id
            IS NOT NULL

      AND NEW.business_customer_relationship_id
            IS NOT NULL
  ) THEN
    RETURN NEW;
  END IF;


  RAISE EXCEPTION
    'External approval evidence requires an exact canonical external-customer Quote identity.';
END;
$$;


DROP TRIGGER IF EXISTS
  canonical_quote_external_approval_origin_guard
ON canonical_quote_external_approval_evidence;


CREATE TRIGGER
  canonical_quote_external_approval_origin_guard
BEFORE INSERT OR UPDATE
ON canonical_quote_external_approval_evidence
FOR EACH ROW
EXECUTE FUNCTION
  assert_external_quote_approval_business_origin();


COMMENT ON COLUMN
  canonical_quote_external_approval_evidence.customer_snapshot_hash
IS
  'Immutable Quick Quote business_document customer snapshot hash. NULL for business_customer Job Quote external approval evidence.';


COMMENT ON COLUMN
  canonical_quote_external_approval_evidence.business_contact_id
IS
  'Exact durable external Contact from canonical_quote_customer_parties for business_customer Job Quote approval evidence. NULL for business_document Quick Quote approval evidence.';


COMMENT ON COLUMN
  canonical_quote_external_approval_evidence.business_customer_relationship_id
IS
  'Exact durable Customer Relationship from canonical_quote_customer_parties for business_customer Job Quote approval evidence. NULL for business_document Quick Quote approval evidence.';


-- ---------------------------------------------------------------------------
-- Important preserved authority.
--
-- canonical_quote_approvals remains unchanged and origin-neutral:
--
--   approval_source = MEETRO_CUSTOMER
--     -> canonical_quote_customer_decisions
--
--   approval_source = EXTERNAL_EVIDENCE
--     -> canonical_quote_external_approval_evidence
--
-- No business row is created or mutated by this migration.
-- ---------------------------------------------------------------------------
