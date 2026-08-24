-- MC-CONTACT-001A: durable business-owned Contact identity and classification.
-- Contacts are private business records. They create no authenticated identity,
-- relationship participant, Conversation, Job, financial, or lifecycle authority.

CREATE TABLE IF NOT EXISTS business_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_profile_id INTEGER NOT NULL,
  created_by_user_id INTEGER NOT NULL,
  party_type TEXT NOT NULL CHECK (party_type IN ('PERSON', 'ORGANIZATION')),
  display_name TEXT NOT NULL
    CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 240),
  company_name TEXT NULL
    CHECK (company_name IS NULL OR char_length(btrim(company_name)) BETWEEN 1 AND 240),
  email TEXT NULL
    CHECK (email IS NULL OR char_length(btrim(email)) BETWEEN 3 AND 320),
  phone TEXT NULL
    CHECK (phone IS NULL OR char_length(btrim(phone)) BETWEEN 1 AND 80),
  address_text TEXT NULL
    CHECK (address_text IS NULL OR char_length(btrim(address_text)) BETWEEN 1 AND 600),
  service_area_text TEXT NULL
    CHECK (service_area_text IS NULL OR char_length(btrim(service_area_text)) BETWEEN 1 AND 600),
  private_note TEXT NULL
    CHECK (private_note IS NULL OR char_length(btrim(private_note)) BETWEEN 1 AND 8000),
  email_normalized TEXT GENERATED ALWAYS AS (
    CASE WHEN email IS NULL THEN NULL ELSE lower(btrim(email)) END
  ) STORED,
  phone_normalized TEXT GENERATED ALWAYS AS (
    NULLIF(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), '')
  ) STORED,
  status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT business_contacts_owner_fkey
    FOREIGN KEY (contractor_profile_id, created_by_user_id)
    REFERENCES contractor_profiles(id, user_id)
    ON DELETE RESTRICT,
  CONSTRAINT business_contacts_identity_owner_key
    UNIQUE (id, contractor_profile_id)
);

CREATE INDEX IF NOT EXISTS business_contacts_owner_status_name_idx
  ON business_contacts(contractor_profile_id, status, lower(display_name), id);
CREATE INDEX IF NOT EXISTS business_contacts_owner_email_candidate_idx
  ON business_contacts(contractor_profile_id, email_normalized)
  WHERE email_normalized IS NOT NULL;
CREATE INDEX IF NOT EXISTS business_contacts_owner_phone_candidate_idx
  ON business_contacts(contractor_profile_id, phone_normalized)
  WHERE phone_normalized IS NOT NULL;

