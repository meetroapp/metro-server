-- Preserve invalid legacy messages as non-authoritative historical evidence.

CREATE TABLE IF NOT EXISTS legacy_orphan_message_archive (
  message_id INTEGER PRIMARY KEY,

  source_table TEXT NOT NULL DEFAULT 'messages'
    CHECK (source_table = 'messages'),

  source_record JSONB NOT NULL
    CHECK (jsonb_typeof(source_record) = 'object'),

  source_record_sha256 TEXT NOT NULL
    CHECK (source_record_sha256 ~ '^[0-9a-f]{64}$'),

  original_quote_request_id INTEGER,
  original_sender_id INTEGER,
  original_receiver_id INTEGER,
  original_created_at TIMESTAMP,

  quarantine_reason TEXT NOT NULL DEFAULT
    'legacy_orphan_invalid_canonical_identity'
    CHECK (
      quarantine_reason =
        'legacy_orphan_invalid_canonical_identity'
    ),

  authority_classification TEXT NOT NULL DEFAULT
    'historical_evidence_only'
    CHECK (authority_classification = 'historical_evidence_only'),

  canonical_authority_granted BOOLEAN NOT NULL DEFAULT FALSE
    CHECK (canonical_authority_granted = FALSE),

  governing_contract_id TEXT NOT NULL DEFAULT
    'MC-PRODUCTION-RECONCILIATION-001'
    CHECK (
      governing_contract_id =
        'MC-PRODUCTION-RECONCILIATION-001'
    ),

  quarantined_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS
  legacy_orphan_message_archive_quarantined_at_idx
ON legacy_orphan_message_archive(quarantined_at, message_id);

CREATE FUNCTION prevent_legacy_orphan_message_archive_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'legacy_orphan_message_archive is immutable';
END;
$$;

CREATE TRIGGER legacy_orphan_message_archive_immutable
BEFORE UPDATE OR DELETE ON legacy_orphan_message_archive
FOR EACH ROW
EXECUTE FUNCTION prevent_legacy_orphan_message_archive_mutation();
