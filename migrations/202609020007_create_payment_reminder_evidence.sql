-- MC-PAY-REMINDER-R1A
-- Canonical append-only Payment Reminder communication evidence.
--
-- A Reminder is not Payment evidence.
-- A Reminder cannot mutate Invoice balance, deposit balance, scheduling,
-- approval, work, or customer identity.
-- R1A is bounded to ordinary Meetro customer relationships.

INSERT INTO lifecycle_capabilities (capability)
VALUES ('payment.reminder.send')
ON CONFLICT (capability) DO NOTHING;

CREATE TABLE IF NOT EXISTS canonical_payment_reminder_command_idempotency (
  id UUID PRIMARY KEY,
  actor_user_id INTEGER NOT NULL
    REFERENCES users(id) ON DELETE RESTRICT,

  command_name TEXT NOT NULL DEFAULT 'payment.reminder.send'
    CHECK (command_name = 'payment.reminder.send'),

  source_type TEXT NOT NULL
    CHECK (source_type IN ('INVOICE', 'DEPOSIT')),

  job_id UUID NOT NULL
    REFERENCES jobs(id) ON DELETE RESTRICT,

  invoice_id UUID
    REFERENCES canonical_invoices(id) ON DELETE RESTRICT,

  deposit_obligation_id UUID
    REFERENCES canonical_pre_work_deposit_obligations(id)
    ON DELETE RESTRICT,

  idempotency_key TEXT NOT NULL
    CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),

  request_fingerprint TEXT NOT NULL
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),

  result_payload JSONB
    CHECK (
      result_payload IS NULL
      OR jsonb_typeof(result_payload) = 'object'
    ),

  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ,

  CONSTRAINT canonical_payment_reminder_command_source_check
    CHECK (
      (
        source_type = 'INVOICE'
        AND invoice_id IS NOT NULL
        AND deposit_obligation_id IS NULL
      )
      OR
      (
        source_type = 'DEPOSIT'
        AND invoice_id IS NULL
        AND deposit_obligation_id IS NOT NULL
      )
    ),

  CONSTRAINT canonical_payment_reminder_command_key
    UNIQUE (
      actor_user_id,
      command_name,
      idempotency_key
    )
);

CREATE INDEX IF NOT EXISTS
canonical_payment_reminder_command_source_idx
ON canonical_payment_reminder_command_idempotency (
  source_type,
  job_id,
  created_at DESC,
  id DESC
);

