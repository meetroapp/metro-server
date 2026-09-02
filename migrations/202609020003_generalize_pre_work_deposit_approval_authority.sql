-- MC-QUOTE-EXTERNAL-APPROVAL-U1-D3A
-- Generalize pre-work deposit/payment authority from authenticated
-- customer decisions to origin-neutral canonical Quote approvals.
--
-- Marketplace provenance remains intact.
-- Business-document Jobs never fabricate request relationships or
-- customer participants.
-- Quote approval never constitutes payment evidence.

CREATE UNIQUE INDEX IF NOT EXISTS
canonical_quote_approvals_deposit_source_uidx
ON canonical_quote_approvals (
  id,
  quote_id,
  issued_quote_version,
  job_id,
  approval_source,
  issued_integrity_hash
);

CREATE UNIQUE INDEX IF NOT EXISTS
canonical_quote_approvals_deposit_customer_uidx
ON canonical_quote_approvals (
  id,
  customer_decision_id
);

ALTER TABLE canonical_pre_work_deposit_obligations
  ADD COLUMN IF NOT EXISTS quote_approval_id UUID,
  ADD COLUMN IF NOT EXISTS approval_source TEXT;

-- Historical obligations are append-only. Verify their exact marketplace
-- approval provenance without writing the new identity into old evidence.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM canonical_pre_work_deposit_obligations obligations
    LEFT JOIN canonical_quote_approvals approvals
      ON approvals.customer_decision_id = obligations.customer_decision_id
     AND approvals.quote_id = obligations.quote_id
     AND approvals.issued_quote_version = obligations.issued_quote_version
     AND approvals.job_id = obligations.job_id
     AND approvals.issued_integrity_hash = obligations.source_integrity_hash
     AND approvals.approval_source = 'MEETRO_CUSTOMER'
    WHERE approvals.id IS NULL
  ) THEN
    RAISE EXCEPTION
      'Existing deposit obligations could not be reconciled to canonical Quote approvals.';
  END IF;
END;
$$;

-- NOT VALID preserves historical NULL identity while enforcing common approval
-- on every new obligation. Existing append-only protection remains intact.
ALTER TABLE canonical_pre_work_deposit_obligations
  ADD CONSTRAINT canonical_pre_work_deposit_new_approval_required
  CHECK (quote_approval_id IS NOT NULL AND approval_source IS NOT NULL) NOT VALID;

ALTER TABLE canonical_pre_work_deposit_obligations
  ALTER COLUMN job_request_id DROP NOT NULL,
  ALTER COLUMN relationship_id DROP NOT NULL,
  ALTER COLUMN customer_decision_id DROP NOT NULL,
  ALTER COLUMN customer_decision DROP NOT NULL,
  ALTER COLUMN customer_decision DROP DEFAULT,
  ALTER COLUMN customer_participant_id DROP NOT NULL;

ALTER TABLE canonical_pre_work_deposit_obligations
  ADD CONSTRAINT canonical_pre_work_deposit_approval_source_check
  CHECK (
    approval_source IN (
      'MEETRO_CUSTOMER',
      'EXTERNAL_EVIDENCE'
    )
  );

ALTER TABLE canonical_pre_work_deposit_obligations
  ADD CONSTRAINT canonical_pre_work_deposit_source_shape_check
  CHECK (
    (
      approval_source = 'MEETRO_CUSTOMER'
      AND job_request_id IS NOT NULL
      AND relationship_id IS NOT NULL
      AND customer_decision_id IS NOT NULL
      AND customer_decision = 'APPROVED'
      AND customer_participant_id IS NOT NULL
    )
    OR
    (
      approval_source = 'EXTERNAL_EVIDENCE'
      AND job_request_id IS NULL
      AND relationship_id IS NULL
      AND customer_decision_id IS NULL
      AND customer_decision IS NULL
      AND customer_participant_id IS NULL
    )
  );

ALTER TABLE canonical_pre_work_deposit_obligations
  ADD CONSTRAINT canonical_pre_work_deposit_quote_approval_key
  UNIQUE (quote_approval_id);

ALTER TABLE canonical_pre_work_deposit_obligations
  ADD CONSTRAINT canonical_pre_work_deposit_generic_scope_key
  UNIQUE (id, job_id, currency);

