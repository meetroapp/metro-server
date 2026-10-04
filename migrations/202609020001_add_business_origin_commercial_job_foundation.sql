-- MC-QUOTE-EXTERNAL-APPROVAL-U1-D1
-- Business-origin commercial Job foundation.
--
-- Adds a legitimate business-document origin alongside the existing
-- marketplace/request-selection Job origin.
--
-- This migration does NOT:
-- - create fake homeowner users
-- - create fake request relationships
-- - create fake customer participants
-- - approve Quotes
-- - create deposits
-- - infer payment
-- - unlock scheduling
--
-- Existing marketplace Jobs remain governed by ordinary_request_selection.

CREATE UNIQUE INDEX IF NOT EXISTS
  business_document_working_drafts_identity_owner_uidx
ON business_document_working_drafts(id, contractor_profile_id);

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS contractor_profile_id INTEGER,
  ADD COLUMN IF NOT EXISTS business_contact_id UUID,
  ADD COLUMN IF NOT EXISTS business_customer_relationship_id UUID,
  ADD COLUMN IF NOT EXISTS originating_business_document_id UUID;

ALTER TABLE jobs
  ALTER COLUMN job_request_id DROP NOT NULL,
  ALTER COLUMN source_request_selection_id DROP NOT NULL,
  ALTER COLUMN source_request_relationship_id DROP NOT NULL;

ALTER TABLE jobs
  DROP CONSTRAINT IF EXISTS jobs_source_type_check;

ALTER TABLE jobs
  ADD CONSTRAINT jobs_source_type_check
  CHECK (
    source_type IN (
      'ordinary_request_selection',
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

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'jobs_business_owner_fkey'
      AND conrelid = 'jobs'::regclass
  ) THEN
    ALTER TABLE jobs
      ADD CONSTRAINT jobs_business_owner_fkey
      FOREIGN KEY (contractor_profile_id, created_by_user_id)
      REFERENCES contractor_profiles(id, user_id)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'jobs_business_contact_owner_fkey'
      AND conrelid = 'jobs'::regclass
  ) THEN
    ALTER TABLE jobs
      ADD CONSTRAINT jobs_business_contact_owner_fkey
      FOREIGN KEY (business_contact_id, contractor_profile_id)
      REFERENCES business_contacts(id, contractor_profile_id)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'jobs_business_customer_relationship_fkey'
      AND conrelid = 'jobs'::regclass
  ) THEN
    ALTER TABLE jobs
      ADD CONSTRAINT jobs_business_customer_relationship_fkey
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
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'jobs_originating_business_document_fkey'
      AND conrelid = 'jobs'::regclass
  ) THEN
    ALTER TABLE jobs
      ADD CONSTRAINT jobs_originating_business_document_fkey
      FOREIGN KEY (
        originating_business_document_id,
        contractor_profile_id
      )
      REFERENCES business_document_working_drafts(
        id,
        contractor_profile_id
      )
      ON DELETE RESTRICT;
  END IF;
END;
$migration$;

CREATE UNIQUE INDEX IF NOT EXISTS jobs_identity_source_type_uidx
ON jobs(id, source_type);

CREATE UNIQUE INDEX IF NOT EXISTS jobs_business_document_source_uidx
ON jobs(originating_business_document_id)
WHERE source_type = 'business_document';

CREATE INDEX IF NOT EXISTS jobs_business_owner_created_idx
ON jobs(contractor_profile_id, created_at DESC, id)
WHERE source_type = 'business_document';

CREATE INDEX IF NOT EXISTS jobs_business_contact_idx
ON jobs(contractor_profile_id, business_contact_id, created_at DESC, id)
WHERE source_type = 'business_document'
  AND business_contact_id IS NOT NULL;


-- ------------------------------------------------------------
-- Authenticated professional participant for a business-origin Job.
--
-- External customers are NOT represented here.
-- A business-origin Job receives only its real authenticated
-- professional participant.
-- ------------------------------------------------------------

ALTER TABLE relationship_participants
  ALTER COLUMN request_relationship_id DROP NOT NULL;

ALTER TABLE relationship_participants
  DROP CONSTRAINT IF EXISTS relationship_participants_source_evidence_type_check;

ALTER TABLE relationship_participants
  ADD CONSTRAINT relationship_participants_source_evidence_type_check
  CHECK (
    source_evidence_type IN (
      'request_selection',
      'business_document'
    )
  );

