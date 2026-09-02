-- MC-QUOTE-EXTERNAL-APPROVAL-U1-D2
-- Canonical external Quote approval authority.
--
-- Principles:
--   * A business-recorded external approval is not a Meetro customer decision.
--   * External customers never become fake users or lifecycle participants.
--   * Approval is bound to one exact issued Quote version and integrity hash.
--   * Customer-facing identity is frozen independently of the mutable working draft.
--   * Approval remains separate from payment and does not itself satisfy a deposit.
--   * Existing authenticated Meetro APPROVED decisions materialize into the same
--     origin-neutral canonical Quote approval authority.

-- ---------------------------------------------------------------------------
-- Governed command registration
-- ---------------------------------------------------------------------------

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
      'quote.revision.create',
      'quote.external.approve'
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS
commercial_command_idempotency_identity_command_uidx
ON commercial_command_idempotency(id, command_name);

-- A professional requires explicit authority to attest an external approval.
INSERT INTO lifecycle_capabilities (capability, owning_module)
VALUES ('quote.external_approval.record', 'authorization')
ON CONFLICT (capability) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Exact-source keys used by the common approval authority
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS
canonical_quote_customer_decision_common_approval_source_uidx
ON canonical_quote_customer_decisions(
  id,
  quote_id,
  issued_quote_version,
  job_id,
  decision,
  issued_integrity_hash,
  decided_at
);

CREATE UNIQUE INDEX IF NOT EXISTS
canonical_quote_business_document_source_customer_snapshot_uidx
ON canonical_quote_business_document_sources(
  quote_id,
  job_id,
  contractor_profile_id,
  created_by_user_id
);

-- ---------------------------------------------------------------------------
-- Immutable customer-facing Quote identity
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS canonical_quote_customer_snapshots (
  quote_id UUID PRIMARY KEY,
  job_id UUID NOT NULL,
  contractor_profile_id INTEGER NOT NULL,
  created_by_user_id INTEGER NOT NULL,

  customer_mode TEXT NOT NULL
    CHECK (
      customer_mode IN (
        'EXTERNAL_CONTACT',
        'DOCUMENT_ONLY'
      )
    ),

  business_contact_id UUID,
  business_customer_relationship_id UUID,

  customer_name TEXT NOT NULL
    CHECK (
      char_length(btrim(customer_name)) >= 1
      AND char_length(btrim(customer_name)) <= 240
    ),

  company_name TEXT
    CHECK (
      company_name IS NULL
      OR (
        char_length(btrim(company_name)) >= 1
        AND char_length(btrim(company_name)) <= 240
      )
    ),

  customer_email TEXT
    CHECK (
      customer_email IS NULL
      OR (
        char_length(btrim(customer_email)) >= 3
        AND char_length(btrim(customer_email)) <= 320
      )
    ),

  customer_phone TEXT
    CHECK (
      customer_phone IS NULL
      OR (
        char_length(btrim(customer_phone)) >= 1
        AND char_length(btrim(customer_phone)) <= 80
      )
    ),

  customer_address TEXT
    CHECK (
      customer_address IS NULL
      OR (
        char_length(btrim(customer_address)) >= 1
        AND char_length(btrim(customer_address)) <= 600
      )
    ),

  snapshot_hash TEXT NOT NULL
    CHECK (snapshot_hash ~ '^[0-9a-f]{64}$'),

  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT canonical_quote_customer_snapshot_party_shape_check
    CHECK (
      (
        customer_mode = 'EXTERNAL_CONTACT'
        AND business_contact_id IS NOT NULL
        AND business_customer_relationship_id IS NOT NULL
      )
      OR
      (
        customer_mode = 'DOCUMENT_ONLY'
        AND business_contact_id IS NULL
        AND business_customer_relationship_id IS NULL
      )
    ),

  CONSTRAINT canonical_quote_customer_snapshot_source_fk
    FOREIGN KEY (
      quote_id,
      job_id,
      contractor_profile_id,
      created_by_user_id
    )
    REFERENCES canonical_quote_business_document_sources(
      quote_id,
      job_id,
      contractor_profile_id,
      created_by_user_id
    )
    ON DELETE RESTRICT,

  CONSTRAINT canonical_quote_customer_snapshot_contact_owner_fk
    FOREIGN KEY (
      business_contact_id,
      contractor_profile_id
    )
    REFERENCES business_contacts(
      id,
      contractor_profile_id
    )
    ON DELETE RESTRICT,

  CONSTRAINT canonical_quote_customer_snapshot_relationship_party_fk
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

  CONSTRAINT canonical_quote_customer_snapshot_hash_owner_key
    UNIQUE (
      quote_id,
      snapshot_hash,
      contractor_profile_id
    )
);

