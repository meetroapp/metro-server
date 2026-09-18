-- Meetro business-customer Job source foundation.
--
-- Purpose:
--   Allow a business to begin governed work for an established external
--   customer BEFORE Evaluation or Quote creation.
--
-- Authority:
--   Business Contact
--   + durable Business Customer Relationship
--   + active CUSTOMER Contact role
--   + authenticated owning professional
--
-- This source creates NO Meetro homeowner, Request, Professional Response,
-- Request Selection, Request Relationship, Conversation, Quote, payment,
-- scheduling, work, Invoice, or completion authority.


-- -------------------------------------------------------------------------
-- Canonical business-customer Job intake/source.
-- -------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS business_customer_job_sources (
  id UUID PRIMARY KEY,

  contractor_profile_id INTEGER NOT NULL,
  business_contact_id UUID NOT NULL,
  business_customer_relationship_id UUID NOT NULL,
  created_by_user_id INTEGER NOT NULL,

  project_title TEXT NOT NULL
    CHECK (
      char_length(btrim(project_title))
        BETWEEN 1 AND 500
    ),

  project_description TEXT NOT NULL DEFAULT ''
    CHECK (
      char_length(project_description) <= 12000
    ),

  location_state TEXT NOT NULL DEFAULT 'UNSPECIFIED'
    CHECK (
      location_state IN (
        'UNSPECIFIED',
        'TEXT',
        'STRUCTURED'
      )
    ),

  service_location_text TEXT
    CHECK (
      service_location_text IS NULL
      OR char_length(btrim(service_location_text))
           BETWEEN 1 AND 600
    ),

  service_address_line1 TEXT
    CHECK (
      service_address_line1 IS NULL
      OR char_length(btrim(service_address_line1))
           BETWEEN 1 AND 500
    ),

  unit_number TEXT
    CHECK (
      unit_number IS NULL
      OR char_length(btrim(unit_number))
           BETWEEN 1 AND 120
    ),

  service_city TEXT
    CHECK (
      service_city IS NULL
      OR char_length(btrim(service_city))
           BETWEEN 1 AND 120
    ),

  service_region TEXT
    CHECK (
      service_region IS NULL
      OR char_length(btrim(service_region))
           BETWEEN 1 AND 120
    ),

  service_postal_code TEXT
    CHECK (
      service_postal_code IS NULL
      OR char_length(btrim(service_postal_code))
           BETWEEN 1 AND 32
    ),

  service_country_code TEXT
    CHECK (
      service_country_code IS NULL
      OR service_country_code ~ '^[A-Z]{2}$'
    ),

  version INTEGER NOT NULL DEFAULT 1
    CHECK (version >= 1),

  created_at TIMESTAMPTZ NOT NULL
    DEFAULT CURRENT_TIMESTAMP,

  updated_at TIMESTAMPTZ NOT NULL
    DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT
    business_customer_job_sources_owner_fkey
    FOREIGN KEY (
      contractor_profile_id,
      created_by_user_id
    )
    REFERENCES contractor_profiles(
      id,
      user_id
    )
    ON DELETE RESTRICT,

  CONSTRAINT
    business_customer_job_sources_contact_fkey
    FOREIGN KEY (
      business_contact_id,
      contractor_profile_id
    )
    REFERENCES business_contacts(
      id,
      contractor_profile_id
    )
    ON DELETE RESTRICT,

  CONSTRAINT
    business_customer_job_sources_relationship_fkey
    FOREIGN KEY (
      business_customer_relationship_id,
      contractor_profile_id,
      business_contact_id
    )
    REFERENCES business_customer_relationships(
      id,
      contractor_profile_id,
      business_contact_id
    )
    ON DELETE RESTRICT,

  CONSTRAINT
    business_customer_job_sources_location_shape_check
    CHECK (
      (
        location_state = 'UNSPECIFIED'
        AND service_location_text IS NULL
        AND service_address_line1 IS NULL
        AND unit_number IS NULL
        AND service_city IS NULL
        AND service_region IS NULL
        AND service_postal_code IS NULL
        AND service_country_code IS NULL
      )
      OR
      (
        location_state = 'TEXT'
        AND service_location_text IS NOT NULL
        AND service_address_line1 IS NULL
        AND service_city IS NULL
        AND service_region IS NULL
        AND service_postal_code IS NULL
        AND service_country_code IS NULL
      )
      OR
      (
        location_state = 'STRUCTURED'
        AND service_location_text IS NULL
        AND service_address_line1 IS NOT NULL
        AND service_city IS NOT NULL
        AND service_region IS NOT NULL
        AND service_postal_code IS NOT NULL
        AND service_country_code IS NOT NULL
      )
    ),

  CONSTRAINT
    business_customer_job_sources_exact_identity_key
    UNIQUE (
      id,
      contractor_profile_id,
      business_contact_id,
      business_customer_relationship_id,
      created_by_user_id
    )
);