CREATE TABLE IF NOT EXISTS canonical_payment_reminders (
  id UUID PRIMARY KEY,

  command_idempotency_id UUID NOT NULL UNIQUE
    REFERENCES canonical_payment_reminder_command_idempotency(id)
    ON DELETE RESTRICT,

  source_type TEXT NOT NULL
    CHECK (source_type IN ('INVOICE', 'DEPOSIT')),

  job_id UUID NOT NULL
    REFERENCES jobs(id) ON DELETE RESTRICT,

  relationship_id INTEGER NOT NULL
    REFERENCES request_relationships(id) ON DELETE RESTRICT,

  conversation_id INTEGER NOT NULL
    REFERENCES conversations(id) ON DELETE RESTRICT,

  sender_user_id INTEGER NOT NULL
    REFERENCES users(id) ON DELETE RESTRICT,

  recipient_user_id INTEGER NOT NULL
    REFERENCES users(id) ON DELETE RESTRICT,

  sender_participant_id UUID NOT NULL,

  invoice_id UUID,
  deposit_obligation_id UUID,

  source_version INTEGER NOT NULL
    CHECK (source_version >= 1),

  classification TEXT NOT NULL
    CHECK (
      classification IN (
        'UPCOMING_DUE',
        'DUE_TODAY',
        'OVERDUE',
        'DEPOSIT_DUE',
        'DEPOSIT_REMAINING'
      )
    ),

  classified_on DATE NOT NULL,

  classification_time_zone TEXT NOT NULL
    CHECK (
      classification_time_zone = btrim(classification_time_zone)
      AND char_length(classification_time_zone) BETWEEN 3 AND 100
      AND classification_time_zone LIKE '%/%'
      AND classification_time_zone !~ '[[:cntrl:]]'
    ),

  currency TEXT NOT NULL
    CHECK (currency ~ '^[A-Z]{3}$'),

  amount_minor BIGINT NOT NULL
    CHECK (amount_minor > 0),

  due_mode TEXT
    CHECK (
      due_mode IS NULL
      OR due_mode IN ('DUE_ON_RECEIPT', 'SPECIFIC_DATE')
    ),

  due_date DATE,
  effective_due_date DATE,

  message_text TEXT NOT NULL
    CHECK (
      char_length(btrim(message_text))
      BETWEEN 1 AND 5000
    ),

  message_id INTEGER NOT NULL UNIQUE
    REFERENCES messages(id) ON DELETE RESTRICT,

  sent_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT canonical_payment_reminder_sender_participant_fk
    FOREIGN KEY (
      sender_participant_id,
      job_id,
      relationship_id
    )
    REFERENCES relationship_participants(
      id,
      job_id,
      request_relationship_id
    )
    ON DELETE RESTRICT,

  CONSTRAINT canonical_payment_reminder_invoice_version_fk
    FOREIGN KEY (
      invoice_id,
      source_version,
      job_id
    )
    REFERENCES canonical_invoice_versions(
      invoice_id,
      version,
      job_id
    )
    ON DELETE RESTRICT,

  CONSTRAINT canonical_payment_reminder_deposit_version_fk
    FOREIGN KEY (
      deposit_obligation_id,
      source_version,
      job_id,
      relationship_id,
      currency
    )
    REFERENCES canonical_pre_work_deposit_versions(
      obligation_id,
      version,
      job_id,
      relationship_id,
      currency
    )
    ON DELETE RESTRICT,

  CONSTRAINT canonical_payment_reminder_participants_check
    CHECK (sender_user_id <> recipient_user_id),

  CONSTRAINT canonical_payment_reminder_source_shape_check
    CHECK (
      (
        source_type = 'INVOICE'
        AND invoice_id IS NOT NULL
        AND deposit_obligation_id IS NULL
        AND classification IN (
          'UPCOMING_DUE',
          'DUE_TODAY',
          'OVERDUE'
        )
        AND due_mode IS NOT NULL
        AND effective_due_date IS NOT NULL
        AND (
          (
            due_mode = 'DUE_ON_RECEIPT'
            AND due_date IS NULL
          )
          OR
          (
            due_mode = 'SPECIFIC_DATE'
            AND due_date IS NOT NULL
            AND effective_due_date = due_date
          )
        )
      )
      OR
      (
        source_type = 'DEPOSIT'
        AND invoice_id IS NULL
        AND deposit_obligation_id IS NOT NULL
        AND classification IN (
          'DEPOSIT_DUE',
          'DEPOSIT_REMAINING'
        )
        AND due_mode IS NULL
        AND due_date IS NULL
        AND effective_due_date IS NULL
      )
    ),

  CONSTRAINT canonical_payment_reminder_due_classification_check
    CHECK (
      source_type = 'DEPOSIT'
      OR due_mode = 'DUE_ON_RECEIPT'
      OR (
        classification = 'UPCOMING_DUE'
        AND effective_due_date > classified_on
      )
      OR (
        classification = 'DUE_TODAY'
        AND effective_due_date = classified_on
      )
      OR (
        classification = 'OVERDUE'
        AND effective_due_date < classified_on
      )
    )
);

CREATE INDEX IF NOT EXISTS
canonical_payment_reminder_invoice_history_idx
ON canonical_payment_reminders (
  invoice_id,
  sent_at ASC,
  id ASC
)
WHERE source_type = 'INVOICE';

CREATE INDEX IF NOT EXISTS
canonical_payment_reminder_deposit_history_idx
ON canonical_payment_reminders (
  deposit_obligation_id,
  sent_at ASC,
  id ASC
)
WHERE source_type = 'DEPOSIT';

