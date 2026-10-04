-- Business Customer Evaluation Visit external confirmation evidence.
--
-- Evaluation Visit scheduling remains Job-scoped.
-- This evidence deliberately does NOT require evaluation_id.
--
-- It documents an external customer's off-platform confirmation of the exact
-- proposed Evaluation Visit schedule without fabricating a Meetro customer,
-- Request Relationship, Request Selection, Quote approval, or deposit.
--
-- No business rows are created and no backfill is performed.


CREATE TABLE
  canonical_evaluation_visit_external_confirmation_evidence
(
  id UUID PRIMARY KEY,

  job_id UUID NOT NULL,
  visit_id UUID NOT NULL,

  visit_purpose TEXT NOT NULL
    DEFAULT 'EVALUATION'
    CHECK (
      visit_purpose = 'EVALUATION'
    ),

  business_customer_job_source_id UUID NOT NULL,
  contractor_profile_id INTEGER NOT NULL,
  business_contact_id UUID NOT NULL,
  business_customer_relationship_id UUID NOT NULL,
  source_created_by_user_id INTEGER NOT NULL,

  proposed_visit_version INTEGER NOT NULL
    CHECK (
      proposed_visit_version >= 1
    ),

  proposed_visit_state TEXT NOT NULL
    DEFAULT 'PROPOSED'
    CHECK (
      proposed_visit_state = 'PROPOSED'
    ),

  proposed_integrity_hash TEXT NOT NULL
    CHECK (
      proposed_integrity_hash ~
        '^[0-9a-f]{64}$'
    ),

  scheduled_visit_version INTEGER NOT NULL
    CHECK (
      scheduled_visit_version =
        proposed_visit_version + 1
    ),

  scheduled_start_at TIMESTAMPTZ NOT NULL,
  scheduled_end_at TIMESTAMPTZ,

  time_zone TEXT NOT NULL
    CHECK (
      char_length(
        btrim(time_zone)
      ) BETWEEN 1 AND 100
    ),

  location_mode TEXT NOT NULL
    CHECK (
      location_mode IN (
        'JOB_SERVICE_LOCATION',
        'REMOTE'
      )
    ),

  evidence_method TEXT NOT NULL
    CHECK (
      evidence_method IN (
        'PHONE',
        'EMAIL',
        'TEXT_MESSAGE',
        'IN_PERSON',
        'OTHER'
      )
    ),

  confirmed_at TIMESTAMPTZ NOT NULL,

  evidence_reference TEXT
    CHECK (
      evidence_reference IS NULL
      OR char_length(
           btrim(evidence_reference)
         ) BETWEEN 1 AND 1000
    ),

  evidence_note TEXT
    CHECK (
      evidence_note IS NULL
      OR char_length(
           btrim(evidence_note)
         ) BETWEEN 1 AND 8000
    ),

  recorded_by_participant_id UUID NOT NULL,

  command_idempotency_id UUID NOT NULL
    UNIQUE,

  command_name TEXT NOT NULL
    DEFAULT
      'visit.external_confirmation.record'
    CHECK (
      command_name =
        'visit.external_confirmation.record'
    ),

  event_id UUID NOT NULL
    UNIQUE,

  event_type TEXT NOT NULL
    DEFAULT
      'VISIT_EXTERNAL_CONFIRMATION_RECORDED'
    CHECK (
      event_type =
        'VISIT_EXTERNAL_CONFIRMATION_RECORDED'
    ),

  created_at TIMESTAMPTZ NOT NULL
    DEFAULT CURRENT_TIMESTAMP,

  CHECK (
    evidence_reference IS NOT NULL
    OR evidence_note IS NOT NULL
  ),

  CHECK (
    confirmed_at <= created_at
  ),

  CHECK (
    scheduled_start_at >
      confirmed_at
  ),

  CHECK (
    scheduled_end_at IS NULL
    OR scheduled_end_at >
       scheduled_start_at
  ),

  UNIQUE (
    visit_id,
    proposed_visit_version
  ),

  UNIQUE (
    visit_id,
    scheduled_visit_version
  ),

  CONSTRAINT
    canonical_evaluation_visit_external_confirmation_visit_fk
    FOREIGN KEY (
      visit_id,
      job_id,
      visit_purpose
    )
    REFERENCES canonical_visits(
      id,
      job_id,
      purpose
    )
    ON DELETE RESTRICT,

  CONSTRAINT
    canonical_evaluation_visit_external_confirmation_source_fk
    FOREIGN KEY (
      business_customer_job_source_id,
      contractor_profile_id,
      business_contact_id,
      business_customer_relationship_id,
      source_created_by_user_id
    )
    REFERENCES
      business_customer_job_sources(
        id,
        contractor_profile_id,
        business_contact_id,
        business_customer_relationship_id,
        created_by_user_id
      )
    ON DELETE RESTRICT,

  CONSTRAINT
    canonical_evaluation_visit_external_confirmation_proposal_fk
    FOREIGN KEY (
      visit_id,
      proposed_visit_version,
      job_id,
      proposed_visit_state,
      proposed_integrity_hash
    )
    REFERENCES canonical_visit_versions(
      visit_id,
      version,
      job_id,
      state,
      integrity_hash
    )
    ON DELETE RESTRICT,

  CONSTRAINT
    canonical_evaluation_visit_external_confirmation_scheduled_fk
    FOREIGN KEY (
      visit_id,
      scheduled_visit_version
    )
    REFERENCES canonical_visit_versions(
      visit_id,
      version
    )
    ON DELETE RESTRICT,

  CONSTRAINT
    canonical_evaluation_visit_external_confirmation_actor_fk
    FOREIGN KEY (
      recorded_by_participant_id,
      job_id
    )
    REFERENCES relationship_participants(
      id,
      job_id
    )
    ON DELETE RESTRICT,

  CONSTRAINT
    canonical_evaluation_visit_external_confirmation_command_fk
    FOREIGN KEY (
      command_idempotency_id,
      recorded_by_participant_id,
      job_id,
      command_name
    )
    REFERENCES canonical_visit_command_idempotency(
      id,
      actor_participant_id,
      job_id,
      command_name
    )
    ON DELETE RESTRICT,

  CONSTRAINT
    canonical_evaluation_visit_external_confirmation_event_fk
    FOREIGN KEY (
      event_id,
      visit_id,
      job_id,
      scheduled_visit_version,
      event_type,
      command_idempotency_id,
      recorded_by_participant_id
    )
    REFERENCES canonical_visit_events(
      id,
      visit_id,
      job_id,
      visit_version,
      event_type,
      command_idempotency_id,
      recorded_by_participant_id
    )
    ON DELETE RESTRICT
);