CREATE INDEX IF NOT EXISTS
  business_customer_job_sources_customer_idx
ON business_customer_job_sources(
  contractor_profile_id,
  business_contact_id,
  created_at DESC,
  id
);


-- -------------------------------------------------------------------------
-- Source creation requires an active external Customer identity.
-- Ending CUSTOMER role later does not erase historical source truth.
-- -------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION
assert_business_customer_job_source_authority()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM business_customer_relationships relationships
    INNER JOIN business_contacts contacts
      ON contacts.id =
           relationships.business_contact_id
     AND contacts.contractor_profile_id =
           relationships.contractor_profile_id
    INNER JOIN contractor_profiles profiles
      ON profiles.id =
           relationships.contractor_profile_id
    WHERE relationships.id =
          NEW.business_customer_relationship_id
      AND relationships.contractor_profile_id =
          NEW.contractor_profile_id
      AND relationships.business_contact_id =
          NEW.business_contact_id
      AND profiles.user_id =
          NEW.created_by_user_id
      AND contacts.status = 'ACTIVE'
      AND EXISTS (
        SELECT 1
        FROM business_contact_roles roles
        WHERE roles.business_contact_id =
              contacts.id
          AND roles.contractor_profile_id =
              contacts.contractor_profile_id
          AND roles.role = 'CUSTOMER'
          AND roles.ended_at IS NULL
      )
  ) THEN
    RAISE EXCEPTION
      'Business Customer Job source authority is invalid.'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  business_customer_job_sources_authority_check
ON business_customer_job_sources;

CREATE TRIGGER
  business_customer_job_sources_authority_check
BEFORE INSERT OR UPDATE OF
  contractor_profile_id,
  business_contact_id,
  business_customer_relationship_id,
  created_by_user_id
ON business_customer_job_sources
FOR EACH ROW
EXECUTE FUNCTION
  assert_business_customer_job_source_authority();


-- Project identity may later be corrected through a governed versioned
-- command, but ownership/source identity is immutable.

CREATE OR REPLACE FUNCTION
guard_business_customer_job_source_history()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'Business Customer Job source history cannot be deleted.'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.contractor_profile_id
        IS DISTINCT FROM OLD.contractor_profile_id
     OR NEW.business_contact_id
        IS DISTINCT FROM OLD.business_contact_id
     OR NEW.business_customer_relationship_id
        IS DISTINCT FROM
           OLD.business_customer_relationship_id
     OR NEW.created_by_user_id
        IS DISTINCT FROM OLD.created_by_user_id
     OR NEW.created_at
        IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION
      'Business Customer Job source identity is immutable.'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION
      'Business Customer Job source updates require the next version.'
      USING ERRCODE = '23514';
  END IF;

  NEW.updated_at := CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  business_customer_job_sources_history_guard
ON business_customer_job_sources;

CREATE TRIGGER
  business_customer_job_sources_history_guard
BEFORE UPDATE OR DELETE
ON business_customer_job_sources
FOR EACH ROW
EXECUTE FUNCTION
  guard_business_customer_job_source_history();


-- -------------------------------------------------------------------------
-- Idempotent Job-create command.
-- -------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS
business_customer_job_create_commands (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  actor_user_id INTEGER NOT NULL
    REFERENCES users(id)
    ON DELETE RESTRICT,

  business_customer_relationship_id UUID NOT NULL
    REFERENCES business_customer_relationships(id)
    ON DELETE RESTRICT,

  idempotency_key UUID NOT NULL,

  request_hash TEXT NOT NULL
    CHECK (
      request_hash ~ '^[0-9a-f]{64}$'
    ),

  source_id UUID
    REFERENCES business_customer_job_sources(id)
    ON DELETE RESTRICT,

  job_id UUID
    REFERENCES jobs(id)
    ON DELETE RESTRICT,

  response_json JSONB,

  created_at TIMESTAMPTZ NOT NULL
    DEFAULT CURRENT_TIMESTAMP,

  completed_at TIMESTAMPTZ,

  CONSTRAINT
    business_customer_job_create_commands_actor_key
    UNIQUE (
      actor_user_id,
      idempotency_key
    )
);


