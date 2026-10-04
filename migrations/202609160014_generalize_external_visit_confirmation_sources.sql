-- ============================================================================
-- Source-aware external Approved Work Visit confirmation evidence.
--
-- QUICK QUOTE / business_document
--
--   customer identity remains:
--
--     canonical_quote_customer_snapshots
--       -> customer_snapshot_hash
--
-- FULL EXTERNAL JOB / business_customer
--
--   customer identity remains:
--
--     canonical_quote_customer_parties
--       -> business_contact_id
--       -> business_customer_relationship_id
--
-- These identity branches are mutually exclusive.
--
-- This migration does NOT:
--   * fabricate a Quick Quote customer snapshot for business_customer;
--   * create or modify Visits or Visit versions;
--   * create confirmation evidence;
--   * create Quote approval evidence;
--   * create customer participants;
--   * change Meetro-customer scheduling;
--   * change Evaluation Visit evidence;
--   * mutate existing lifecycle business rows.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- Generalize external Approved Work Visit customer identity.
-- ---------------------------------------------------------------------------

ALTER TABLE canonical_visit_external_confirmation_evidence
  ALTER COLUMN customer_snapshot_hash
    DROP NOT NULL;


ALTER TABLE canonical_visit_external_confirmation_evidence
  ADD COLUMN IF NOT EXISTS
    business_contact_id UUID,
  ADD COLUMN IF NOT EXISTS
    business_customer_relationship_id UUID;


ALTER TABLE canonical_visit_external_confirmation_evidence
  DROP CONSTRAINT IF EXISTS
    canonical_visit_external_confirmation_customer_identity_shape_check;


ALTER TABLE canonical_visit_external_confirmation_evidence
  ADD CONSTRAINT
    canonical_visit_external_confirmation_customer_identity_shape_check
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
  )
  NOT VALID;


ALTER TABLE canonical_visit_external_confirmation_evidence
  VALIDATE CONSTRAINT
    canonical_visit_external_confirmation_customer_identity_shape_check;


-- ---------------------------------------------------------------------------
-- Full External Customer Visit evidence binds to the exact immutable
-- canonical Quote customer party.
--
-- Quick Quote rows have NULL Contact/Relationship columns, so MATCH SIMPLE
-- leaves the existing snapshot FK as their active identity proof.
-- ---------------------------------------------------------------------------

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1

    FROM pg_constraint

    WHERE conname =
      'canonical_visit_external_confirmation_customer_party_fk'

      AND conrelid =
        'canonical_visit_external_confirmation_evidence'::regclass
  ) THEN
    ALTER TABLE canonical_visit_external_confirmation_evidence
      ADD CONSTRAINT
        canonical_visit_external_confirmation_customer_party_fk

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

      ON DELETE RESTRICT
      NOT VALID;
  END IF;
END;
$migration$;


ALTER TABLE canonical_visit_external_confirmation_evidence
  VALIDATE CONSTRAINT
    canonical_visit_external_confirmation_customer_party_fk;


CREATE INDEX IF NOT EXISTS
  canonical_visit_external_confirmation_customer_party_idx
ON canonical_visit_external_confirmation_evidence(
  contractor_profile_id,
  business_contact_id,
  business_customer_relationship_id,
  created_at DESC,
  visit_id
)
WHERE business_contact_id IS NOT NULL
  AND business_customer_relationship_id IS NOT NULL;