CREATE INDEX IF NOT EXISTS
canonical_quote_customer_snapshots_business_idx
ON canonical_quote_customer_snapshots(
  contractor_profile_id,
  created_at DESC,
  quote_id
);

-- Only a true business-origin Quote may receive this external customer snapshot.
CREATE OR REPLACE FUNCTION assert_quote_customer_snapshot_business_origin()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM canonical_quotes quotes
    WHERE quotes.id = NEW.quote_id
      AND quotes.job_id = NEW.job_id
      AND quotes.source_context_type = 'business_document'
      AND quotes.job_source_type = 'business_document'
  ) THEN
    RAISE EXCEPTION
      'External customer snapshots require a business-origin canonical Quote.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS canonical_quote_customer_snapshots_origin_guard
ON canonical_quote_customer_snapshots;

CREATE TRIGGER canonical_quote_customer_snapshots_origin_guard
BEFORE INSERT OR UPDATE
ON canonical_quote_customer_snapshots
FOR EACH ROW
EXECUTE FUNCTION assert_quote_customer_snapshot_business_origin();

DROP TRIGGER IF EXISTS canonical_quote_customer_snapshots_append_only
ON canonical_quote_customer_snapshots;

CREATE TRIGGER canonical_quote_customer_snapshots_append_only
BEFORE UPDATE OR DELETE
ON canonical_quote_customer_snapshots
FOR EACH ROW
EXECUTE FUNCTION prevent_canonical_quote_history_mutation();

-- ---------------------------------------------------------------------------
-- Business-recorded external approval evidence
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS canonical_quote_external_approval_evidence (
  id UUID PRIMARY KEY,

  quote_id UUID NOT NULL,
  issued_quote_version INTEGER NOT NULL
    CHECK (issued_quote_version >= 1),
  job_id UUID NOT NULL,
  contractor_profile_id INTEGER NOT NULL,

  customer_snapshot_hash TEXT NOT NULL
    CHECK (customer_snapshot_hash ~ '^[0-9a-f]{64}$'),

  recorded_by_participant_id UUID NOT NULL,

  evidence_method TEXT NOT NULL
    CHECK (
      evidence_method IN (
        'PHONE',
        'EMAIL',
        'TEXT_MESSAGE',
        'IN_PERSON',
        'SIGNED_QUOTE',
        'OTHER'
      )
    ),

  decision TEXT NOT NULL DEFAULT 'APPROVED'
    CHECK (decision = 'APPROVED'),

  approved_at TIMESTAMPTZ NOT NULL,

  evidence_reference TEXT
    CHECK (
      evidence_reference IS NULL
      OR (
        char_length(btrim(evidence_reference)) >= 1
        AND char_length(btrim(evidence_reference)) <= 1000
      )
    ),

  evidence_note TEXT
    CHECK (
      evidence_note IS NULL
      OR (
        char_length(btrim(evidence_note)) >= 1
        AND char_length(btrim(evidence_note)) <= 8000
      )
    ),

  issued_integrity_hash TEXT NOT NULL
    CHECK (issued_integrity_hash ~ '^[0-9a-f]{64}$'),

  idempotency_id UUID NOT NULL,
  idempotency_command_name TEXT NOT NULL
    DEFAULT 'quote.external.approve'
    CHECK (idempotency_command_name = 'quote.external.approve'),

  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT canonical_quote_external_approval_quote_key
    UNIQUE (quote_id),

  CONSTRAINT canonical_quote_external_approval_idempotency_key
    UNIQUE (idempotency_id),

  CONSTRAINT canonical_quote_external_approval_time_check
    CHECK (approved_at <= created_at + INTERVAL '5 minutes'),

  CONSTRAINT canonical_quote_external_approval_snapshot_fk
    FOREIGN KEY (
      quote_id,
      customer_snapshot_hash,
      contractor_profile_id
    )
    REFERENCES canonical_quote_customer_snapshots(
      quote_id,
      snapshot_hash,
      contractor_profile_id
    )
    ON DELETE RESTRICT,

  CONSTRAINT canonical_quote_external_approval_issuance_fk
    FOREIGN KEY (
      quote_id,
      issued_quote_version,
      job_id,
      issued_integrity_hash
    )
    REFERENCES canonical_quote_issuances(
      quote_id,
      quote_version,
      job_id,
      source_snapshot_integrity_hash
    )
    ON DELETE RESTRICT,

  CONSTRAINT canonical_quote_external_approval_actor_fk
    FOREIGN KEY (
      recorded_by_participant_id,
      job_id
    )
    REFERENCES relationship_participants(
      id,
      job_id
    )
    ON DELETE RESTRICT,

  CONSTRAINT canonical_quote_external_approval_idempotency_fk
    FOREIGN KEY (
      idempotency_id,
      idempotency_command_name
    )
    REFERENCES commercial_command_idempotency(
      id,
      command_name
    )
    ON DELETE RESTRICT,

  CONSTRAINT canonical_quote_external_approval_common_source_key
    UNIQUE (
      id,
      quote_id,
      issued_quote_version,
      job_id,
      decision,
      issued_integrity_hash,
      approved_at
    )
);