ALTER TABLE canonical_pre_work_deposit_obligations
  ADD CONSTRAINT canonical_pre_work_deposit_approval_fk
  FOREIGN KEY (
    quote_approval_id,
    quote_id,
    issued_quote_version,
    job_id,
    approval_source,
    source_integrity_hash
  )
  REFERENCES canonical_quote_approvals (
    id,
    quote_id,
    issued_quote_version,
    job_id,
    approval_source,
    issued_integrity_hash
  )
  ON DELETE RESTRICT;

ALTER TABLE canonical_pre_work_deposit_obligations
  ADD CONSTRAINT canonical_pre_work_deposit_approval_customer_fk
  FOREIGN KEY (
    quote_approval_id,
    customer_decision_id
  )
  REFERENCES canonical_quote_approvals (
    id,
    customer_decision_id
  )
  ON DELETE RESTRICT;

ALTER TABLE canonical_pre_work_deposit_obligations
  ADD CONSTRAINT canonical_pre_work_deposit_creator_job_fk
  FOREIGN KEY (
    created_by_participant_id,
    job_id
  )
  REFERENCES relationship_participants (
    id,
    job_id
  )
  ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS
canonical_pre_work_deposit_quote_approval_idx
ON canonical_pre_work_deposit_obligations (
  quote_id,
  issued_quote_version,
  quote_approval_id
);

-- ---------------------------------------------------------------------------
-- Relationship-neutral deposit/payment history
-- ---------------------------------------------------------------------------

ALTER TABLE canonical_pre_work_deposit_versions
  ALTER COLUMN relationship_id DROP NOT NULL;

ALTER TABLE canonical_pre_work_payment_receipts
  ALTER COLUMN relationship_id DROP NOT NULL;

ALTER TABLE canonical_pre_work_payment_allocations
  ALTER COLUMN relationship_id DROP NOT NULL;

ALTER TABLE canonical_pre_work_payment_allocation_reversals
  ALTER COLUMN relationship_id DROP NOT NULL;

ALTER TABLE canonical_pre_work_deposit_versions
  ADD CONSTRAINT canonical_pre_work_deposit_version_obligation_generic_fk
  FOREIGN KEY (
    obligation_id,
    job_id,
    currency
  )
  REFERENCES canonical_pre_work_deposit_obligations (
    id,
    job_id,
    currency
  )
  ON DELETE RESTRICT;

ALTER TABLE canonical_pre_work_payment_receipts
  ADD CONSTRAINT canonical_pre_work_payment_receipt_generic_scope_key
  UNIQUE (
    id,
    job_id,
    currency
  );

ALTER TABLE canonical_pre_work_payment_receipts
  ADD CONSTRAINT canonical_pre_work_payment_receipt_actor_job_fk
  FOREIGN KEY (
    recorded_by_participant_id,
    job_id
  )
  REFERENCES relationship_participants (
    id,
    job_id
  )
  ON DELETE RESTRICT;

ALTER TABLE canonical_pre_work_payment_allocations
  ADD CONSTRAINT canonical_pre_work_payment_allocation_generic_scope_key
  UNIQUE (
    id,
    receipt_id,
    obligation_id,
    job_id,
    currency
  );

ALTER TABLE canonical_pre_work_payment_allocations
  ADD CONSTRAINT canonical_pre_work_payment_allocation_obligation_generic_fk
  FOREIGN KEY (
    obligation_id,
    job_id,
    currency
  )
  REFERENCES canonical_pre_work_deposit_obligations (
    id,
    job_id,
    currency
  )
  ON DELETE RESTRICT;

ALTER TABLE canonical_pre_work_payment_allocations
  ADD CONSTRAINT canonical_pre_work_payment_allocation_receipt_generic_fk
  FOREIGN KEY (
    receipt_id,
    job_id,
    currency
  )
  REFERENCES canonical_pre_work_payment_receipts (
    id,
    job_id,
    currency
  )
  ON DELETE RESTRICT;

ALTER TABLE canonical_pre_work_payment_allocation_reversals
  ADD CONSTRAINT canonical_pre_work_payment_reversal_allocation_generic_fk
  FOREIGN KEY (
    allocation_id,
    receipt_id,
    obligation_id,
    job_id,
    currency
  )
  REFERENCES canonical_pre_work_payment_allocations (
    id,
    receipt_id,
    obligation_id,
    job_id,
    currency
  )
  ON DELETE RESTRICT;

-- Existing relationship-specific FKs deliberately remain.
--
-- For ordinary_request_selection rows they continue to prove exact request
-- relationship provenance.
--
-- For business_document rows relationship_id is NULL, so the generic FKs
-- above provide the required canonical identity enforcement.