CREATE TABLE IF NOT EXISTS business_contact_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_contact_id UUID NOT NULL,
  contractor_profile_id INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN (
    'CUSTOMER',
    'PROFESSIONAL_VENDOR',
    'EMPLOYEE',
    'TENANT',
    'PROPERTY_MANAGER'
  )),
  assigned_by_user_id INTEGER NOT NULL,
  assignment_source TEXT NOT NULL DEFAULT 'PROFESSIONAL_EXPLICIT'
    CHECK (assignment_source IN ('PROFESSIONAL_EXPLICIT', 'GOVERNED_IMPORT')),
  source_reference TEXT NULL
    CHECK (source_reference IS NULL OR char_length(btrim(source_reference)) BETWEEN 1 AND 500),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at TIMESTAMPTZ NULL,
  ended_by_user_id INTEGER NULL,
  ending_source TEXT NULL
    CHECK (ending_source IS NULL OR ending_source = 'PROFESSIONAL_EXPLICIT'),
  end_source_reference TEXT NULL
    CHECK (end_source_reference IS NULL OR char_length(btrim(end_source_reference)) BETWEEN 1 AND 500),

  CONSTRAINT business_contact_roles_contact_owner_fkey
    FOREIGN KEY (business_contact_id, contractor_profile_id)
    REFERENCES business_contacts(id, contractor_profile_id)
    ON DELETE RESTRICT,
  CONSTRAINT business_contact_roles_assigner_owner_fkey
    FOREIGN KEY (contractor_profile_id, assigned_by_user_id)
    REFERENCES contractor_profiles(id, user_id)
    ON DELETE RESTRICT,
  CONSTRAINT business_contact_roles_ender_owner_fkey
    FOREIGN KEY (contractor_profile_id, ended_by_user_id)
    REFERENCES contractor_profiles(id, user_id)
    ON DELETE RESTRICT,
  CONSTRAINT business_contact_roles_end_state_check CHECK (
    (ended_at IS NULL AND ended_by_user_id IS NULL AND ending_source IS NULL AND end_source_reference IS NULL)
    OR
    (ended_at IS NOT NULL AND ended_by_user_id IS NOT NULL AND ending_source IS NOT NULL)
  ),
  CONSTRAINT business_contact_roles_identity_owner_key
    UNIQUE (id, business_contact_id, contractor_profile_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS business_contact_roles_one_active_role_idx
  ON business_contact_roles(business_contact_id, role)
  WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS business_contact_roles_owner_role_idx
  ON business_contact_roles(contractor_profile_id, role, assigned_at DESC, id);

CREATE TABLE IF NOT EXISTS business_contact_commands (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_profile_id INTEGER NOT NULL,
  actor_user_id INTEGER NOT NULL,
  operation TEXT NOT NULL
    CHECK (operation IN ('CREATE', 'UPDATE', 'ASSIGN_ROLE', 'END_ROLE', 'ARCHIVE')),
  idempotency_key UUID NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  business_contact_id UUID NULL,
  response_json JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ NULL,

  CONSTRAINT business_contact_commands_actor_owner_fkey
    FOREIGN KEY (contractor_profile_id, actor_user_id)
    REFERENCES contractor_profiles(id, user_id)
    ON DELETE RESTRICT,
  CONSTRAINT business_contact_commands_contact_owner_fkey
    FOREIGN KEY (business_contact_id, contractor_profile_id)
    REFERENCES business_contacts(id, contractor_profile_id)
    ON DELETE RESTRICT,
  CONSTRAINT business_contact_commands_actor_operation_key
    UNIQUE (actor_user_id, operation, idempotency_key)
);

CREATE INDEX IF NOT EXISTS business_contact_commands_contact_idx
  ON business_contact_commands(business_contact_id, created_at DESC)
  WHERE business_contact_id IS NOT NULL;

CREATE OR REPLACE FUNCTION guard_business_contact_history()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Business Contact identity is archived, not deleted.'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.contractor_profile_id IS DISTINCT FROM OLD.contractor_profile_id
     OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Business Contact identity and ownership are immutable.'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'ARCHIVED'
     OR (OLD.status = 'ACTIVE' AND NEW.status NOT IN ('ACTIVE', 'ARCHIVED')) THEN
    RAISE EXCEPTION 'Business Contact status transition is invalid.'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'Business Contact updates require the next version.'
      USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER business_contacts_history_guard
BEFORE UPDATE OR DELETE ON business_contacts
FOR EACH ROW EXECUTE FUNCTION guard_business_contact_history();

CREATE OR REPLACE FUNCTION guard_business_contact_role_history()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Business Contact role history cannot be deleted.'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.ended_at IS NOT NULL
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.business_contact_id IS DISTINCT FROM OLD.business_contact_id
     OR NEW.contractor_profile_id IS DISTINCT FROM OLD.contractor_profile_id
     OR NEW.role IS DISTINCT FROM OLD.role
     OR NEW.assigned_by_user_id IS DISTINCT FROM OLD.assigned_by_user_id
     OR NEW.assignment_source IS DISTINCT FROM OLD.assignment_source
     OR NEW.source_reference IS DISTINCT FROM OLD.source_reference
     OR NEW.assigned_at IS DISTINCT FROM OLD.assigned_at
     OR NEW.ended_at IS NULL
     OR NEW.ended_by_user_id IS NULL
     OR NEW.ending_source IS NULL THEN
    RAISE EXCEPTION 'Business Contact roles are append-only except for one governed end transition.'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER business_contact_roles_history_guard
BEFORE UPDATE OR DELETE ON business_contact_roles
FOR EACH ROW EXECUTE FUNCTION guard_business_contact_role_history();

COMMENT ON TABLE business_contacts IS
  'Private business-owned Contact identities. No Meetro user, participant, Conversation, Job, Quote, payment, scheduling, or lifecycle authority is implied.';
COMMENT ON COLUMN business_contacts.private_note IS
  'Business-private note; never automatically projected into customer-facing documents, Conversations, Moments, or public relationship context.';
COMMENT ON TABLE business_contact_roles IS
  'Business classification history only. Roles grant no authenticated or lifecycle authority.';
COMMENT ON TABLE business_contact_commands IS
  'Idempotent business Contact mutation ledger; not commercial or lifecycle authority.';