CREATE INDEX
  canonical_evaluation_visit_external_confirmation_job_idx
ON canonical_evaluation_visit_external_confirmation_evidence(
  job_id,
  created_at DESC,
  visit_id
);


CREATE OR REPLACE FUNCTION
assert_business_customer_evaluation_visit_confirmation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1

    FROM jobs

    INNER JOIN
      business_customer_job_sources sources
      ON sources.id =
           jobs.source_business_customer_job_id
     AND sources.contractor_profile_id =
           jobs.contractor_profile_id
     AND sources.business_contact_id =
           jobs.business_contact_id
     AND sources.business_customer_relationship_id =
           jobs.business_customer_relationship_id
     AND sources.created_by_user_id =
           jobs.created_by_user_id

    INNER JOIN contractor_profiles profiles
      ON profiles.id =
           jobs.contractor_profile_id
     AND profiles.user_id =
           sources.created_by_user_id

    INNER JOIN business_contacts contacts
      ON contacts.id =
           jobs.business_contact_id
     AND contacts.contractor_profile_id =
           jobs.contractor_profile_id
     AND contacts.status =
           'ACTIVE'

    INNER JOIN
      business_customer_relationships relationships
      ON relationships.id =
           jobs.business_customer_relationship_id
     AND relationships.contractor_profile_id =
           jobs.contractor_profile_id
     AND relationships.business_contact_id =
           jobs.business_contact_id

    INNER JOIN canonical_visits visits
      ON visits.id =
           NEW.visit_id
     AND visits.job_id =
           jobs.id
     AND visits.purpose =
           'EVALUATION'

    INNER JOIN
      relationship_participants actor
      ON actor.id =
           NEW.recorded_by_participant_id
     AND actor.job_id =
           jobs.id
     AND actor.user_id =
           profiles.user_id
     AND actor.request_relationship_id
           IS NULL
     AND actor.source_evidence_type =
           'business_customer'

    INNER JOIN
      canonical_visit_versions proposed
      ON proposed.visit_id =
           visits.id
     AND proposed.job_id =
           jobs.id
     AND proposed.version =
           NEW.proposed_visit_version
     AND proposed.state =
           'PROPOSED'
     AND proposed.integrity_hash =
           NEW.proposed_integrity_hash

    INNER JOIN
      canonical_visit_versions scheduled
      ON scheduled.visit_id =
           visits.id
     AND scheduled.job_id =
           jobs.id
     AND scheduled.version =
           NEW.scheduled_visit_version
     AND scheduled.state =
           'SCHEDULED'

    WHERE jobs.id =
          NEW.job_id

      AND jobs.source_type =
          'business_customer'

      AND jobs.job_request_id
          IS NULL

      AND jobs.source_request_selection_id
          IS NULL

      AND jobs.source_request_relationship_id
          IS NULL

      AND jobs.originating_business_document_id
          IS NULL

      AND jobs.source_business_customer_job_id =
          NEW.business_customer_job_source_id

      AND jobs.contractor_profile_id =
          NEW.contractor_profile_id

      AND jobs.business_contact_id =
          NEW.business_contact_id

      AND jobs.business_customer_relationship_id =
          NEW.business_customer_relationship_id

      AND sources.created_by_user_id =
          NEW.source_created_by_user_id

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

      AND scheduled.command_idempotency_id =
          NEW.command_idempotency_id

      AND scheduled.recorded_by_participant_id =
          NEW.recorded_by_participant_id

      AND NEW.confirmed_at >=
          date_trunc(
            'milliseconds',
            proposed.created_at
          )

      AND EXISTS (
        SELECT 1

        FROM business_contact_roles roles

        WHERE roles.business_contact_id =
              contacts.id

          AND roles.contractor_profile_id =
              contacts.contractor_profile_id

          AND roles.role =
              'CUSTOMER'

          AND roles.ended_at
              IS NULL
      )

      AND EXISTS (
        SELECT 1

        FROM participant_role_assignments roles

        LEFT JOIN
          participant_role_revocations revocations
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

          AND revocations.id
              IS NULL
      )
  ) THEN
    RAISE EXCEPTION
      'Business Customer Evaluation Visit confirmation identity or schedule mismatch.'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;