-- ---------------------------------------------------------------------------
-- Job-origin guards
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION assert_pre_work_deposit_obligation_job_origin()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_source_type TEXT;
  v_job_request_id INTEGER;
  v_relationship_id INTEGER;
BEGIN
  SELECT
    jobs.source_type,
    jobs.job_request_id,
    jobs.source_request_relationship_id
  INTO
    v_source_type,
    v_job_request_id,
    v_relationship_id
  FROM jobs
  WHERE jobs.id = NEW.job_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Pre-work deposit obligation Job is unavailable.';
  END IF;

  IF v_source_type = 'ordinary_request_selection' THEN
    IF NEW.approval_source IS DISTINCT FROM 'MEETRO_CUSTOMER'
       OR NEW.job_request_id IS DISTINCT FROM v_job_request_id
       OR NEW.relationship_id IS DISTINCT FROM v_relationship_id THEN
      RAISE EXCEPTION
        'Marketplace deposit obligation source does not match its Job.';
    END IF;
  ELSIF v_source_type = 'business_document' THEN
    IF NEW.approval_source IS DISTINCT FROM 'EXTERNAL_EVIDENCE'
       OR NEW.job_request_id IS NOT NULL
       OR NEW.relationship_id IS NOT NULL THEN
      RAISE EXCEPTION
        'Business-document deposit obligation cannot carry request relationship authority.';
    END IF;
  ELSE
    RAISE EXCEPTION
      'Unsupported pre-work deposit Job source type.';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION assert_pre_work_payment_relationship_job_origin()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_source_type TEXT;
  v_relationship_id INTEGER;
BEGIN
  SELECT
    jobs.source_type,
    jobs.source_request_relationship_id
  INTO
    v_source_type,
    v_relationship_id
  FROM jobs
  WHERE jobs.id = NEW.job_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Pre-work payment Job is unavailable.';
  END IF;

  IF v_source_type = 'ordinary_request_selection' THEN
    IF NEW.relationship_id IS NULL
       OR NEW.relationship_id IS DISTINCT FROM v_relationship_id THEN
      RAISE EXCEPTION
        'Marketplace pre-work payment relationship does not match its Job.';
    END IF;
  ELSIF v_source_type = 'business_document' THEN
    IF NEW.relationship_id IS NOT NULL THEN
      RAISE EXCEPTION
        'Business-document pre-work payment evidence cannot carry request relationship authority.';
    END IF;
  ELSE
    RAISE EXCEPTION
      'Unsupported pre-work payment Job source type.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
canonical_pre_work_deposit_obligation_origin_guard
ON canonical_pre_work_deposit_obligations;

CREATE TRIGGER canonical_pre_work_deposit_obligation_origin_guard
BEFORE INSERT OR UPDATE
ON canonical_pre_work_deposit_obligations
FOR EACH ROW
EXECUTE FUNCTION assert_pre_work_deposit_obligation_job_origin();

DROP TRIGGER IF EXISTS
canonical_pre_work_deposit_version_origin_guard
ON canonical_pre_work_deposit_versions;

CREATE TRIGGER canonical_pre_work_deposit_version_origin_guard
BEFORE INSERT OR UPDATE
ON canonical_pre_work_deposit_versions
FOR EACH ROW
EXECUTE FUNCTION assert_pre_work_payment_relationship_job_origin();

DROP TRIGGER IF EXISTS
canonical_pre_work_payment_receipt_origin_guard
ON canonical_pre_work_payment_receipts;

CREATE TRIGGER canonical_pre_work_payment_receipt_origin_guard
BEFORE INSERT OR UPDATE
ON canonical_pre_work_payment_receipts
FOR EACH ROW
EXECUTE FUNCTION assert_pre_work_payment_relationship_job_origin();

DROP TRIGGER IF EXISTS
canonical_pre_work_payment_allocation_origin_guard
ON canonical_pre_work_payment_allocations;

CREATE TRIGGER canonical_pre_work_payment_allocation_origin_guard
BEFORE INSERT OR UPDATE
ON canonical_pre_work_payment_allocations
FOR EACH ROW
EXECUTE FUNCTION assert_pre_work_payment_relationship_job_origin();

DROP TRIGGER IF EXISTS
canonical_pre_work_payment_reversal_origin_guard
ON canonical_pre_work_payment_allocation_reversals;

