-- MC-PL-IP-FINAL: additive canonical Invoice, delivery, and offline Payment
-- evidence. No processor, tax, Job, Quote, Visit, Work Plan, or Portfolio
-- state is created or changed by this migration.

INSERT INTO lifecycle_capabilities (capability)
VALUES
  ('invoice.create'),
  ('invoice.read'),
  ('invoice.issue'),
  ('invoice.read_customer'),
  ('payment.record')
ON CONFLICT (capability) DO NOTHING;

CREATE TABLE IF NOT EXISTS canonical_invoices (
  id UUID PRIMARY KEY,
  job_id UUID NOT NULL UNIQUE,
  job_request_id INTEGER NOT NULL,
  relationship_id INTEGER NOT NULL,
  issuer_participant_id UUID NOT NULL,
  invoice_number TEXT NOT NULL UNIQUE
    CHECK (invoice_number ~ '^INV-[0-9A-F]{12}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT canonical_invoice_job_fk
    FOREIGN KEY (job_id, job_request_id, relationship_id)
    REFERENCES jobs(id, job_request_id, source_request_relationship_id)
    ON DELETE RESTRICT,
  CONSTRAINT canonical_invoice_issuer_fk
    FOREIGN KEY (issuer_participant_id, job_id)
    REFERENCES relationship_participants(id, job_id)
    ON DELETE RESTRICT,
  CONSTRAINT canonical_invoice_identity_job_key UNIQUE (id, job_id)
);

CREATE TABLE IF NOT EXISTS canonical_invoice_versions (
  invoice_id UUID NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  job_id UUID NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('DRAFT', 'SENT', 'PARTIALLY_PAID', 'PAID')),
  currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  subtotal_minor BIGINT NOT NULL CHECK (subtotal_minor > 0),
  total_minor BIGINT NOT NULL CHECK (total_minor = subtotal_minor),
  paid_minor BIGINT NOT NULL DEFAULT 0 CHECK (paid_minor >= 0),
  balance_minor BIGINT NOT NULL CHECK (balance_minor >= 0),
  invoice_date DATE NOT NULL,
  due_mode TEXT NOT NULL CHECK (due_mode IN ('DUE_ON_RECEIPT', 'SPECIFIC_DATE')),
  due_date DATE,
  customer_notes TEXT CHECK (
    customer_notes IS NULL OR char_length(customer_notes) BETWEEN 1 AND 2000
  ),
  terms TEXT CHECK (terms IS NULL OR char_length(terms) BETWEEN 1 AND 2000),
  created_by_participant_id UUID NOT NULL,
  integrity_algorithm TEXT NOT NULL DEFAULT 'sha256'
    CHECK (integrity_algorithm = 'sha256'),
  integrity_hash TEXT NOT NULL CHECK (integrity_hash ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT canonical_invoice_version_key PRIMARY KEY (invoice_id, version),
  CONSTRAINT canonical_invoice_version_identity_fk
    FOREIGN KEY (invoice_id, job_id)
    REFERENCES canonical_invoices(id, job_id)
    ON DELETE RESTRICT,
  CONSTRAINT canonical_invoice_version_actor_fk
    FOREIGN KEY (created_by_participant_id, job_id)
    REFERENCES relationship_participants(id, job_id)
    ON DELETE RESTRICT,
  CONSTRAINT canonical_invoice_version_job_key UNIQUE (invoice_id, version, job_id),
  CONSTRAINT canonical_invoice_version_balance_check
    CHECK (total_minor = paid_minor + balance_minor),
  CONSTRAINT canonical_invoice_version_status_check
    CHECK (
      (status IN ('DRAFT', 'SENT') AND paid_minor = 0 AND balance_minor = total_minor)
      OR (status = 'PARTIALLY_PAID' AND paid_minor > 0 AND balance_minor > 0)
      OR (status = 'PAID' AND paid_minor = total_minor AND balance_minor = 0)
    ),
  CONSTRAINT canonical_invoice_version_due_check
    CHECK (
      (due_mode = 'DUE_ON_RECEIPT' AND due_date IS NULL)
      OR (due_mode = 'SPECIFIC_DATE' AND due_date IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS canonical_invoice_version_history_idx
  ON canonical_invoice_versions(invoice_id, version ASC, created_at ASC);

CREATE TABLE IF NOT EXISTS canonical_invoice_line_item_snapshots (
  id UUID PRIMARY KEY,
  invoice_id UUID NOT NULL,
  invoice_version INTEGER NOT NULL DEFAULT 1 CHECK (invoice_version = 1),
  job_id UUID NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  source_quote_id UUID NOT NULL,
  source_quote_version INTEGER NOT NULL CHECK (source_quote_version >= 1),
  source_scope_item_id UUID NOT NULL,
  lineage_label TEXT NOT NULL CHECK (lineage_label IN ('ORIGINAL', 'REVISED', 'ADDITIONAL')),
  description TEXT NOT NULL CHECK (char_length(btrim(description)) BETWEEN 1 AND 1000),
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 10000),
  unit_amount_minor BIGINT NOT NULL CHECK (unit_amount_minor >= 0),
  line_total_minor BIGINT NOT NULL CHECK (line_total_minor = unit_amount_minor * quantity),
  created_by_participant_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT canonical_invoice_line_invoice_fk
    FOREIGN KEY (invoice_id, invoice_version, job_id)
    REFERENCES canonical_invoice_versions(invoice_id, version, job_id)
    ON DELETE RESTRICT,
  CONSTRAINT canonical_invoice_line_quote_fk
    FOREIGN KEY (source_quote_id, source_quote_version, source_scope_item_id)
    REFERENCES canonical_quote_scope_item_snapshots(quote_id, quote_version, scope_item_id)
    ON DELETE RESTRICT,
  CONSTRAINT canonical_invoice_line_actor_fk
    FOREIGN KEY (created_by_participant_id, job_id)
    REFERENCES relationship_participants(id, job_id)
    ON DELETE RESTRICT,
  CONSTRAINT canonical_invoice_line_sequence_key UNIQUE (invoice_id, sequence)
);

CREATE INDEX IF NOT EXISTS canonical_invoice_line_order_idx
  ON canonical_invoice_line_item_snapshots(invoice_id, sequence ASC, id ASC);

CREATE TABLE IF NOT EXISTS canonical_invoice_issuances (
  invoice_id UUID PRIMARY KEY,
  invoice_version INTEGER NOT NULL,
  job_id UUID NOT NULL,
  conversation_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL UNIQUE,
  issued_by_participant_id UUID NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL,
  source_integrity_hash TEXT NOT NULL CHECK (source_integrity_hash ~ '^[0-9a-f]{64}$'),

  CONSTRAINT canonical_invoice_issuance_version_fk
    FOREIGN KEY (invoice_id, invoice_version, job_id)
    REFERENCES canonical_invoice_versions(invoice_id, version, job_id)
    ON DELETE RESTRICT,
  CONSTRAINT canonical_invoice_issuance_conversation_fk
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE RESTRICT,
  CONSTRAINT canonical_invoice_issuance_message_fk
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE RESTRICT,
  CONSTRAINT canonical_invoice_issuance_actor_fk
    FOREIGN KEY (issued_by_participant_id, job_id)
    REFERENCES relationship_participants(id, job_id)
    ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS canonical_invoice_payments (
  id UUID PRIMARY KEY,
  invoice_id UUID NOT NULL,
  invoice_version INTEGER NOT NULL CHECK (invoice_version >= 2),
  job_id UUID NOT NULL,
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  received_date DATE NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('CASH', 'CHECK', 'BANK_TRANSFER', 'OTHER')),
  customer_reference TEXT CHECK (
    customer_reference IS NULL OR char_length(customer_reference) BETWEEN 1 AND 500
  ),
  recorded_by_participant_id UUID NOT NULL,
  integrity_algorithm TEXT NOT NULL DEFAULT 'sha256'
    CHECK (integrity_algorithm = 'sha256'),
  integrity_hash TEXT NOT NULL CHECK (integrity_hash ~ '^[0-9a-f]{64}$'),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT canonical_invoice_payment_version_fk
    FOREIGN KEY (invoice_id, invoice_version, job_id)
    REFERENCES canonical_invoice_versions(invoice_id, version, job_id)
    ON DELETE RESTRICT,
  CONSTRAINT canonical_invoice_payment_actor_fk
    FOREIGN KEY (recorded_by_participant_id, job_id)
    REFERENCES relationship_participants(id, job_id)
    ON DELETE RESTRICT,
  CONSTRAINT canonical_invoice_payment_identity_key UNIQUE (id, invoice_id, job_id)
);

CREATE INDEX IF NOT EXISTS canonical_invoice_payment_history_idx
  ON canonical_invoice_payments(invoice_id, recorded_at ASC, id ASC);

CREATE TABLE IF NOT EXISTS canonical_invoice_command_idempotency (
  id UUID PRIMARY KEY,
  actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  command_name TEXT NOT NULL CHECK (
    command_name IN ('invoice.create', 'invoice.issue', 'payment.record')
  ),
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  invoice_id UUID,
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  request_fingerprint TEXT NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  result_payload JSONB CHECK (
    result_payload IS NULL OR jsonb_typeof(result_payload) = 'object'
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ,

  CONSTRAINT canonical_invoice_idempotency_invoice_fk
    FOREIGN KEY (invoice_id, job_id)
    REFERENCES canonical_invoices(id, job_id)
    ON DELETE RESTRICT,
  CONSTRAINT canonical_invoice_idempotency_key
    UNIQUE (actor_user_id, command_name, idempotency_key)
);

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS invoice_id UUID,
  ADD COLUMN IF NOT EXISTS invoice_delivery_idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS invoice_delivery_request_fingerprint TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'messages_invoice_job_fk'
      AND conrelid = 'messages'::regclass
  ) THEN
    ALTER TABLE messages
      ADD CONSTRAINT messages_invoice_job_fk
      FOREIGN KEY (invoice_id, job_id)
      REFERENCES canonical_invoices(id, job_id)
      ON DELETE RESTRICT;
  END IF;
END $$;

ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_quote_delivery_shape_check;
ALTER TABLE messages
  ADD CONSTRAINT messages_commercial_delivery_shape_check
  CHECK (
    (
      message_type = 'quote_shared'
      AND quote_request_id IS NULL
      AND conversation_id IS NOT NULL
      AND quote_id IS NOT NULL
      AND invoice_id IS NULL
      AND job_id IS NOT NULL
      AND workflow_type = 'QUOTE_SHARED'
      AND workflow_status = 'SENT'
      AND jsonb_typeof(workflow_payload) = 'object'
      AND char_length(delivery_idempotency_key) BETWEEN 1 AND 200
      AND delivery_request_fingerprint ~ '^[0-9a-f]{64}$'
      AND invoice_delivery_idempotency_key IS NULL
      AND invoice_delivery_request_fingerprint IS NULL
    )
    OR (
      message_type = 'invoice_shared'
      AND quote_request_id IS NULL
      AND conversation_id IS NOT NULL
      AND quote_id IS NULL
      AND invoice_id IS NOT NULL
      AND job_id IS NOT NULL
      AND workflow_type = 'INVOICE_SHARED'
      AND workflow_status = 'SENT'
      AND jsonb_typeof(workflow_payload) = 'object'
      AND delivery_idempotency_key IS NULL
      AND delivery_request_fingerprint IS NULL
      AND char_length(invoice_delivery_idempotency_key) BETWEEN 1 AND 200
      AND invoice_delivery_request_fingerprint ~ '^[0-9a-f]{64}$'
    )
    OR (
      message_type NOT IN ('quote_shared', 'invoice_shared')
      AND quote_id IS NULL
      AND invoice_id IS NULL
      AND job_id IS NULL
      AND delivery_idempotency_key IS NULL
      AND delivery_request_fingerprint IS NULL
      AND invoice_delivery_idempotency_key IS NULL
      AND invoice_delivery_request_fingerprint IS NULL
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS messages_invoice_delivery_idempotency_uidx
  ON messages(sender_id, invoice_id, invoice_delivery_idempotency_key)
  WHERE message_type = 'invoice_shared';

CREATE INDEX IF NOT EXISTS messages_invoice_delivery_reference_idx
  ON messages(invoice_id, job_id, created_at ASC, id ASC)
  WHERE message_type = 'invoice_shared';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'canonical_invoice_versions_append_only'
  ) THEN
    CREATE TRIGGER canonical_invoice_versions_append_only
    BEFORE UPDATE OR DELETE ON canonical_invoice_versions
    FOR EACH ROW EXECUTE FUNCTION prevent_lifecycle_append_only_mutation();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'canonical_invoice_lines_append_only'
  ) THEN
    CREATE TRIGGER canonical_invoice_lines_append_only
    BEFORE UPDATE OR DELETE ON canonical_invoice_line_item_snapshots
    FOR EACH ROW EXECUTE FUNCTION prevent_lifecycle_append_only_mutation();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'canonical_invoice_issuances_append_only'
  ) THEN
    CREATE TRIGGER canonical_invoice_issuances_append_only
    BEFORE UPDATE OR DELETE ON canonical_invoice_issuances
    FOR EACH ROW EXECUTE FUNCTION prevent_lifecycle_append_only_mutation();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'canonical_invoice_payments_append_only'
  ) THEN
    CREATE TRIGGER canonical_invoice_payments_append_only
    BEFORE UPDATE OR DELETE ON canonical_invoice_payments
    FOR EACH ROW EXECUTE FUNCTION prevent_lifecycle_append_only_mutation();
  END IF;
END $$;
