CREATE TABLE IF NOT EXISTS business_document_number_sequences (
  contractor_profile_id INTEGER NOT NULL,
  document_type TEXT NOT NULL
    CHECK (document_type IN ('QUOTE', 'INVOICE')),
  number_prefix TEXT NOT NULL
    CHECK (number_prefix ~ '^[A-Z]{1,8}$'),
  number_width SMALLINT NOT NULL
    CHECK (number_width BETWEEN 1 AND 12),
  initial_last_number BIGINT NOT NULL
    CHECK (
      initial_last_number >= 0
      AND initial_last_number <= 999999999999
    ),
  last_number BIGINT NOT NULL
    CHECK (
      last_number >= initial_last_number
      AND last_number <= 999999999999
    ),
  initialization_mode TEXT NOT NULL
    CHECK (initialization_mode IN ('START_NEW', 'CONTINUE_EXISTING')),
  initialization_source TEXT NOT NULL
    CHECK (initialization_source = 'PROFESSIONAL_EXPLICIT'),
  initialized_by_user_id INTEGER NOT NULL,
  initialized_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  first_allocated_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (contractor_profile_id, document_type),
  CONSTRAINT business_document_number_sequences_owner_fkey
    FOREIGN KEY (contractor_profile_id, initialized_by_user_id)
    REFERENCES contractor_profiles(id, user_id)
    ON DELETE RESTRICT
);

ALTER TABLE business_document_working_drafts
  ADD COLUMN IF NOT EXISTS document_number TEXT
  CHECK (
    document_number IS NULL
    OR document_number ~ '^[A-Z]{1,8}-[0-9]{1,12}$'
  );

CREATE UNIQUE INDEX IF NOT EXISTS business_document_working_drafts_number_idx
  ON business_document_working_drafts (
    contractor_profile_id,
    document_type,
    document_number
  )
  WHERE document_number IS NOT NULL;

CREATE OR REPLACE FUNCTION preserve_business_document_number()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.document_number IS NOT NULL
     AND NEW.document_number IS DISTINCT FROM OLD.document_number THEN
    RAISE EXCEPTION 'business-document number is immutable once assigned'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'preserve_business_document_number_trigger'
      AND tgrelid = 'business_document_working_drafts'::regclass
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER preserve_business_document_number_trigger
    BEFORE UPDATE OF document_number ON business_document_working_drafts
    FOR EACH ROW
    EXECUTE FUNCTION preserve_business_document_number();
  END IF;
END;
$migration$;

COMMENT ON TABLE business_document_number_sequences IS
  'Explicit, auditable per-business Quote and Invoice number configuration and allocation. It grants no issuance, approval, payment, or lifecycle authority.';
COMMENT ON COLUMN business_document_working_drafts.document_number IS
  'Nullable legacy-safe, immutable once assigned, server-owned business-facing number. Internal draft_reference remains separate.';
