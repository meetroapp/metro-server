-- R1B: bind one exact numbered, noncanonical working Quote version to one
-- canonical Draft Quote. This provenance grants no issuance, acceptance,
-- delivery, payment, scheduling, or Job lifecycle authority.

ALTER TABLE commercial_command_idempotency
  DROP CONSTRAINT IF EXISTS commercial_command_idempotency_command_name_check;

ALTER TABLE commercial_command_idempotency
  ADD CONSTRAINT commercial_command_idempotency_command_name_check
  CHECK (
    command_name IN (
      'commercial.aggregate.create',
      'commercial.aggregate.version.advance',
      'evaluation.create',
      'evaluation.draft.update',
      'evaluation.complete',
      'finding.submit',
      'finding.update',
      'finding.concern.link',
      'finding.evidence.add',
      'finding.confirm',
      'quote.draft.create',
      'quote.draft.import_business_document',
      'quote.scope.add',
      'quote.scope.remove',
      'quote.issue',
      'quote.customer.approve',
      'quote.customer.decline',
      'quote.revision.create'
    )
  );

ALTER TABLE commercial_authority_evidence
  DROP CONSTRAINT IF EXISTS commercial_authority_evidence_source_command_check;

ALTER TABLE commercial_authority_evidence
  ADD CONSTRAINT commercial_authority_evidence_source_command_check
  CHECK (
    source_command IN (
      'commercial.aggregate.create',
      'commercial.aggregate.version.advance',
      'evaluation.create',
      'evaluation.draft.update',
      'evaluation.complete',
      'quote.draft.create',
      'quote.draft.import_business_document',
      'quote.scope.add',
      'quote.scope.remove',
      'quote.issue',
      'quote.revision.create'
    )
  );

CREATE TABLE IF NOT EXISTS canonical_quote_business_document_sources (
  quote_id UUID PRIMARY KEY,
  job_id UUID NOT NULL,
  contractor_profile_id INTEGER NOT NULL,
  source_document_id UUID NOT NULL UNIQUE,
  source_document_version INTEGER NOT NULL
    CHECK (source_document_version > 0),
  document_number TEXT NOT NULL
    CHECK (document_number ~ '^[A-Z]{1,8}-[0-9]{1,12}$'),
  source_snapshot_integrity_hash TEXT NOT NULL
    CHECK (source_snapshot_integrity_hash ~ '^[0-9a-f]{64}$'),
  created_by_user_id INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT canonical_quote_business_document_source_quote_fk
    FOREIGN KEY (quote_id, job_id)
    REFERENCES canonical_quotes(id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_quote_business_document_source_owner_fk
    FOREIGN KEY (contractor_profile_id, created_by_user_id)
    REFERENCES contractor_profiles(id, user_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_quote_business_document_source_number_key
    UNIQUE (contractor_profile_id, document_number)
);

CREATE INDEX IF NOT EXISTS canonical_quote_business_document_source_job_idx
  ON canonical_quote_business_document_sources(job_id, created_at DESC, quote_id);

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'canonical_quote_business_document_sources_append_only'
      AND tgrelid = 'canonical_quote_business_document_sources'::regclass
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER canonical_quote_business_document_sources_append_only
    BEFORE UPDATE OR DELETE ON canonical_quote_business_document_sources
    FOR EACH ROW
    EXECUTE FUNCTION prevent_canonical_quote_history_mutation();
  END IF;
END;
$migration$;

COMMENT ON TABLE canonical_quote_business_document_sources IS
  'Append-only provenance for explicit professional import of one exact numbered working Quote version into one canonical Draft Quote. It grants no lifecycle authority.';
COMMENT ON COLUMN canonical_quote_business_document_sources.source_document_id IS
  'Frozen private working-document identity. Deliberately not foreign-keyed so canonical provenance survives later private-draft unavailability.';
COMMENT ON COLUMN canonical_quote_business_document_sources.document_number IS
  'Exact inherited server-owned business Quote number; never allocated or renumbered by canonicalization.';
COMMENT ON COLUMN canonical_quote_business_document_sources.source_snapshot_integrity_hash IS
  'SHA-256 of the strict canonicalizable source projection; private workspace and conversation state are excluded.';

