-- MC-QUOTE-EXTERNAL-APPROVED-WORK-U1-D3B1
--
-- Generalize Approved Work Visit authority to canonical_quote_approvals.
--
-- Historical decision-based activation/grant/Visit rows remain immutable.
-- New Approved Work authority must carry canonical Quote approval identity.
--
-- MEETRO_CUSTOMER:
--   common Quote approval + authenticated customer-decision provenance.
--
-- EXTERNAL_EVIDENCE:
--   common Quote approval only; no fabricated customer decision,
--   relationship participant, or customer authority.
--
-- This migration does not generalize Approved Work execution/start authority.
-- External scheduling confirmation is separately governed after PROPOSED.

-- ---------------------------------------------------------------------------
-- Canonical Quote approval FK targets
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS
canonical_quote_approvals_work_job_source_uidx
ON canonical_quote_approvals (
  id,
  job_id,
  approval_source
);

CREATE UNIQUE INDEX IF NOT EXISTS
canonical_quote_approvals_work_quote_source_uidx
ON canonical_quote_approvals (
  id,
  quote_id,
  job_id,
  approval_source
);

-- ---------------------------------------------------------------------------
-- Fail closed if historical decision-based Approved Work evidence cannot
-- be reconciled to the common Quote approval authority introduced earlier.
-- No historical row is modified.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM canonical_approved_work_visit_authority_activations activations
    LEFT JOIN canonical_quote_approvals approvals
      ON approvals.customer_decision_id =
         activations.approved_quote_decision_id
     AND approvals.quote_id = activations.quote_id
     AND approvals.job_id = activations.job_id
     AND approvals.approval_source = 'MEETRO_CUSTOMER'
    WHERE approvals.id IS NULL
  ) THEN
    RAISE EXCEPTION
      'Historical Approved Work Visit activation cannot be reconciled to canonical Quote approval.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM lifecycle_authority_grants grants
    LEFT JOIN canonical_quote_approvals approvals
      ON approvals.customer_decision_id =
         grants.scope_approved_quote_decision_id
     AND approvals.job_id = grants.job_id
     AND approvals.approval_source = 'MEETRO_CUSTOMER'
    WHERE grants.scope_type = 'approved_work'
      AND approvals.id IS NULL
  ) THEN
    RAISE EXCEPTION
      'Historical Approved Work lifecycle grant cannot be reconciled to canonical Quote approval.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM canonical_visits visits
    LEFT JOIN canonical_quote_approvals approvals
      ON approvals.customer_decision_id =
         visits.approved_quote_decision_id
     AND approvals.job_id = visits.job_id
     AND approvals.approval_source = 'MEETRO_CUSTOMER'
    WHERE visits.purpose = 'APPROVED_WORK'
      AND approvals.id IS NULL
  ) THEN
    RAISE EXCEPTION
      'Historical Approved Work Visit cannot be reconciled to canonical Quote approval.';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- Approved Work Visit authority activation
-- ---------------------------------------------------------------------------

ALTER TABLE canonical_approved_work_visit_authority_activations
  ADD COLUMN IF NOT EXISTS quote_approval_id UUID,
  ADD COLUMN IF NOT EXISTS approval_source TEXT;

ALTER TABLE canonical_approved_work_visit_authority_activations
  ALTER COLUMN approved_quote_decision_id DROP NOT NULL,
  ALTER COLUMN approved_quote_decision DROP NOT NULL,
  ALTER COLUMN approved_quote_decision DROP DEFAULT;

ALTER TABLE canonical_approved_work_visit_authority_activations
  ADD CONSTRAINT canonical_approved_work_visit_activation_common_source_check
  CHECK (
    quote_approval_id IS NOT NULL
    AND approval_source IN (
      'MEETRO_CUSTOMER',
      'EXTERNAL_EVIDENCE'
    )
    AND (
      (
        approval_source = 'MEETRO_CUSTOMER'
        AND approved_quote_decision_id IS NOT NULL
        AND approved_quote_decision = 'APPROVED'
      )
      OR
      (
        approval_source = 'EXTERNAL_EVIDENCE'
        AND approved_quote_decision_id IS NULL
        AND approved_quote_decision IS NULL
      )
    )
  )
  NOT VALID;