CREATE OR REPLACE FUNCTION
assert_canonical_payment_reminder_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_source_type TEXT;
  v_professional_user_id INTEGER;
  v_homeowner_id INTEGER;
  v_conversation_relationship_id INTEGER;
  v_conversation_status TEXT;
  v_business_time_zone TEXT;

  v_command_source_type TEXT;
  v_command_job_id UUID;
  v_command_invoice_id UUID;
  v_command_deposit_id UUID;

  v_source_relationship_id INTEGER;
  v_source_approval TEXT;

  v_message_conversation_id INTEGER;
  v_message_sender_id INTEGER;
  v_message_receiver_id INTEGER;
  v_message_type TEXT;
  v_message_workflow_type TEXT;
  v_message_workflow_status TEXT;
  v_message_payload JSONB;
  v_message_created_at TIMESTAMPTZ;
BEGIN
  SELECT
    jobs.source_type,
    relationships.professional_user_id,
    relationships.homeowner_id
  INTO
    v_source_type,
    v_professional_user_id,
    v_homeowner_id
  FROM jobs
  INNER JOIN request_relationships relationships
    ON relationships.id = jobs.source_request_relationship_id
  WHERE jobs.id = NEW.job_id
    AND relationships.id = NEW.relationship_id
  LIMIT 1;

  IF NOT FOUND
     OR v_source_type IS DISTINCT FROM
       'ordinary_request_selection' THEN
    RAISE EXCEPTION
      'Payment Reminder requires an ordinary Meetro customer relationship.';
  END IF;

  IF NEW.sender_user_id IS DISTINCT FROM
       v_professional_user_id
     OR NEW.recipient_user_id IS DISTINCT FROM
       v_homeowner_id THEN
    RAISE EXCEPTION
      'Payment Reminder participants do not match the canonical relationship.';
  END IF;

  SELECT profiles.time_zone
  INTO v_business_time_zone
  FROM contractor_profiles profiles
  WHERE profiles.user_id = v_professional_user_id
  LIMIT 1;

  IF NOT FOUND
     OR v_business_time_zone IS NULL
     OR v_business_time_zone IS DISTINCT FROM
       NEW.classification_time_zone THEN
    RAISE EXCEPTION
      'Payment Reminder business timezone is unavailable or changed.';
  END IF;

  SELECT relationship_id, status
  INTO
    v_conversation_relationship_id,
    v_conversation_status
  FROM conversations
  WHERE id = NEW.conversation_id
  LIMIT 1;

  IF NOT FOUND
     OR v_conversation_relationship_id IS DISTINCT FROM
       NEW.relationship_id
     OR v_conversation_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION
      'Payment Reminder requires the active governed customer conversation.';
  END IF;

  SELECT
    source_type,
    job_id,
    invoice_id,
    deposit_obligation_id
  INTO
    v_command_source_type,
    v_command_job_id,
    v_command_invoice_id,
    v_command_deposit_id
  FROM canonical_payment_reminder_command_idempotency
  WHERE id = NEW.command_idempotency_id
  LIMIT 1;

  IF NOT FOUND
     OR v_command_source_type IS DISTINCT FROM NEW.source_type
     OR v_command_job_id IS DISTINCT FROM NEW.job_id
     OR v_command_invoice_id IS DISTINCT FROM NEW.invoice_id
     OR v_command_deposit_id IS DISTINCT FROM
       NEW.deposit_obligation_id THEN
    RAISE EXCEPTION
      'Payment Reminder command identity does not match its evidence.';
  END IF;

  IF NEW.source_type = 'INVOICE' THEN
    SELECT relationship_id
    INTO v_source_relationship_id
    FROM canonical_invoices
    WHERE id = NEW.invoice_id
      AND job_id = NEW.job_id
    LIMIT 1;

    IF NOT FOUND
       OR v_source_relationship_id IS DISTINCT FROM
         NEW.relationship_id THEN
      RAISE EXCEPTION
        'Invoice Reminder source identity is invalid.';
    END IF;
  ELSE
    SELECT relationship_id, approval_source
    INTO
      v_source_relationship_id,
      v_source_approval
    FROM canonical_pre_work_deposit_obligations
    WHERE id = NEW.deposit_obligation_id
      AND job_id = NEW.job_id
    LIMIT 1;

    IF NOT FOUND
       OR v_source_relationship_id IS DISTINCT FROM
         NEW.relationship_id
       OR v_source_approval IS DISTINCT FROM
         'MEETRO_CUSTOMER' THEN
      RAISE EXCEPTION
        'Deposit Reminder source identity is invalid.';
    END IF;
  END IF;

  SELECT
    conversation_id,
    sender_id,
    receiver_id,
    message_type,
    workflow_type,
    workflow_status,
    workflow_payload,
    created_at
  INTO
    v_message_conversation_id,
    v_message_sender_id,
    v_message_receiver_id,
    v_message_type,
    v_message_workflow_type,
    v_message_workflow_status,
    v_message_payload,
    v_message_created_at
  FROM messages
  WHERE id = NEW.message_id
  LIMIT 1;

  IF NOT FOUND
     OR v_message_conversation_id IS DISTINCT FROM
       NEW.conversation_id
     OR v_message_sender_id IS DISTINCT FROM
       NEW.sender_user_id
     OR v_message_receiver_id IS DISTINCT FROM
       NEW.recipient_user_id
     OR v_message_type IS DISTINCT FROM 'payment_reminder'
     OR v_message_workflow_type IS DISTINCT FROM
       'PAYMENT_REMINDER'
     OR v_message_workflow_status IS DISTINCT FROM 'SENT'
     OR v_message_payload ->> 'reminderId'
       IS DISTINCT FROM NEW.id::TEXT
     OR v_message_payload ->> 'sourceType'
       IS DISTINCT FROM NEW.source_type
     OR v_message_payload ->> 'jobId'
       IS DISTINCT FROM NEW.job_id::TEXT
     OR v_message_payload ->> 'sourceVersion'
       IS DISTINCT FROM NEW.source_version::TEXT
     OR v_message_payload ->> 'classification'
       IS DISTINCT FROM NEW.classification
     OR v_message_payload ->> 'classifiedOn'
       IS DISTINCT FROM NEW.classified_on::TEXT
     OR v_message_payload ->> 'timeZone'
       IS DISTINCT FROM NEW.classification_time_zone
     OR v_message_payload ->> 'currency'
       IS DISTINCT FROM NEW.currency
     OR v_message_payload ->> 'amountMinor'
       IS DISTINCT FROM NEW.amount_minor::TEXT
     OR v_message_created_at IS DISTINCT FROM NEW.sent_at THEN
    RAISE EXCEPTION
      'Payment Reminder message evidence does not match the canonical reminder.';
  END IF;

  IF NEW.source_type = 'INVOICE' THEN
    IF v_message_payload ->> 'invoiceId'
         IS DISTINCT FROM NEW.invoice_id::TEXT
       OR v_message_payload ->> 'paymentRequirementId'
         IS NOT NULL THEN
      RAISE EXCEPTION
        'Invoice Reminder message source is invalid.';
    END IF;
  ELSE
    IF v_message_payload ->> 'paymentRequirementId'
         IS DISTINCT FROM NEW.deposit_obligation_id::TEXT
       OR v_message_payload ->> 'invoiceId'
         IS NOT NULL THEN
      RAISE EXCEPTION
        'Deposit Reminder message source is invalid.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
canonical_payment_reminder_identity_guard
ON canonical_payment_reminders;

CREATE TRIGGER
canonical_payment_reminder_identity_guard
BEFORE INSERT ON canonical_payment_reminders
FOR EACH ROW
EXECUTE FUNCTION assert_canonical_payment_reminder_identity();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname =
      'canonical_payment_reminders_append_only'
  ) THEN
    CREATE TRIGGER
      canonical_payment_reminders_append_only
    BEFORE UPDATE OR DELETE
    ON canonical_payment_reminders
    FOR EACH ROW
    EXECUTE FUNCTION prevent_lifecycle_append_only_mutation();
  END IF;
END;
$$;

COMMENT ON TABLE canonical_payment_reminders IS
'Append-only Payment Reminder communication evidence. A Reminder is not Payment, approval, scheduling, or work authority.';
