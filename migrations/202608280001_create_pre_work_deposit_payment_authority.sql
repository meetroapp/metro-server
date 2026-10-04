-- MC-PAY-U1-D2: additive canonical pre-work deposit and manual external
-- payment authority foundation. This migration creates schema only. It does
-- not materialize obligations, record money, alter Visit authority, or change
-- Quote, Invoice, Work, or scheduling state.

-- This identity lets an obligation prove one exact APPROVED customer decision,
-- including the issued Quote version and immutable issuance integrity hash.
CREATE UNIQUE INDEX IF NOT EXISTS
  canonical_quote_customer_decision_deposit_source_uidx
ON canonical_quote_customer_decisions(
  id,
  quote_id,
  issued_quote_version,
  job_id,
  relationship_id,
  decision,
  issued_integrity_hash,
  customer_participant_id
);

CREATE UNIQUE INDEX IF NOT EXISTS canonical_pre_work_payment_job_relationship_uidx
ON jobs(id, source_request_relationship_id);

CREATE TABLE IF NOT EXISTS canonical_pre_work_payment_command_idempotency (
  id UUID PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,

  actor_type TEXT NOT NULL
    CHECK (actor_type IN ('PARTICIPANT', 'PROCESSOR')),
  actor_participant_id UUID,
  actor_external_reference TEXT
    CHECK (
      actor_external_reference IS NULL
      OR char_length(btrim(actor_external_reference)) BETWEEN 1 AND 300
    ),

  command_name TEXT NOT NULL
    CHECK (
      command_name IN (
        'deposit.materialize',
        'deposit.payment.record',
        'deposit.payment.allocate',
        'deposit.payment.reverse',
        'deposit.obligation.supersede',
        'deposit.obligation.void'
      )
    ),
  command_scope TEXT NOT NULL
    CHECK (char_length(btrim(command_scope)) BETWEEN 1 AND 300),
  idempotency_key TEXT NOT NULL
    CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  request_fingerprint TEXT NOT NULL
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),

  result_reference JSONB,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT canonical_pre_work_payment_command_actor_fk
    FOREIGN KEY (actor_participant_id, job_id)
    REFERENCES relationship_participants(id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_pre_work_payment_command_actor_shape_check
    CHECK (
      (
        actor_type = 'PARTICIPANT'
        AND actor_participant_id IS NOT NULL
        AND actor_external_reference IS NULL
      )
      OR
      (
        actor_type = 'PROCESSOR'
        AND actor_participant_id IS NULL
        AND actor_external_reference IS NOT NULL
      )
    ),

  CONSTRAINT canonical_pre_work_payment_command_result_check
    CHECK (
      (
        result_reference IS NULL
        AND completed_at IS NULL
      )
      OR
      (
        result_reference IS NOT NULL
        AND jsonb_typeof(result_reference) = 'object'
        AND completed_at IS NOT NULL
      )
    ),

  CONSTRAINT canonical_pre_work_payment_command_identity_job_key
    UNIQUE (id, job_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS
  canonical_pre_work_payment_command_participant_key
ON canonical_pre_work_payment_command_idempotency(
  actor_participant_id,
  command_name,
  command_scope,
  idempotency_key
)
WHERE actor_type = 'PARTICIPANT';

CREATE UNIQUE INDEX IF NOT EXISTS
  canonical_pre_work_payment_command_processor_key
ON canonical_pre_work_payment_command_idempotency(
  actor_external_reference,
  command_name,
  command_scope,
  idempotency_key
)
WHERE actor_type = 'PROCESSOR';

CREATE INDEX IF NOT EXISTS canonical_pre_work_payment_command_job_idx
ON canonical_pre_work_payment_command_idempotency(
  job_id,
  command_name,
  created_at DESC,
  id DESC
);

CREATE TABLE IF NOT EXISTS canonical_pre_work_deposit_obligations (
  id UUID PRIMARY KEY,
  job_id UUID NOT NULL,
  job_request_id INTEGER NOT NULL,
  relationship_id INTEGER NOT NULL,

  quote_id UUID NOT NULL,
  issued_quote_version INTEGER NOT NULL CHECK (issued_quote_version >= 1),
  customer_decision_id UUID NOT NULL UNIQUE,
  customer_decision TEXT NOT NULL DEFAULT 'APPROVED'
    CHECK (customer_decision = 'APPROVED'),
  customer_participant_id UUID NOT NULL,

  obligation_type TEXT NOT NULL DEFAULT 'PRE_WORK_DEPOSIT'
    CHECK (obligation_type = 'PRE_WORK_DEPOSIT'),
  currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  quote_total_minor BIGINT NOT NULL CHECK (quote_total_minor > 0),

  deposit_rule_type TEXT NOT NULL
    CHECK (deposit_rule_type IN ('PERCENT', 'FIXED')),
  deposit_percent_basis_points INTEGER
    CHECK (
      deposit_percent_basis_points IS NULL
      OR deposit_percent_basis_points BETWEEN 1 AND 10000
    ),
  deposit_fixed_minor BIGINT
    CHECK (deposit_fixed_minor IS NULL OR deposit_fixed_minor > 0),
  required_minor BIGINT NOT NULL
    CHECK (required_minor > 0 AND required_minor <= quote_total_minor),

  source_integrity_hash TEXT NOT NULL
    CHECK (source_integrity_hash ~ '^[0-9a-f]{64}$'),
  derivation_version SMALLINT NOT NULL DEFAULT 1
    CHECK (derivation_version = 1),
  effective_at TIMESTAMPTZ NOT NULL,
  created_by_participant_id UUID NOT NULL,
  created_command_idempotency_id UUID NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT canonical_pre_work_deposit_job_fk
    FOREIGN KEY (job_id, job_request_id, relationship_id)
    REFERENCES jobs(id, job_request_id, source_request_relationship_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_pre_work_deposit_quote_version_fk
    FOREIGN KEY (quote_id, issued_quote_version, job_id)
    REFERENCES canonical_quote_versions(quote_id, version, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_pre_work_deposit_decision_fk
    FOREIGN KEY (
      customer_decision_id,
      quote_id,
      issued_quote_version,
      job_id,
      relationship_id,
      customer_decision,
      source_integrity_hash,
      customer_participant_id
    )
    REFERENCES canonical_quote_customer_decisions(
      id,
      quote_id,
      issued_quote_version,
      job_id,
      relationship_id,
      decision,
      issued_integrity_hash,
      customer_participant_id
    )
    ON DELETE RESTRICT,

  CONSTRAINT canonical_pre_work_deposit_customer_fk
    FOREIGN KEY (customer_participant_id, job_id, relationship_id)
    REFERENCES relationship_participants(id, job_id, request_relationship_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_pre_work_deposit_creator_fk
    FOREIGN KEY (created_by_participant_id, job_id, relationship_id)
    REFERENCES relationship_participants(id, job_id, request_relationship_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_pre_work_deposit_create_command_fk
    FOREIGN KEY (created_command_idempotency_id, job_id)
    REFERENCES canonical_pre_work_payment_command_idempotency(id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_pre_work_deposit_rule_shape_check
    CHECK (
      (
        deposit_rule_type = 'PERCENT'
        AND deposit_percent_basis_points IS NOT NULL
        AND deposit_fixed_minor IS NULL
      )
      OR
      (
        deposit_rule_type = 'FIXED'
        AND deposit_percent_basis_points IS NULL
        AND deposit_fixed_minor IS NOT NULL
        AND deposit_fixed_minor = required_minor
      )
    ),

  CONSTRAINT canonical_pre_work_deposit_identity_scope_key
    UNIQUE (id, job_id, relationship_id, currency)
);

CREATE INDEX IF NOT EXISTS canonical_pre_work_deposit_job_idx
ON canonical_pre_work_deposit_obligations(
  job_id,
  effective_at DESC,
  id DESC
);

CREATE INDEX IF NOT EXISTS canonical_pre_work_deposit_quote_idx
ON canonical_pre_work_deposit_obligations(
  quote_id,
  issued_quote_version,
  customer_decision_id
);

CREATE TABLE IF NOT EXISTS canonical_pre_work_deposit_versions (
  obligation_id UUID NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  job_id UUID NOT NULL,
  relationship_id INTEGER NOT NULL,
  currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),

  state TEXT NOT NULL
    CHECK (
      state IN (
        'DUE',
        'PARTIALLY_SATISFIED',
        'SATISFIED',
        'SUPERSEDED',
        'VOIDED'
      )
    ),
  required_minor BIGINT NOT NULL CHECK (required_minor > 0),
  applied_minor BIGINT NOT NULL CHECK (applied_minor >= 0),
  remaining_minor BIGINT NOT NULL CHECK (remaining_minor >= 0),

  recorded_by_participant_id UUID,
  command_idempotency_id UUID NOT NULL UNIQUE,
  integrity_algorithm TEXT NOT NULL DEFAULT 'sha256'
    CHECK (integrity_algorithm = 'sha256'),
  integrity_hash TEXT NOT NULL
    CHECK (integrity_hash ~ '^[0-9a-f]{64}$'),
  integrity_version SMALLINT NOT NULL DEFAULT 1
    CHECK (integrity_version = 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT canonical_pre_work_deposit_version_key
    PRIMARY KEY (obligation_id, version),

  CONSTRAINT canonical_pre_work_deposit_version_obligation_fk
    FOREIGN KEY (obligation_id, job_id, relationship_id, currency)
    REFERENCES canonical_pre_work_deposit_obligations(
      id,
      job_id,
      relationship_id,
      currency
    )
    ON DELETE RESTRICT,

  CONSTRAINT canonical_pre_work_deposit_version_actor_fk
    FOREIGN KEY (recorded_by_participant_id, job_id)
    REFERENCES relationship_participants(id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_pre_work_deposit_version_command_fk
    FOREIGN KEY (command_idempotency_id, job_id)
    REFERENCES canonical_pre_work_payment_command_idempotency(id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_pre_work_deposit_version_balance_check
    CHECK (
      applied_minor <= required_minor
      AND required_minor = applied_minor + remaining_minor
    ),

  CONSTRAINT canonical_pre_work_deposit_version_state_check
    CHECK (
      (
        state = 'DUE'
        AND applied_minor = 0
        AND remaining_minor = required_minor
      )
      OR
      (
        state = 'PARTIALLY_SATISFIED'
        AND applied_minor > 0
        AND applied_minor < required_minor
        AND remaining_minor > 0
      )
      OR
      (
        state = 'SATISFIED'
        AND applied_minor = required_minor
        AND remaining_minor = 0
      )
      OR state IN ('SUPERSEDED', 'VOIDED')
    ),

  CONSTRAINT canonical_pre_work_deposit_version_scope_key
    UNIQUE (obligation_id, version, job_id, relationship_id, currency),

  CONSTRAINT canonical_pre_work_deposit_version_job_key
    UNIQUE (obligation_id, version, job_id),

  CONSTRAINT canonical_pre_work_deposit_version_state_key
    UNIQUE (obligation_id, version, job_id, state)
);

CREATE INDEX IF NOT EXISTS canonical_pre_work_deposit_latest_version_idx
ON canonical_pre_work_deposit_versions(
  obligation_id,
  version DESC,
  created_at DESC
);

CREATE INDEX IF NOT EXISTS canonical_pre_work_deposit_state_idx
ON canonical_pre_work_deposit_versions(
  job_id,
  state,
  created_at DESC,
  obligation_id,
  version DESC
);

CREATE TABLE IF NOT EXISTS canonical_pre_work_payment_receipts (
  id UUID PRIMARY KEY,
  job_id UUID NOT NULL,
  relationship_id INTEGER NOT NULL,
  gross_amount_minor BIGINT NOT NULL CHECK (gross_amount_minor > 0),
  currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),

  evidence_source TEXT NOT NULL
    CHECK (evidence_source IN ('MANUAL_EXTERNAL', 'PROCESSOR')),
  normalized_method TEXT
    CHECK (
      normalized_method IS NULL
      OR normalized_method ~ '^[A-Z][A-Z0-9_]{0,63}$'
    ),
  display_method TEXT
    CHECK (
      display_method IS NULL
      OR char_length(btrim(display_method)) BETWEEN 1 AND 120
    ),
  external_reference TEXT
    CHECK (
      external_reference IS NULL
      OR char_length(btrim(external_reference)) BETWEEN 1 AND 500
    ),
  received_at TIMESTAMPTZ NOT NULL,

  recorded_by_participant_id UUID,
  command_idempotency_id UUID NOT NULL UNIQUE,
  integrity_algorithm TEXT NOT NULL DEFAULT 'sha256'
    CHECK (integrity_algorithm = 'sha256'),
  integrity_hash TEXT NOT NULL
    CHECK (integrity_hash ~ '^[0-9a-f]{64}$'),
  integrity_version SMALLINT NOT NULL DEFAULT 1
    CHECK (integrity_version = 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT canonical_pre_work_payment_receipt_relationship_fk
    FOREIGN KEY (job_id, relationship_id)
    REFERENCES jobs(id, source_request_relationship_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_pre_work_payment_receipt_actor_fk
    FOREIGN KEY (recorded_by_participant_id, job_id, relationship_id)
    REFERENCES relationship_participants(id, job_id, request_relationship_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_pre_work_payment_receipt_command_fk
    FOREIGN KEY (command_idempotency_id, job_id)
    REFERENCES canonical_pre_work_payment_command_idempotency(id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_pre_work_payment_receipt_source_shape_check
    CHECK (
      (
        evidence_source = 'MANUAL_EXTERNAL'
        AND recorded_by_participant_id IS NOT NULL
        AND (normalized_method IS NOT NULL OR display_method IS NOT NULL)
      )
      OR
      (
        evidence_source = 'PROCESSOR'
        AND external_reference IS NOT NULL
      )
    ),

  CONSTRAINT canonical_pre_work_payment_receipt_identity_scope_key
    UNIQUE (id, job_id, relationship_id, currency)
);

CREATE INDEX IF NOT EXISTS canonical_pre_work_payment_receipt_job_idx
ON canonical_pre_work_payment_receipts(
  job_id,
  received_at DESC,
  id DESC
);

CREATE INDEX IF NOT EXISTS canonical_pre_work_payment_receipt_external_idx
ON canonical_pre_work_payment_receipts(
  evidence_source,
  external_reference
)
WHERE external_reference IS NOT NULL;

CREATE TABLE IF NOT EXISTS canonical_pre_work_payment_allocations (
  id UUID PRIMARY KEY,
  receipt_id UUID NOT NULL,
  obligation_id UUID NOT NULL,
  job_id UUID NOT NULL,
  relationship_id INTEGER NOT NULL,
  currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  allocated_minor BIGINT NOT NULL CHECK (allocated_minor > 0),

  recorded_by_participant_id UUID,
  command_idempotency_id UUID NOT NULL UNIQUE,
  integrity_algorithm TEXT NOT NULL DEFAULT 'sha256'
    CHECK (integrity_algorithm = 'sha256'),
  integrity_hash TEXT NOT NULL
    CHECK (integrity_hash ~ '^[0-9a-f]{64}$'),
  integrity_version SMALLINT NOT NULL DEFAULT 1
    CHECK (integrity_version = 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT canonical_pre_work_payment_allocation_receipt_fk
    FOREIGN KEY (receipt_id, job_id, relationship_id, currency)
    REFERENCES canonical_pre_work_payment_receipts(
      id,
      job_id,
      relationship_id,
      currency
    )
    ON DELETE RESTRICT,

  CONSTRAINT canonical_pre_work_payment_allocation_obligation_fk
    FOREIGN KEY (obligation_id, job_id, relationship_id, currency)
    REFERENCES canonical_pre_work_deposit_obligations(
      id,
      job_id,
      relationship_id,
      currency
    )
    ON DELETE RESTRICT,

  CONSTRAINT canonical_pre_work_payment_allocation_actor_fk
    FOREIGN KEY (recorded_by_participant_id, job_id)
    REFERENCES relationship_participants(id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_pre_work_payment_allocation_command_fk
    FOREIGN KEY (command_idempotency_id, job_id)
    REFERENCES canonical_pre_work_payment_command_idempotency(id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_pre_work_payment_allocation_identity_scope_key
    UNIQUE (
      id,
      receipt_id,
      obligation_id,
      job_id,
      relationship_id,
      currency
    ),

  CONSTRAINT canonical_pre_work_payment_allocation_event_key
    UNIQUE (id, receipt_id, obligation_id, job_id)
);

CREATE INDEX IF NOT EXISTS canonical_pre_work_payment_allocation_obligation_idx
ON canonical_pre_work_payment_allocations(
  obligation_id,
  created_at ASC,
  id ASC
);

CREATE INDEX IF NOT EXISTS canonical_pre_work_payment_allocation_receipt_idx
ON canonical_pre_work_payment_allocations(
  receipt_id,
  created_at ASC,
  id ASC
);

CREATE TABLE IF NOT EXISTS canonical_pre_work_payment_allocation_reversals (
  id UUID PRIMARY KEY,
  allocation_id UUID NOT NULL,
  receipt_id UUID NOT NULL,
  obligation_id UUID NOT NULL,
  job_id UUID NOT NULL,
  relationship_id INTEGER NOT NULL,
  currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  reversed_minor BIGINT NOT NULL CHECK (reversed_minor > 0),

  reversal_effect TEXT NOT NULL
    CHECK (reversal_effect IN ('DEALLOCATE', 'RECEIPT_REVERSAL')),
  reason_category TEXT NOT NULL
    CHECK (
      reason_category IN ('REFUND', 'REVERSAL', 'CORRECTION', 'CHARGEBACK')
    ),
  reason TEXT NOT NULL
    CHECK (char_length(btrim(reason)) BETWEEN 1 AND 2000),
  reversed_at TIMESTAMPTZ NOT NULL,

  recorded_by_participant_id UUID,
  command_idempotency_id UUID NOT NULL UNIQUE,
  integrity_algorithm TEXT NOT NULL DEFAULT 'sha256'
    CHECK (integrity_algorithm = 'sha256'),
  integrity_hash TEXT NOT NULL
    CHECK (integrity_hash ~ '^[0-9a-f]{64}$'),
  integrity_version SMALLINT NOT NULL DEFAULT 1
    CHECK (integrity_version = 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT canonical_pre_work_payment_reversal_allocation_fk
    FOREIGN KEY (
      allocation_id,
      receipt_id,
      obligation_id,
      job_id,
      relationship_id,
      currency
    )
    REFERENCES canonical_pre_work_payment_allocations(
      id,
      receipt_id,
      obligation_id,
      job_id,
      relationship_id,
      currency
    )
    ON DELETE RESTRICT,

  CONSTRAINT canonical_pre_work_payment_reversal_actor_fk
    FOREIGN KEY (recorded_by_participant_id, job_id)
    REFERENCES relationship_participants(id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_pre_work_payment_reversal_command_fk
    FOREIGN KEY (command_idempotency_id, job_id)
    REFERENCES canonical_pre_work_payment_command_idempotency(id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_pre_work_payment_reversal_reason_shape_check
    CHECK (
      (
        reason_category = 'CORRECTION'
        AND reversal_effect = 'DEALLOCATE'
      )
      OR
      (
        reason_category IN ('REFUND', 'REVERSAL', 'CHARGEBACK')
        AND reversal_effect = 'RECEIPT_REVERSAL'
      )
    ),

  CONSTRAINT canonical_pre_work_payment_reversal_identity_scope_key
    UNIQUE (
      id,
      allocation_id,
      receipt_id,
      obligation_id,
      job_id,
      relationship_id,
      currency
    ),

  CONSTRAINT canonical_pre_work_payment_reversal_event_key
    UNIQUE (id, allocation_id, receipt_id, obligation_id, job_id)
);

CREATE INDEX IF NOT EXISTS canonical_pre_work_payment_reversal_allocation_idx
ON canonical_pre_work_payment_allocation_reversals(
  allocation_id,
  created_at ASC,
  id ASC
);

CREATE INDEX IF NOT EXISTS canonical_pre_work_payment_reversal_receipt_idx
ON canonical_pre_work_payment_allocation_reversals(
  receipt_id,
  reversal_effect,
  created_at ASC,
  id ASC
);

CREATE TABLE IF NOT EXISTS canonical_pre_work_deposit_events (
  id UUID PRIMARY KEY,
  obligation_id UUID NOT NULL,
  obligation_version INTEGER NOT NULL CHECK (obligation_version >= 1),
  previous_obligation_version INTEGER
    CHECK (
      previous_obligation_version IS NULL
      OR previous_obligation_version >= 1
    ),
  job_id UUID NOT NULL,

  event_type TEXT NOT NULL
    CHECK (
      event_type IN (
        'DEPOSIT_OBLIGATION_CREATED',
        'DEPOSIT_PAYMENT_ALLOCATED',
        'DEPOSIT_PAYMENT_REVERSED',
        'DEPOSIT_OBLIGATION_SUPERSEDED',
        'DEPOSIT_OBLIGATION_VOIDED'
      )
    ),
  obligation_state TEXT NOT NULL
    CHECK (
      obligation_state IN (
        'DUE',
        'PARTIALLY_SATISFIED',
        'SATISFIED',
        'SUPERSEDED',
        'VOIDED'
      )
    ),

  receipt_id UUID,
  allocation_id UUID,
  reversal_id UUID,
  recorded_by_participant_id UUID,
  command_idempotency_id UUID NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT canonical_pre_work_deposit_event_version_fk
    FOREIGN KEY (obligation_id, obligation_version, job_id, obligation_state)
    REFERENCES canonical_pre_work_deposit_versions(
      obligation_id,
      version,
      job_id,
      state
    )
    ON DELETE RESTRICT,

  CONSTRAINT canonical_pre_work_deposit_event_previous_version_fk
    FOREIGN KEY (obligation_id, previous_obligation_version, job_id)
    REFERENCES canonical_pre_work_deposit_versions(
      obligation_id,
      version,
      job_id
    )
    ON DELETE RESTRICT,

  CONSTRAINT canonical_pre_work_deposit_event_allocation_fk
    FOREIGN KEY (allocation_id, receipt_id, obligation_id, job_id)
    REFERENCES canonical_pre_work_payment_allocations(
      id,
      receipt_id,
      obligation_id,
      job_id
    )
    ON DELETE RESTRICT,

  CONSTRAINT canonical_pre_work_deposit_event_reversal_fk
    FOREIGN KEY (
      reversal_id,
      allocation_id,
      receipt_id,
      obligation_id,
      job_id
    )
    REFERENCES canonical_pre_work_payment_allocation_reversals(
      id,
      allocation_id,
      receipt_id,
      obligation_id,
      job_id
    )
    ON DELETE RESTRICT,

  CONSTRAINT canonical_pre_work_deposit_event_actor_fk
    FOREIGN KEY (recorded_by_participant_id, job_id)
    REFERENCES relationship_participants(id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_pre_work_deposit_event_command_fk
    FOREIGN KEY (command_idempotency_id, job_id)
    REFERENCES canonical_pre_work_payment_command_idempotency(id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_pre_work_deposit_event_shape_check
    CHECK (
      (
        event_type = 'DEPOSIT_OBLIGATION_CREATED'
        AND obligation_version = 1
        AND previous_obligation_version IS NULL
        AND obligation_state = 'DUE'
        AND receipt_id IS NULL
        AND allocation_id IS NULL
        AND reversal_id IS NULL
      )
      OR
      (
        event_type = 'DEPOSIT_PAYMENT_ALLOCATED'
        AND obligation_version >= 2
        AND previous_obligation_version = obligation_version - 1
        AND obligation_state IN ('PARTIALLY_SATISFIED', 'SATISFIED')
        AND receipt_id IS NOT NULL
        AND allocation_id IS NOT NULL
        AND reversal_id IS NULL
      )
      OR
      (
        event_type = 'DEPOSIT_PAYMENT_REVERSED'
        AND obligation_version >= 2
        AND previous_obligation_version = obligation_version - 1
        AND obligation_state IN ('DUE', 'PARTIALLY_SATISFIED')
        AND receipt_id IS NOT NULL
        AND allocation_id IS NOT NULL
        AND reversal_id IS NOT NULL
      )
      OR
      (
        event_type = 'DEPOSIT_OBLIGATION_SUPERSEDED'
        AND obligation_version >= 2
        AND previous_obligation_version = obligation_version - 1
        AND obligation_state = 'SUPERSEDED'
        AND receipt_id IS NULL
        AND allocation_id IS NULL
        AND reversal_id IS NULL
      )
      OR
      (
        event_type = 'DEPOSIT_OBLIGATION_VOIDED'
        AND obligation_version >= 2
        AND previous_obligation_version = obligation_version - 1
        AND obligation_state = 'VOIDED'
        AND receipt_id IS NULL
        AND allocation_id IS NULL
        AND reversal_id IS NULL
      )
    ),

  CONSTRAINT canonical_pre_work_deposit_event_version_key
    UNIQUE (obligation_id, obligation_version),

  CONSTRAINT canonical_pre_work_deposit_event_identity_job_key
    UNIQUE (id, obligation_id, job_id)
);

CREATE INDEX IF NOT EXISTS canonical_pre_work_deposit_event_history_idx
ON canonical_pre_work_deposit_events(
  obligation_id,
  created_at ASC,
  id ASC
);

CREATE INDEX IF NOT EXISTS canonical_pre_work_deposit_event_job_idx
ON canonical_pre_work_deposit_events(
  job_id,
  created_at DESC,
  id DESC
);

-- Reuse the established lifecycle append-only trigger function. Command
-- idempotency is intentionally excluded because completing a reserved command
-- updates its result payload and completion timestamp exactly once.
DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'canonical_pre_work_deposit_obligations',
    'canonical_pre_work_deposit_versions',
    'canonical_pre_work_payment_receipts',
    'canonical_pre_work_payment_allocations',
    'canonical_pre_work_payment_allocation_reversals',
    'canonical_pre_work_deposit_events'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgname = table_name || '_append_only'
        AND NOT tgisinternal
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I '
        'FOR EACH ROW EXECUTE FUNCTION prevent_lifecycle_append_only_mutation()',
        table_name || '_append_only',
        table_name
      );
    END IF;
  END LOOP;
END $$;
