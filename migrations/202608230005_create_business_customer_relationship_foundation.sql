-- MC-RELATIONSHIP-001A: durable business-owned customer continuity.
-- Customer Relationships reference Business Contacts without duplicating Contact
-- identity or granting Job, Quote, payment, Conversation, or lifecycle authority.

CREATE TABLE IF NOT EXISTS business_customer_relationships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_profile_id INTEGER NOT NULL,
  business_contact_id UUID NOT NULL,
  established_by_user_id INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT business_customer_relationships_contact_owner_fkey
    FOREIGN KEY (business_contact_id, contractor_profile_id)
    REFERENCES business_contacts(id, contractor_profile_id)
    ON DELETE RESTRICT,
  CONSTRAINT business_customer_relationships_establisher_owner_fkey
    FOREIGN KEY (contractor_profile_id, established_by_user_id)
    REFERENCES contractor_profiles(id, user_id)
    ON DELETE RESTRICT,
  CONSTRAINT business_customer_relationships_owner_contact_key
    UNIQUE (contractor_profile_id, business_contact_id),
  CONSTRAINT business_customer_relationships_identity_owner_key
    UNIQUE (id, contractor_profile_id)
);

CREATE INDEX IF NOT EXISTS business_customer_relationships_owner_created_idx
  ON business_customer_relationships(contractor_profile_id, created_at DESC, id);

CREATE TABLE IF NOT EXISTS business_customer_relationship_commands (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_profile_id INTEGER NOT NULL,
  actor_user_id INTEGER NOT NULL,
  operation TEXT NOT NULL CHECK (operation = 'ESTABLISH'),
  idempotency_key UUID NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  business_contact_id UUID NOT NULL,
  business_customer_relationship_id UUID NULL,
  response_json JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ NULL,

  CONSTRAINT business_customer_relationship_commands_actor_owner_fkey
    FOREIGN KEY (contractor_profile_id, actor_user_id)
    REFERENCES contractor_profiles(id, user_id)
    ON DELETE RESTRICT,
  CONSTRAINT business_customer_relationship_commands_contact_owner_fkey
    FOREIGN KEY (business_contact_id, contractor_profile_id)
    REFERENCES business_contacts(id, contractor_profile_id)
    ON DELETE RESTRICT,
  CONSTRAINT business_customer_relationship_commands_relationship_owner_fkey
    FOREIGN KEY (business_customer_relationship_id, contractor_profile_id)
    REFERENCES business_customer_relationships(id, contractor_profile_id)
    ON DELETE RESTRICT,
  CONSTRAINT business_customer_relationship_commands_actor_operation_key
    UNIQUE (actor_user_id, operation, idempotency_key)
);

CREATE INDEX IF NOT EXISTS business_customer_relationship_commands_contact_idx
  ON business_customer_relationship_commands(
    contractor_profile_id,
    business_contact_id,
    created_at DESC
  );

CREATE OR REPLACE FUNCTION guard_business_customer_relationship_history()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Customer Relationship history cannot be deleted.'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.contractor_profile_id IS DISTINCT FROM OLD.contractor_profile_id
     OR NEW.business_contact_id IS DISTINCT FROM OLD.business_contact_id
     OR NEW.established_by_user_id IS DISTINCT FROM OLD.established_by_user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Customer Relationship identity and ownership are immutable.'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'Customer Relationship updates require the next version.'
      USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER business_customer_relationships_history_guard
BEFORE UPDATE OR DELETE ON business_customer_relationships
FOR EACH ROW EXECUTE FUNCTION guard_business_customer_relationship_history();

COMMENT ON TABLE business_customer_relationships IS
  'Durable business-owned continuity for one Business Contact. No Meetro account, marketplace request, Conversation, Job, Quote, Invoice, payment, scheduling, or lifecycle authority is implied.';
COMMENT ON TABLE business_customer_relationship_commands IS
  'Idempotent explicit Customer Relationship establishment ledger; not Contact, marketplace, commercial, communication, or lifecycle authority.';