CREATE INDEX IF NOT EXISTS
canonical_quote_external_approval_job_idx
ON canonical_quote_external_approval_evidence(
  job_id,
  approved_at DESC,
  quote_id
);

CREATE INDEX IF NOT EXISTS
canonical_quote_external_approval_business_idx
ON canonical_quote_external_approval_evidence(
  contractor_profile_id,
  approved_at DESC,
  quote_id
);

CREATE OR REPLACE FUNCTION assert_external_quote_approval_business_origin()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM canonical_quotes quotes
    WHERE quotes.id = NEW.quote_id
      AND quotes.job_id = NEW.job_id
      AND quotes.source_context_type = 'business_document'
      AND quotes.job_source_type = 'business_document'
  ) THEN
    RAISE EXCEPTION
      'External approval evidence requires a business-origin canonical Quote.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS canonical_quote_external_approval_origin_guard
ON canonical_quote_external_approval_evidence;

CREATE TRIGGER canonical_quote_external_approval_origin_guard
BEFORE INSERT OR UPDATE
ON canonical_quote_external_approval_evidence
FOR EACH ROW
EXECUTE FUNCTION assert_external_quote_approval_business_origin();

DROP TRIGGER IF EXISTS canonical_quote_external_approval_append_only
ON canonical_quote_external_approval_evidence;

CREATE TRIGGER canonical_quote_external_approval_append_only
BEFORE UPDATE OR DELETE
ON canonical_quote_external_approval_evidence
FOR EACH ROW
EXECUTE FUNCTION prevent_canonical_quote_history_mutation();