ALTER TABLE canonical_approved_work_visit_authority_activations
  ADD CONSTRAINT canonical_approved_work_visit_activation_approval_fk
  FOREIGN KEY (
    quote_approval_id,
    quote_id,
    job_id,
    approval_source
  )
  REFERENCES canonical_quote_approvals (
    id,
    quote_id,
    job_id,
    approval_source
  )
  ON DELETE RESTRICT;

ALTER TABLE canonical_approved_work_visit_authority_activations
  ADD CONSTRAINT canonical_approved_work_visit_activation_customer_binding_fk
  FOREIGN KEY (
    quote_approval_id,
    approved_quote_decision_id
  )
  REFERENCES canonical_quote_approvals (
    id,
    customer_decision_id
  )
  ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS
canonical_approved_work_visit_activation_approval_uidx
ON canonical_approved_work_visit_authority_activations (
  quote_approval_id,
  job_id
)
WHERE quote_approval_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS
canonical_approved_work_visit_activation_approval_idx
ON canonical_approved_work_visit_authority_activations (
  job_id,
  quote_approval_id,
  created_at
);

-- ---------------------------------------------------------------------------
-- Origin-neutral Approved Work lifecycle grant scope
-- ---------------------------------------------------------------------------

ALTER TABLE lifecycle_authority_grants
  ADD COLUMN IF NOT EXISTS scope_quote_approval_id UUID,
  ADD COLUMN IF NOT EXISTS scope_quote_approval_source TEXT;

ALTER TABLE lifecycle_authority_grants
  DROP CONSTRAINT IF EXISTS
  lifecycle_authority_grants_scope_shape_check;

ALTER TABLE lifecycle_authority_grants
  ADD CONSTRAINT lifecycle_authority_grants_scope_shape_v2_check
  CHECK (
    (
      scope_type = 'job'
      AND scope_concern_id IS NULL
      AND scope_evaluation_id IS NULL
      AND scope_approved_quote_decision_id IS NULL
      AND scope_approved_quote_decision IS NULL
      AND scope_quote_approval_id IS NULL
      AND scope_quote_approval_source IS NULL
    )
    OR
    (
      scope_type = 'reported_concern'
      AND scope_concern_id IS NOT NULL
      AND scope_evaluation_id IS NULL
      AND scope_approved_quote_decision_id IS NULL
      AND scope_approved_quote_decision IS NULL
      AND scope_quote_approval_id IS NULL
      AND scope_quote_approval_source IS NULL
    )
    OR
    (
      scope_type = 'evaluation'
      AND scope_concern_id IS NULL
      AND scope_evaluation_id IS NOT NULL
      AND scope_approved_quote_decision_id IS NULL
      AND scope_approved_quote_decision IS NULL
      AND scope_quote_approval_id IS NULL
      AND scope_quote_approval_source IS NULL
    )
    OR
    (
      scope_type = 'approved_work'
      AND scope_concern_id IS NULL
      AND scope_evaluation_id IS NULL
      AND scope_quote_approval_id IS NOT NULL
      AND scope_quote_approval_source IN (
        'MEETRO_CUSTOMER',
        'EXTERNAL_EVIDENCE'
      )
      AND (
        (
          scope_quote_approval_source = 'MEETRO_CUSTOMER'
          AND scope_approved_quote_decision_id IS NOT NULL
          AND scope_approved_quote_decision = 'APPROVED'
        )
        OR
        (
          scope_quote_approval_source = 'EXTERNAL_EVIDENCE'
          AND scope_approved_quote_decision_id IS NULL
          AND scope_approved_quote_decision IS NULL
        )
      )
    )
    OR
    (
      scope_type = 'evaluation_visit'
      AND scope_job_id = job_id
      AND scope_concern_id IS NULL
      AND scope_evaluation_id IS NULL
      AND scope_approved_quote_decision_id IS NULL
      AND scope_approved_quote_decision IS NULL
      AND scope_quote_approval_id IS NULL
      AND scope_quote_approval_source IS NULL
    )
  )
  NOT VALID;

ALTER TABLE lifecycle_authority_grants
  ADD CONSTRAINT lifecycle_authority_grants_approved_work_approval_fk
  FOREIGN KEY (
    scope_quote_approval_id,
    job_id,
    scope_quote_approval_source
  )
  REFERENCES canonical_quote_approvals (
    id,
    job_id,
    approval_source
  )
  ON DELETE RESTRICT;