ALTER TABLE relationship_participants
  DROP CONSTRAINT IF EXISTS relationship_participants_source_shape_check;

ALTER TABLE relationship_participants
  ADD CONSTRAINT relationship_participants_source_shape_check
  CHECK (
    (
      source_evidence_type = 'request_selection'
      AND request_relationship_id IS NOT NULL
    )
    OR
    (
      source_evidence_type = 'business_document'
      AND request_relationship_id IS NULL
    )
  );


-- ------------------------------------------------------------
-- Commercial aggregate origin.
-- ------------------------------------------------------------

ALTER TABLE commercial_authority_aggregates
  ADD COLUMN IF NOT EXISTS business_document_id UUID,
  ADD COLUMN IF NOT EXISTS contractor_profile_id INTEGER;

ALTER TABLE commercial_authority_aggregates
  DROP CONSTRAINT IF EXISTS commercial_authority_aggregates_source_context_type_check;

ALTER TABLE commercial_authority_aggregates
  ADD CONSTRAINT commercial_authority_aggregates_source_context_type_check
  CHECK (
    source_context_type IN (
      'ordinary_request',
      'emergency_request',
      'business_document'
    )
  );

ALTER TABLE commercial_authority_aggregates
  DROP CONSTRAINT IF EXISTS commercial_authority_aggregate_source_check;

ALTER TABLE commercial_authority_aggregates
  ADD CONSTRAINT commercial_authority_aggregate_source_check
  CHECK (
    (
      source_context_type = 'ordinary_request'
      AND ordinary_request_id IS NOT NULL
      AND emergency_request_id IS NULL
      AND business_document_id IS NULL
      AND contractor_profile_id IS NULL
    )
    OR
    (
      source_context_type = 'emergency_request'
      AND ordinary_request_id IS NULL
      AND emergency_request_id IS NOT NULL
      AND business_document_id IS NULL
      AND contractor_profile_id IS NULL
    )
    OR
    (
      source_context_type = 'business_document'
      AND ordinary_request_id IS NULL
      AND emergency_request_id IS NULL
      AND relationship_id IS NULL
      AND business_document_id IS NOT NULL
      AND contractor_profile_id IS NOT NULL
    )
  );

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'commercial_authority_aggregate_business_document_fkey'
      AND conrelid = 'commercial_authority_aggregates'::regclass
  ) THEN
    ALTER TABLE commercial_authority_aggregates
      ADD CONSTRAINT commercial_authority_aggregate_business_document_fkey
      FOREIGN KEY (business_document_id, contractor_profile_id)
      REFERENCES business_document_working_drafts(
        id,
        contractor_profile_id
      )
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'commercial_authority_aggregate_business_owner_fkey'
      AND conrelid = 'commercial_authority_aggregates'::regclass
  ) THEN
    ALTER TABLE commercial_authority_aggregates
      ADD CONSTRAINT commercial_authority_aggregate_business_owner_fkey
      FOREIGN KEY (contractor_profile_id, source_owner_user_id)
      REFERENCES contractor_profiles(id, user_id)
      ON DELETE RESTRICT;
  END IF;
END;
$migration$;

CREATE UNIQUE INDEX IF NOT EXISTS
  commercial_authority_aggregate_identity_context_uidx
ON commercial_authority_aggregates(
  id,
  aggregate_type,
  owning_engine,
  source_context_type
);

CREATE INDEX IF NOT EXISTS commercial_authority_aggregate_business_document_idx
ON commercial_authority_aggregates(
  contractor_profile_id,
  business_document_id,
  aggregate_type,
  created_at ASC,
  id ASC
)
WHERE source_context_type = 'business_document';


-- ------------------------------------------------------------
-- Canonical Quote origin.
--
-- Existing ordinary-request Quote identity remains intact.
-- Business-document Quotes have no marketplace request/relationship IDs.
-- ------------------------------------------------------------

ALTER TABLE canonical_quotes
  ADD COLUMN IF NOT EXISTS source_context_type TEXT
    NOT NULL DEFAULT 'ordinary_request',
  ADD COLUMN IF NOT EXISTS job_source_type TEXT
    NOT NULL DEFAULT 'ordinary_request_selection';

ALTER TABLE canonical_quotes
  ALTER COLUMN job_request_id DROP NOT NULL,
  ALTER COLUMN relationship_id DROP NOT NULL;