-- -------------------------------------------------------------------------
-- Fourth governed Job source.
-- -------------------------------------------------------------------------

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS
    source_business_customer_job_id UUID;

ALTER TABLE jobs
  DROP CONSTRAINT IF EXISTS
    jobs_source_type_check;

ALTER TABLE jobs
  ADD CONSTRAINT jobs_source_type_check
  CHECK (
    source_type IN (
      'ordinary_request_selection',
      'existing_customer_request',
      'business_customer',
      'business_document'
    )
  );

ALTER TABLE jobs
  DROP CONSTRAINT IF EXISTS
    jobs_source_shape_check;

ALTER TABLE jobs
  ADD CONSTRAINT jobs_source_shape_check
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
    )
    OR
    (
      source_type = 'business_customer'
      AND job_request_id IS NULL
      AND source_request_selection_id IS NULL
      AND source_request_relationship_id IS NULL
      AND contractor_profile_id IS NOT NULL
      AND business_contact_id IS NOT NULL
      AND business_customer_relationship_id IS NOT NULL
      AND originating_business_document_id IS NULL
      AND source_business_customer_job_id IS NOT NULL
    )
    OR
    (
      source_type = 'business_document'
      AND job_request_id IS NULL
      AND source_request_selection_id IS NULL
      AND source_request_relationship_id IS NULL
      AND contractor_profile_id IS NOT NULL
      AND originating_business_document_id IS NOT NULL
      AND source_business_customer_job_id IS NULL
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

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname =
      'jobs_business_customer_source_fkey'
      AND conrelid = 'jobs'::regclass
  ) THEN
    ALTER TABLE jobs
      ADD CONSTRAINT
        jobs_business_customer_source_fkey
      FOREIGN KEY (
        source_business_customer_job_id,
        contractor_profile_id,
        business_contact_id,
        business_customer_relationship_id,
        created_by_user_id
      )
      REFERENCES
        business_customer_job_sources(
          id,
          contractor_profile_id,
          business_contact_id,
          business_customer_relationship_id,
          created_by_user_id
        )
      ON DELETE RESTRICT;
  END IF;
END;
$migration$;

CREATE UNIQUE INDEX IF NOT EXISTS
  jobs_business_customer_source_uidx
ON jobs(source_business_customer_job_id)
WHERE source_type = 'business_customer';

CREATE INDEX IF NOT EXISTS
  jobs_business_customer_created_idx
ON jobs(
  contractor_profile_id,
  created_at DESC,
  id
)
WHERE source_type = 'business_customer';

CREATE INDEX IF NOT EXISTS
  jobs_business_customer_contact_idx
ON jobs(
  contractor_profile_id,
  business_contact_id,
  created_at DESC,
  id
)
WHERE source_type = 'business_customer';


-- -------------------------------------------------------------------------
-- Authenticated participant evidence.
-- External customer is NOT a Meetro participant.
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


-- -------------------------------------------------------------------------
-- Customer-party ownership.
-- business_customer requires the exact Job customer tuple.
-- Existing business_document behavior is preserved.
-- -------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION
assert_customer_party_job_business_owner()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM jobs
    LEFT JOIN request_relationships
      ON request_relationships.id =
           jobs.source_request_relationship_id
    WHERE jobs.id = NEW.job_id
      AND (
        (
          jobs.source_type =
            'ordinary_request_selection'
          AND request_relationships.contractor_id =
              NEW.contractor_profile_id
        )
        OR
        (
          jobs.source_type =
            'existing_customer_request'
          AND request_relationships.contractor_id =
              NEW.contractor_profile_id
        )
        OR
        (
          jobs.source_type =
            'business_customer'
          AND jobs.contractor_profile_id =
              NEW.contractor_profile_id
          AND jobs.business_contact_id =
              NEW.business_contact_id
          AND jobs.business_customer_relationship_id =
              NEW.business_customer_relationship_id
        )
        OR
        (
          jobs.source_type =
            'business_document'
          AND jobs.contractor_profile_id =
              NEW.contractor_profile_id
        )
      )
  ) THEN
    RAISE EXCEPTION
      'Customer party business owner does not own the Job.'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;


COMMENT ON TABLE business_customer_job_sources IS
  'Business-owned pre-Quote Job intake identity for an established external Customer Relationship. It creates no Meetro customer, marketplace, Quote, payment, schedule, or completion authority.';

COMMENT ON COLUMN
  jobs.source_business_customer_job_id IS
  'Canonical pre-Quote external-customer Job source for source_type=business_customer. NULL for all other Job origins.';
