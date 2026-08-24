-- MC-CUSTOMER-PARTY-001A: additive durable customer-party linkage.
-- Links canonical work to an existing business-owned Contact and Customer
-- Relationship without copying mutable Contact identity or changing lifecycle.

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'business_customer_relationships_party_owner_key'
      AND conrelid = 'business_customer_relationships'::regclass
  ) THEN
    ALTER TABLE business_customer_relationships
      ADD CONSTRAINT business_customer_relationships_party_owner_key
      UNIQUE (id, contractor_profile_id, business_contact_id);
  END IF;
END;
$migration$;

ALTER TABLE business_document_working_drafts
  ADD COLUMN IF NOT EXISTS business_contact_id UUID,
  ADD COLUMN IF NOT EXISTS business_customer_relationship_id UUID;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'business_document_working_drafts_customer_party_shape_check'
      AND conrelid = 'business_document_working_drafts'::regclass
  ) THEN
    ALTER TABLE business_document_working_drafts
      ADD CONSTRAINT business_document_working_drafts_customer_party_shape_check
      CHECK (
        (business_contact_id IS NULL AND business_customer_relationship_id IS NULL)
        OR
        (business_contact_id IS NOT NULL AND business_customer_relationship_id IS NOT NULL)
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'business_document_working_drafts_contact_owner_fkey'
      AND conrelid = 'business_document_working_drafts'::regclass
  ) THEN
    ALTER TABLE business_document_working_drafts
      ADD CONSTRAINT business_document_working_drafts_contact_owner_fkey
      FOREIGN KEY (business_contact_id, contractor_profile_id)
      REFERENCES business_contacts(id, contractor_profile_id)
      ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'business_document_working_drafts_relationship_party_fkey'
      AND conrelid = 'business_document_working_drafts'::regclass
  ) THEN
    ALTER TABLE business_document_working_drafts
      ADD CONSTRAINT business_document_working_drafts_relationship_party_fkey
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
END;
$migration$;

CREATE INDEX IF NOT EXISTS business_document_working_drafts_contact_idx
  ON business_document_working_drafts(
    contractor_profile_id,
    business_contact_id,
    updated_at DESC,
    id
  )
  WHERE business_contact_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS job_customer_parties (
  job_id UUID PRIMARY KEY REFERENCES jobs(id) ON DELETE RESTRICT,
  contractor_profile_id INTEGER NOT NULL,
  business_contact_id UUID NOT NULL,
  business_customer_relationship_id UUID NOT NULL,
  linked_by_user_id INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT job_customer_parties_contact_owner_fkey
    FOREIGN KEY (business_contact_id, contractor_profile_id)
    REFERENCES business_contacts(id, contractor_profile_id)
    ON DELETE RESTRICT,
  CONSTRAINT job_customer_parties_relationship_party_fkey
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
  CONSTRAINT job_customer_parties_actor_owner_fkey
    FOREIGN KEY (contractor_profile_id, linked_by_user_id)
    REFERENCES contractor_profiles(id, user_id)
    ON DELETE RESTRICT,
  CONSTRAINT job_customer_parties_job_owner_key
    UNIQUE (job_id, contractor_profile_id)
);

CREATE INDEX IF NOT EXISTS job_customer_parties_contact_idx
  ON job_customer_parties(
    contractor_profile_id,
    business_contact_id,
    created_at DESC,
    job_id
  );

CREATE TABLE IF NOT EXISTS job_customer_party_commands (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_profile_id INTEGER NOT NULL,
  actor_user_id INTEGER NOT NULL,
  operation TEXT NOT NULL CHECK (operation = 'LINK'),
  idempotency_key UUID NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  business_contact_id UUID NOT NULL,
  business_customer_relationship_id UUID NOT NULL,
  response_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ,

  CONSTRAINT job_customer_party_commands_actor_owner_fkey
    FOREIGN KEY (contractor_profile_id, actor_user_id)
    REFERENCES contractor_profiles(id, user_id)
    ON DELETE RESTRICT,
  CONSTRAINT job_customer_party_commands_contact_owner_fkey
    FOREIGN KEY (business_contact_id, contractor_profile_id)
    REFERENCES business_contacts(id, contractor_profile_id)
    ON DELETE RESTRICT,
  CONSTRAINT job_customer_party_commands_relationship_party_fkey
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
  CONSTRAINT job_customer_party_commands_actor_operation_key
    UNIQUE (actor_user_id, operation, idempotency_key)
);

CREATE TABLE IF NOT EXISTS canonical_quote_customer_parties (
  quote_id UUID PRIMARY KEY,
  job_id UUID NOT NULL,
  contractor_profile_id INTEGER NOT NULL,
  business_contact_id UUID NOT NULL,
  business_customer_relationship_id UUID NOT NULL,
  linked_by_user_id INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT canonical_quote_customer_parties_quote_fkey
    FOREIGN KEY (quote_id, job_id)
    REFERENCES canonical_quotes(id, job_id)
    ON DELETE RESTRICT,
  CONSTRAINT canonical_quote_customer_parties_contact_owner_fkey
    FOREIGN KEY (business_contact_id, contractor_profile_id)
    REFERENCES business_contacts(id, contractor_profile_id)
    ON DELETE RESTRICT,
  CONSTRAINT canonical_quote_customer_parties_relationship_party_fkey
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
  CONSTRAINT canonical_quote_customer_parties_actor_owner_fkey
    FOREIGN KEY (contractor_profile_id, linked_by_user_id)
    REFERENCES contractor_profiles(id, user_id)
    ON DELETE RESTRICT,
  CONSTRAINT canonical_quote_customer_parties_job_owner_key
    UNIQUE (quote_id, job_id, contractor_profile_id)
);