CREATE TRIGGER canonical_pre_work_payment_reversal_origin_guard
BEFORE INSERT OR UPDATE
ON canonical_pre_work_payment_allocation_reversals
FOR EACH ROW
EXECUTE FUNCTION assert_pre_work_payment_relationship_job_origin();

-- ---------------------------------------------------------------------------
-- Validate every historical row before accepting the generalized contract.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM canonical_pre_work_deposit_obligations obligations
    INNER JOIN jobs ON jobs.id = obligations.job_id
    WHERE
      (
        jobs.source_type = 'ordinary_request_selection'
        AND (
          COALESCE(obligations.approval_source, 'MEETRO_CUSTOMER') <> 'MEETRO_CUSTOMER'
          OR obligations.job_request_id
             IS DISTINCT FROM jobs.job_request_id
          OR obligations.relationship_id
             IS DISTINCT FROM jobs.source_request_relationship_id
        )
      )
      OR
      (
        jobs.source_type = 'business_document'
        AND (
          obligations.approval_source <> 'EXTERNAL_EVIDENCE'
          OR obligations.job_request_id IS NOT NULL
          OR obligations.relationship_id IS NOT NULL
        )
      )
  ) THEN
    RAISE EXCEPTION
      'Historical deposit obligation Job-origin provenance is invalid.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM canonical_pre_work_deposit_versions records
    INNER JOIN jobs ON jobs.id = records.job_id
    WHERE
      (
        jobs.source_type = 'ordinary_request_selection'
        AND records.relationship_id
            IS DISTINCT FROM jobs.source_request_relationship_id
      )
      OR
      (
        jobs.source_type = 'business_document'
        AND records.relationship_id IS NOT NULL
      )
  ) THEN
    RAISE EXCEPTION
      'Historical deposit version Job-origin provenance is invalid.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM canonical_pre_work_payment_receipts records
    INNER JOIN jobs ON jobs.id = records.job_id
    WHERE
      (
        jobs.source_type = 'ordinary_request_selection'
        AND records.relationship_id
            IS DISTINCT FROM jobs.source_request_relationship_id
      )
      OR
      (
        jobs.source_type = 'business_document'
        AND records.relationship_id IS NOT NULL
      )
  ) THEN
    RAISE EXCEPTION
      'Historical payment receipt Job-origin provenance is invalid.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM canonical_pre_work_payment_allocations records
    INNER JOIN jobs ON jobs.id = records.job_id
    WHERE
      (
        jobs.source_type = 'ordinary_request_selection'
        AND records.relationship_id
            IS DISTINCT FROM jobs.source_request_relationship_id
      )
      OR
      (
        jobs.source_type = 'business_document'
        AND records.relationship_id IS NOT NULL
      )
  ) THEN
    RAISE EXCEPTION
      'Historical payment allocation Job-origin provenance is invalid.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM canonical_pre_work_payment_allocation_reversals records
    INNER JOIN jobs ON jobs.id = records.job_id
    WHERE
      (
        jobs.source_type = 'ordinary_request_selection'
        AND records.relationship_id
            IS DISTINCT FROM jobs.source_request_relationship_id
      )
      OR
      (
        jobs.source_type = 'business_document'
        AND records.relationship_id IS NOT NULL
      )
  ) THEN
    RAISE EXCEPTION
      'Historical payment reversal Job-origin provenance is invalid.';
  END IF;
END;
$$;

COMMENT ON COLUMN
canonical_pre_work_deposit_obligations.quote_approval_id IS
  'Origin-neutral approval for new obligations; historical marketplace rows retain NULL and resolve exact approval from immutable customer-decision provenance.';

COMMENT ON COLUMN
canonical_pre_work_deposit_obligations.approval_source IS
  'MEETRO_CUSTOMER preserves authenticated customer-decision provenance; EXTERNAL_EVIDENCE preserves business-recorded external approval provenance.';

COMMENT ON COLUMN
canonical_pre_work_deposit_obligations.relationship_id IS
  'Exact request relationship for marketplace Jobs; NULL for business-document Jobs.';

COMMENT ON COLUMN
canonical_pre_work_payment_receipts.relationship_id IS
  'Exact request relationship for marketplace Jobs; NULL for business-document Jobs.';

COMMENT ON COLUMN
canonical_pre_work_payment_allocations.relationship_id IS
  'Exact request relationship for marketplace Jobs; NULL for business-document Jobs.';

COMMENT ON COLUMN
canonical_pre_work_payment_allocation_reversals.relationship_id IS
  'Exact request relationship for marketplace Jobs; NULL for business-document Jobs.';