CREATE TRIGGER
  canonical_business_customer_evaluation_visit_confirmation_identity
BEFORE INSERT
ON canonical_evaluation_visit_external_confirmation_evidence
FOR EACH ROW
EXECUTE FUNCTION
  assert_business_customer_evaluation_visit_confirmation();


CREATE TRIGGER
  canonical_business_customer_evaluation_visit_confirmation_append_only
BEFORE UPDATE OR DELETE
ON canonical_evaluation_visit_external_confirmation_evidence
FOR EACH ROW
EXECUTE FUNCTION
  prevent_canonical_visit_history_mutation();


CREATE OR REPLACE FUNCTION
require_business_customer_evaluation_visit_schedule_evidence()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF
    NEW.state = 'SCHEDULED'

    AND EXISTS (
      SELECT 1

      FROM canonical_visits visits

      INNER JOIN jobs
        ON jobs.id =
             visits.job_id

      WHERE visits.id =
            NEW.visit_id

        AND visits.job_id =
            NEW.job_id

        AND visits.purpose =
            'EVALUATION'

        AND jobs.source_type =
            'business_customer'
    )

    AND NOT EXISTS (
      SELECT 1

      FROM
        canonical_evaluation_visit_external_confirmation_evidence evidence

      WHERE evidence.visit_id =
            NEW.visit_id

        AND evidence.job_id =
            NEW.job_id

        AND evidence.scheduled_visit_version =
            NEW.version

        AND evidence.command_idempotency_id =
            NEW.command_idempotency_id
    )
  THEN
    RAISE EXCEPTION
      'Business Customer scheduled Evaluation Visit requires canonical external confirmation evidence.'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;


CREATE CONSTRAINT TRIGGER
  canonical_business_customer_evaluation_visit_schedule_evidence
AFTER INSERT
ON canonical_visit_versions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION
  require_business_customer_evaluation_visit_schedule_evidence();


-- No Evaluation, Visit, Job, participant, authority grant, Request, Quote,
-- deposit, payment, or other lifecycle business row is created.
