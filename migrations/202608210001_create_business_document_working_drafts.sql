CREATE TABLE IF NOT EXISTS business_document_working_drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_profile_id INTEGER NOT NULL REFERENCES contractor_profiles(id) ON DELETE CASCADE,
  created_by_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  job_id UUID NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  document_type TEXT NOT NULL CHECK (document_type IN ('QUOTE', 'INVOICE')),
  draft_status TEXT NOT NULL DEFAULT 'WORKING_DRAFT'
    CHECK (draft_status = 'WORKING_DRAFT'),
  draft_reference TEXT NOT NULL UNIQUE,
  content JSONB NOT NULL DEFAULT '{}'::jsonb,
  workspace_context JSONB NOT NULL DEFAULT '{}'::jsonb,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS business_document_working_drafts_owner_updated_idx
  ON business_document_working_drafts (contractor_profile_id, updated_at DESC, id);

CREATE INDEX IF NOT EXISTS business_document_working_drafts_job_idx
  ON business_document_working_drafts (job_id, updated_at DESC)
  WHERE job_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS business_document_working_drafts_type_idx
  ON business_document_working_drafts (contractor_profile_id, document_type, updated_at DESC);

CREATE TABLE IF NOT EXISTS business_document_draft_media (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_draft_id UUID NOT NULL
    REFERENCES business_document_working_drafts(id) ON DELETE CASCADE,
  contractor_profile_id INTEGER NOT NULL REFERENCES contractor_profiles(id) ON DELETE CASCADE,
  uploaded_by_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  public_id TEXT NOT NULL,
  media JSONB NOT NULL,
  role TEXT NOT NULL DEFAULT 'UNCLASSIFIED'
    CHECK (role IN ('UNCLASSIFIED', 'GENERAL_EVIDENCE', 'BEFORE', 'AFTER')),
  visibility TEXT NOT NULL DEFAULT 'PRIVATE_INTERNAL'
    CHECK (visibility IN ('PRIVATE_INTERNAL', 'CUSTOMER_VISIBLE')),
  display_order INTEGER NOT NULL DEFAULT 0 CHECK (display_order >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (document_draft_id, public_id)
);

CREATE INDEX IF NOT EXISTS business_document_draft_media_document_idx
  ON business_document_draft_media (document_draft_id, display_order, id);

CREATE TABLE IF NOT EXISTS business_document_draft_commands (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation TEXT NOT NULL CHECK (operation IN ('CREATE', 'UPDATE')),
  idempotency_key UUID NOT NULL,
  request_hash TEXT NOT NULL CHECK (char_length(request_hash) = 64),
  document_draft_id UUID NULL
    REFERENCES business_document_working_drafts(id) ON DELETE CASCADE,
  response_json JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ NULL,
  UNIQUE (actor_user_id, operation, idempotency_key)
);

CREATE INDEX IF NOT EXISTS business_document_draft_commands_document_idx
  ON business_document_draft_commands (document_draft_id)
  WHERE document_draft_id IS NOT NULL;

COMMENT ON TABLE business_document_working_drafts IS
  'Private, resumable business-document working drafts. Rows are noncanonical and never imply Quote or Invoice issuance.';
COMMENT ON COLUMN business_document_working_drafts.draft_status IS
  'WORKING_DRAFT only; not canonical Quote/Invoice lifecycle authority.';
COMMENT ON TABLE business_document_draft_media IS
  'Durable governed media associations. Role and customer visibility are independent.';
COMMENT ON TABLE business_document_draft_commands IS
  'Create/update idempotency and exact response replay for private working drafts.';