ALTER TABLE canonical_quotes
  DROP CONSTRAINT IF EXISTS canonical_quote_source_shape_check;

ALTER TABLE canonical_quotes
  ADD CONSTRAINT canonical_quote_source_shape_check
  CHECK (
    (
      source_context_type = 'ordinary_request'
      AND job_source_type = 'ordinary_request_selection'
      AND job_request_id IS NOT NULL
      AND relationship_id IS NOT NULL
    )
    OR
    (
      source_context_type = 'business_document'
      AND job_source_type = 'business_document'
      AND job_request_id IS NULL
      AND relationship_id IS NULL
    )
  );

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'canonical_quote_generic_job_fkey'
      AND conrelid = 'canonical_quotes'::regclass
  ) THEN
    ALTER TABLE canonical_quotes
      ADD CONSTRAINT canonical_quote_generic_job_fkey
      FOREIGN KEY (job_id)
      REFERENCES jobs(id)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'canonical_quote_job_source_fkey'
      AND conrelid = 'canonical_quotes'::regclass
  ) THEN
    ALTER TABLE canonical_quotes
      ADD CONSTRAINT canonical_quote_job_source_fkey
      FOREIGN KEY (job_id, job_source_type)
      REFERENCES jobs(id, source_type)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'canonical_quote_aggregate_context_fkey'
      AND conrelid = 'canonical_quotes'::regclass
  ) THEN
    ALTER TABLE canonical_quotes
      ADD CONSTRAINT canonical_quote_aggregate_context_fkey
      FOREIGN KEY (
        id,
        aggregate_type,
        owning_engine,
        source_context_type
      )
      REFERENCES commercial_authority_aggregates(
        id,
        aggregate_type,
        owning_engine,
        source_context_type
      )
      ON DELETE RESTRICT;
  END IF;
END;
$migration$;

CREATE OR REPLACE FUNCTION prevent_canonical_quote_origin_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.source_context_type IS DISTINCT FROM OLD.source_context_type
     OR NEW.job_source_type IS DISTINCT FROM OLD.job_source_type THEN
    RAISE EXCEPTION 'canonical Quote origin is immutable'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS canonical_quote_origin_immutable
ON canonical_quotes;

CREATE TRIGGER canonical_quote_origin_immutable
BEFORE UPDATE ON canonical_quotes
FOR EACH ROW
EXECUTE FUNCTION prevent_canonical_quote_origin_mutation();


-- ------------------------------------------------------------
-- Customer-party ownership guard.
--
-- Marketplace Jobs continue proving ownership through request_relationships.
-- Business-origin Jobs prove ownership directly through contractor_profile_id.
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION assert_customer_party_job_business_owner()
RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM jobs
    LEFT JOIN request_relationships
      ON request_relationships.id = jobs.source_request_relationship_id
    WHERE jobs.id = NEW.job_id
      AND (
        (
          jobs.source_type = 'ordinary_request_selection'
          AND request_relationships.contractor_id =
            NEW.contractor_profile_id
        )
        OR
        (
          jobs.source_type = 'business_document'
          AND jobs.contractor_profile_id =
            NEW.contractor_profile_id
        )
      )
  ) THEN
    RAISE EXCEPTION 'Customer party business owner does not own the Job.'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;


COMMENT ON COLUMN jobs.contractor_profile_id IS
  'Owning Business for source_type=business_document; NULL for marketplace Jobs.';

COMMENT ON COLUMN jobs.business_contact_id IS
  'Optional reusable business-owned customer Contact for a business-origin Job. NULL permits document-only customer identity.';

COMMENT ON COLUMN jobs.business_customer_relationship_id IS
  'Optional durable business Customer Relationship paired with business_contact_id.';

COMMENT ON COLUMN jobs.originating_business_document_id IS
  'Working business document that canonically originated a source_type=business_document Job.';

COMMENT ON COLUMN commercial_authority_aggregates.business_document_id IS
  'Business working document source for source_context_type=business_document.';

COMMENT ON COLUMN canonical_quotes.source_context_type IS
  'Canonical Quote source context. Existing marketplace Quotes use ordinary_request; external Quick Quote may use business_document.';

COMMENT ON COLUMN canonical_quotes.job_source_type IS
  'Immutable mirror of the owning Job source_type used to preserve origin integrity.';