-- ---------------------------------------------------------------------------
-- Source-aware identity and schedule guard.
--
-- Both external Job origins continue to require:
--
--   * exact canonical Quote approval;
--   * exact external Quote approval evidence;
--   * exact proposed and scheduled Visit versions;
--   * same canonical schedule;
--   * real business professional;
--   * active PRIMARY_PROFESSIONAL role.
--
-- business_document:
--   exact immutable customer snapshot.
--
-- business_customer:
--   exact immutable Quote customer party + exact Job source identity.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION
assert_external_visit_confirmation_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1

    FROM jobs

    INNER JOIN contractor_profiles profiles
      ON profiles.id =
           jobs.contractor_profile_id

    INNER JOIN relationship_participants actor
      ON actor.job_id =
           jobs.id

     AND actor.user_id =
           profiles.user_id

     AND actor.request_relationship_id
           IS NULL

    INNER JOIN canonical_visits visits
      ON visits.id =
           NEW.visit_id

     AND visits.job_id =
           jobs.id

     AND visits.purpose =
           'APPROVED_WORK'

     AND visits.quote_approval_id =
           NEW.quote_approval_id

     AND visits.quote_approval_source =
           'EXTERNAL_EVIDENCE'

    INNER JOIN canonical_quote_approvals approvals
      ON approvals.id =
           NEW.quote_approval_id

     AND approvals.job_id =
           jobs.id

     AND approvals.quote_id =
           NEW.quote_id

     AND approvals.decision =
           'APPROVED'

     AND approvals.approval_source =
           'EXTERNAL_EVIDENCE'

     AND approvals.external_approval_evidence_id
           IS NOT NULL

    INNER JOIN canonical_quote_external_approval_evidence
      quote_evidence
      ON quote_evidence.id =
           approvals.external_approval_evidence_id

     AND quote_evidence.quote_id =
           approvals.quote_id

     AND quote_evidence.job_id =
           approvals.job_id

     AND quote_evidence.contractor_profile_id =
           NEW.contractor_profile_id

     AND quote_evidence.customer_snapshot_hash
           IS NOT DISTINCT FROM
           NEW.customer_snapshot_hash

     AND quote_evidence.business_contact_id
           IS NOT DISTINCT FROM
           NEW.business_contact_id

     AND quote_evidence.business_customer_relationship_id
           IS NOT DISTINCT FROM
           NEW.business_customer_relationship_id

    INNER JOIN canonical_visit_versions proposed
      ON proposed.visit_id =
           NEW.visit_id

     AND proposed.version =
           NEW.proposed_visit_version

     AND proposed.job_id =
           jobs.id

    INNER JOIN canonical_visit_versions scheduled
      ON scheduled.visit_id =
           NEW.visit_id

     AND scheduled.version =
           NEW.scheduled_visit_version

     AND scheduled.job_id =
           jobs.id

    LEFT JOIN canonical_quote_customer_snapshots snapshots
      ON snapshots.quote_id =
           NEW.quote_id

     AND snapshots.job_id =
           NEW.job_id

     AND snapshots.contractor_profile_id =
           NEW.contractor_profile_id

     AND snapshots.snapshot_hash =
           NEW.customer_snapshot_hash

    LEFT JOIN canonical_quote_customer_parties parties
      ON parties.quote_id =
           NEW.quote_id

     AND parties.job_id =
           NEW.job_id

     AND parties.contractor_profile_id =
           NEW.contractor_profile_id

     AND parties.business_contact_id =
           NEW.business_contact_id

     AND parties.business_customer_relationship_id =
           NEW.business_customer_relationship_id

    LEFT JOIN business_customer_job_sources customer_sources
      ON customer_sources.id =
           jobs.source_business_customer_job_id

     AND customer_sources.contractor_profile_id =
           jobs.contractor_profile_id

     AND customer_sources.business_contact_id =
           jobs.business_contact_id

     AND customer_sources.business_customer_relationship_id =
           jobs.business_customer_relationship_id

     AND customer_sources.created_by_user_id =
           profiles.user_id

    WHERE jobs.id =
          NEW.job_id

      AND profiles.id =
          NEW.contractor_profile_id

      AND actor.id =
          NEW.recorded_by_participant_id

      AND scheduled.state =
          'SCHEDULED'

      AND scheduled.command_idempotency_id =
          NEW.command_idempotency_id

      AND scheduled.recorded_by_participant_id =
          NEW.recorded_by_participant_id

      AND proposed.state =
          'PROPOSED'

      AND proposed.scheduled_start_at =
          NEW.scheduled_start_at

      AND proposed.scheduled_end_at
          IS NOT DISTINCT FROM
          NEW.scheduled_end_at

      AND proposed.time_zone =
          NEW.time_zone

      AND proposed.location_mode =
          NEW.location_mode

      AND scheduled.scheduled_start_at =
          proposed.scheduled_start_at

      AND scheduled.scheduled_end_at
          IS NOT DISTINCT FROM
          proposed.scheduled_end_at

      AND scheduled.time_zone =
          proposed.time_zone

      AND scheduled.location_mode =
          proposed.location_mode

      AND NEW.confirmed_at >=
          date_trunc(
            'milliseconds',
            proposed.created_at
          )

      AND EXISTS (
        SELECT 1

        FROM participant_role_assignments roles

        LEFT JOIN participant_role_revocations revocations
          ON revocations.role_assignment_id =
             roles.id

        WHERE roles.participant_id =
              actor.id

          AND roles.job_id =
              jobs.id

          AND roles.role =
              'PRIMARY_PROFESSIONAL'

          AND roles.valid_from <=
              CURRENT_TIMESTAMP

          AND (
            roles.valid_until IS NULL
            OR roles.valid_until >
               CURRENT_TIMESTAMP
          )

          AND revocations.id IS NULL
      )

      AND (
        (
          jobs.source_type =
            'business_document'

          AND jobs.job_request_id IS NULL

          AND jobs.source_request_relationship_id
              IS NULL

          AND jobs.originating_business_document_id
              IS NOT NULL

          AND NEW.customer_snapshot_hash
              IS NOT NULL

          AND NEW.business_contact_id
              IS NULL

          AND NEW.business_customer_relationship_id
              IS NULL

          AND snapshots.quote_id
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

          AND jobs.business_contact_id =
              NEW.business_contact_id

          AND jobs.business_customer_relationship_id =
              NEW.business_customer_relationship_id

          AND jobs.source_business_customer_job_id
              IS NOT NULL

          AND actor.source_evidence_type =
              'business_customer'

          AND NEW.customer_snapshot_hash
              IS NULL

          AND NEW.business_contact_id
              IS NOT NULL

          AND NEW.business_customer_relationship_id
              IS NOT NULL

          AND parties.quote_id
              IS NOT NULL

          AND customer_sources.id
              IS NOT NULL
        )
      )
  ) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'External Visit confirmation identity or schedule mismatch.';
END;
$$;


COMMENT ON COLUMN
canonical_visit_external_confirmation_evidence.customer_snapshot_hash IS
  'Immutable business_document Quick Quote customer snapshot identity. NULL for business_customer Approved Work Visit confirmation evidence.';


COMMENT ON COLUMN
canonical_visit_external_confirmation_evidence.business_contact_id IS
  'Exact durable external Contact from canonical_quote_customer_parties for business_customer Approved Work Visit confirmation evidence. NULL for business_document Quick Quote evidence.';


COMMENT ON COLUMN
canonical_visit_external_confirmation_evidence.business_customer_relationship_id IS
  'Exact durable external Customer Relationship from canonical_quote_customer_parties for business_customer Approved Work Visit confirmation evidence. NULL for business_document Quick Quote evidence.';


-- No lifecycle business rows are inserted, updated, or deleted.