CREATE INDEX IF NOT EXISTS canonical_quote_customer_parties_contact_idx
  ON canonical_quote_customer_parties(
    contractor_profile_id,
    business_contact_id,
    created_at DESC,
    quote_id
  );

CREATE TABLE IF NOT EXISTS canonical_invoice_customer_parties (
  invoice_id UUID PRIMARY KEY,
  job_id UUID NOT NULL,
  contractor_profile_id INTEGER NOT NULL,
  business_contact_id UUID NOT NULL,
  business_customer_relationship_id UUID NOT NULL,
  linked_by_user_id INTEGER NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('JOB', 'CANONICAL_QUOTE')),
  source_quote_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT canonical_invoice_customer_parties_invoice_fkey
    FOREIGN KEY (invoice_id, job_id)
    REFERENCES canonical_invoices(id, job_id)
    ON DELETE RESTRICT,
  CONSTRAINT canonical_invoice_customer_parties_contact_owner_fkey
    FOREIGN KEY (business_contact_id, contractor_profile_id)
    REFERENCES business_contacts(id, contractor_profile_id)
    ON DELETE RESTRICT,
  CONSTRAINT canonical_invoice_customer_parties_relationship_party_fkey
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
  CONSTRAINT canonical_invoice_customer_parties_actor_owner_fkey
    FOREIGN KEY (contractor_profile_id, linked_by_user_id)
    REFERENCES contractor_profiles(id, user_id)
    ON DELETE RESTRICT,
  CONSTRAINT canonical_invoice_customer_parties_source_quote_fkey
    FOREIGN KEY (source_quote_id, job_id)
    REFERENCES canonical_quotes(id, job_id)
    ON DELETE RESTRICT,
  CONSTRAINT canonical_invoice_customer_parties_source_shape_check
    CHECK (
      (source_type = 'JOB' AND source_quote_id IS NULL)
      OR
      (source_type = 'CANONICAL_QUOTE' AND source_quote_id IS NOT NULL)
    ),
  CONSTRAINT canonical_invoice_customer_parties_job_owner_key
    UNIQUE (invoice_id, job_id, contractor_profile_id)
);

CREATE INDEX IF NOT EXISTS canonical_invoice_customer_parties_contact_idx
  ON canonical_invoice_customer_parties(
    contractor_profile_id,
    business_contact_id,
    created_at DESC,
    invoice_id
  );

CREATE OR REPLACE FUNCTION assert_customer_party_job_business_owner()
RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM jobs
    INNER JOIN request_relationships
      ON request_relationships.id = jobs.source_request_relationship_id
    WHERE jobs.id = NEW.job_id
      AND request_relationships.contractor_id = NEW.contractor_profile_id
  ) THEN
    RAISE EXCEPTION 'Customer party business owner does not own the Job.'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION prevent_customer_party_link_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Canonical customer party links are append-only.'
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER job_customer_parties_owner_guard
BEFORE INSERT OR UPDATE ON job_customer_parties
FOR EACH ROW EXECUTE FUNCTION assert_customer_party_job_business_owner();

CREATE TRIGGER canonical_quote_customer_parties_owner_guard
BEFORE INSERT OR UPDATE ON canonical_quote_customer_parties
FOR EACH ROW EXECUTE FUNCTION assert_customer_party_job_business_owner();

CREATE TRIGGER canonical_invoice_customer_parties_owner_guard
BEFORE INSERT OR UPDATE ON canonical_invoice_customer_parties
FOR EACH ROW EXECUTE FUNCTION assert_customer_party_job_business_owner();

CREATE TRIGGER job_customer_parties_append_only
BEFORE UPDATE OR DELETE ON job_customer_parties
FOR EACH ROW EXECUTE FUNCTION prevent_customer_party_link_mutation();

CREATE TRIGGER canonical_quote_customer_parties_append_only
BEFORE UPDATE OR DELETE ON canonical_quote_customer_parties
FOR EACH ROW EXECUTE FUNCTION prevent_customer_party_link_mutation();

CREATE TRIGGER canonical_invoice_customer_parties_append_only
BEFORE UPDATE OR DELETE ON canonical_invoice_customer_parties
FOR EACH ROW EXECUTE FUNCTION prevent_customer_party_link_mutation();

COMMENT ON TABLE job_customer_parties IS
  'Immutable durable customer identity linkage for the canonical Job. It grants no participant, lifecycle, scheduling, commercial, or communication authority.';
COMMENT ON TABLE canonical_quote_customer_parties IS
  'Immutable durable customer identity linkage for a canonical Quote. Quote versions and customer-facing snapshots remain independent.';
COMMENT ON TABLE canonical_invoice_customer_parties IS
  'Immutable durable customer identity linkage for a canonical Invoice. Invoice versions, payment state, and customer-facing snapshots remain independent.';
COMMENT ON COLUMN business_document_working_drafts.business_contact_id IS
  'Optional explicit durable Contact linkage; content remains the mutable document customer snapshot.';