ALTER TABLE lifecycle_authority_grants
  ADD CONSTRAINT lifecycle_authority_grants_approved_work_customer_binding_fk
  FOREIGN KEY (
    scope_quote_approval_id,
    scope_approved_quote_decision_id
  )
  REFERENCES canonical_quote_approvals (
    id,
    customer_decision_id
  )
  ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS
lifecycle_authority_grants_quote_approval_idx
ON lifecycle_authority_grants (
  scope_quote_approval_id,
  grantee_participant_id,
  capability
)
WHERE scope_type = 'approved_work';

COMMENT ON COLUMN
lifecycle_authority_grants.scope_quote_approval_id IS
  'Canonical Quote approval scope for new Approved Work authority grants. Historical decision-only grants remain immutable.';

COMMENT ON COLUMN
lifecycle_authority_grants.scope_quote_approval_source IS
  'MEETRO_CUSTOMER or EXTERNAL_EVIDENCE for new Approved Work grants; NULL on historical pre-generalization rows.';

-- ---------------------------------------------------------------------------
-- Origin-neutral canonical Approved Work Visit identity
-- ---------------------------------------------------------------------------

ALTER TABLE canonical_visits
  ADD COLUMN IF NOT EXISTS quote_approval_id UUID,
  ADD COLUMN IF NOT EXISTS quote_approval_source TEXT;

ALTER TABLE canonical_visits
  DROP CONSTRAINT IF EXISTS
  canonical_visit_approved_work_evidence_shape_check;

ALTER TABLE canonical_visits
  ADD CONSTRAINT canonical_visit_approved_work_evidence_shape_v2_check
  CHECK (
    (
      purpose = 'APPROVED_WORK'
      AND quote_approval_id IS NOT NULL
      AND quote_approval_source IN (
        'MEETRO_CUSTOMER',
        'EXTERNAL_EVIDENCE'
      )
      AND (
        (
          quote_approval_source = 'MEETRO_CUSTOMER'
          AND approved_quote_decision_id IS NOT NULL
          AND approved_quote_decision = 'APPROVED'
        )
        OR
        (
          quote_approval_source = 'EXTERNAL_EVIDENCE'
          AND approved_quote_decision_id IS NULL
          AND approved_quote_decision IS NULL
        )
      )
    )
    OR
    (
      purpose IN ('EVALUATION', 'FOLLOW_UP')
      AND quote_approval_id IS NULL
      AND quote_approval_source IS NULL
      AND approved_quote_decision_id IS NULL
      AND approved_quote_decision IS NULL
    )
  )
  NOT VALID;

ALTER TABLE canonical_visits
  ADD CONSTRAINT canonical_visit_quote_approval_fk
  FOREIGN KEY (
    quote_approval_id,
    job_id,
    quote_approval_source
  )
  REFERENCES canonical_quote_approvals (
    id,
    job_id,
    approval_source
  )
  ON DELETE RESTRICT;

ALTER TABLE canonical_visits
  ADD CONSTRAINT canonical_visit_quote_approval_customer_binding_fk
  FOREIGN KEY (
    quote_approval_id,
    approved_quote_decision_id
  )
  REFERENCES canonical_quote_approvals (
    id,
    customer_decision_id
  )
  ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS
canonical_visit_quote_approval_idx
ON canonical_visits (
  quote_approval_id,
  job_id
)
WHERE quote_approval_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS
canonical_visit_approved_work_approval_identity_uidx
ON canonical_visits (
  id,
  job_id,
  purpose,
  quote_approval_id
);

COMMENT ON COLUMN
canonical_visits.quote_approval_id IS
  'Canonical Quote approval authorizing a new Approved Work Visit. Historical pre-generalization Approved Work Visits remain decision-linked only.';

COMMENT ON COLUMN
canonical_visits.quote_approval_source IS
  'MEETRO_CUSTOMER or EXTERNAL_EVIDENCE for new Approved Work Visits.';

COMMENT ON COLUMN
canonical_approved_work_visit_authority_activations.quote_approval_id IS
  'Canonical Quote approval authorizing this Approved Work Visit activation. Historical rows remain decision-linked only.';

COMMENT ON COLUMN
canonical_approved_work_visit_authority_activations.approval_source IS
  'MEETRO_CUSTOMER or EXTERNAL_EVIDENCE for new Approved Work activation evidence.';