-- ---------------------------------------------------------------------------
-- Origin-neutral canonical approval authority
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS canonical_quote_approvals (
  id UUID PRIMARY KEY,

  quote_id UUID NOT NULL,
  issued_quote_version INTEGER NOT NULL
    CHECK (issued_quote_version >= 1),
  job_id UUID NOT NULL,

  approval_source TEXT NOT NULL
    CHECK (
      approval_source IN (
        'MEETRO_CUSTOMER',
        'EXTERNAL_EVIDENCE'
      )
    ),

  decision TEXT NOT NULL DEFAULT 'APPROVED'
    CHECK (decision = 'APPROVED'),

  customer_decision_id UUID,
  external_approval_evidence_id UUID,

  issued_integrity_hash TEXT NOT NULL
    CHECK (issued_integrity_hash ~ '^[0-9a-f]{64}$'),

  approved_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT canonical_quote_approvals_quote_key
    UNIQUE (quote_id),

  CONSTRAINT canonical_quote_approvals_customer_source_key
    UNIQUE (customer_decision_id),

  CONSTRAINT canonical_quote_approvals_external_source_key
    UNIQUE (external_approval_evidence_id),

  CONSTRAINT canonical_quote_approval_source_shape_check
    CHECK (
      (
        approval_source = 'MEETRO_CUSTOMER'
        AND customer_decision_id IS NOT NULL
        AND external_approval_evidence_id IS NULL
      )
      OR
      (
        approval_source = 'EXTERNAL_EVIDENCE'
        AND customer_decision_id IS NULL
        AND external_approval_evidence_id IS NOT NULL
      )
    ),

  CONSTRAINT canonical_quote_approval_issuance_fk
    FOREIGN KEY (
      quote_id,
      issued_quote_version,
      job_id,
      issued_integrity_hash
    )
    REFERENCES canonical_quote_issuances(
      quote_id,
      quote_version,
      job_id,
      source_snapshot_integrity_hash
    )
    ON DELETE RESTRICT,

  CONSTRAINT canonical_quote_approval_customer_source_fk
    FOREIGN KEY (
      customer_decision_id,
      quote_id,
      issued_quote_version,
      job_id,
      decision,
      issued_integrity_hash,
      approved_at
    )
    REFERENCES canonical_quote_customer_decisions(
      id,
      quote_id,
      issued_quote_version,
      job_id,
      decision,
      issued_integrity_hash,
      decided_at
    )
    ON DELETE RESTRICT,

  CONSTRAINT canonical_quote_approval_external_source_fk
    FOREIGN KEY (
      external_approval_evidence_id,
      quote_id,
      issued_quote_version,
      job_id,
      decision,
      issued_integrity_hash,
      approved_at
    )
    REFERENCES canonical_quote_external_approval_evidence(
      id,
      quote_id,
      issued_quote_version,
      job_id,
      decision,
      issued_integrity_hash,
      approved_at
    )
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS
canonical_quote_approvals_job_idx
ON canonical_quote_approvals(
  job_id,
  approved_at DESC,
  quote_id
);

DROP TRIGGER IF EXISTS canonical_quote_approvals_append_only
ON canonical_quote_approvals;

CREATE TRIGGER canonical_quote_approvals_append_only
BEFORE UPDATE OR DELETE
ON canonical_quote_approvals
FOR EACH ROW
EXECUTE FUNCTION prevent_canonical_quote_history_mutation();

-- ---------------------------------------------------------------------------
-- Preserve existing authenticated customer approval truth
-- ---------------------------------------------------------------------------

INSERT INTO canonical_quote_approvals (
  id,
  quote_id,
  issued_quote_version,
  job_id,
  approval_source,
  decision,
  customer_decision_id,
  external_approval_evidence_id,
  issued_integrity_hash,
  approved_at
)
SELECT
  gen_random_uuid(),
  decisions.quote_id,
  decisions.issued_quote_version,
  decisions.job_id,
  'MEETRO_CUSTOMER',
  'APPROVED',
  decisions.id,
  NULL,
  decisions.issued_integrity_hash,
  decisions.decided_at
FROM canonical_quote_customer_decisions decisions
WHERE decisions.decision = 'APPROVED'
ON CONFLICT (quote_id) DO NOTHING;

COMMENT ON TABLE canonical_quote_customer_snapshots IS
  'Immutable customer-facing identity frozen when a business-origin working Quote becomes canonical. Supports reusable external Contacts and document-only customers without creating Meetro users or lifecycle participants.';

COMMENT ON COLUMN canonical_quote_customer_snapshots.customer_mode IS
  'EXTERNAL_CONTACT means the snapshot is also linked to the business-owned Contact/Customer Relationship; DOCUMENT_ONLY creates no reusable Contact authority.';

COMMENT ON TABLE canonical_quote_external_approval_evidence IS
  'Append-only business-recorded evidence that an external customer approved one exact issued Quote version. Approval evidence never represents payment receipt.';

COMMENT ON COLUMN canonical_quote_external_approval_evidence.evidence_method IS
  'How the professional received the external approval: PHONE, EMAIL, TEXT_MESSAGE, IN_PERSON, SIGNED_QUOTE, or OTHER.';

COMMENT ON TABLE canonical_quote_approvals IS
  'Origin-neutral append-only Quote approval authority. Source remains either authenticated Meetro customer approval or separate external approval evidence.';

COMMENT ON COLUMN canonical_quote_approvals.approval_source IS
  'MEETRO_CUSTOMER preserves authenticated customer-decision provenance; EXTERNAL_EVIDENCE preserves business-recorded external evidence provenance.';
