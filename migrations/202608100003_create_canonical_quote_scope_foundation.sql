-- MC-JOB-LIFECYCLE-004F-A/B/C Slice 005: canonical Quote preparation,
-- issuance, customer decision evidence, and explicit derived-Quote lineage.
-- Legacy quote_requests and browser QuoteBuilder state remain non-canonical.

INSERT INTO lifecycle_capabilities (capability)
VALUES
  ('quote.create'),
  ('quote.read'),
  ('quote.scope.manage'),
  ('quote.issue'),
  ('quote.read_customer'),
  ('quote.approve'),
  ('quote.decline'),
  ('quote.revise')
ON CONFLICT (capability) DO NOTHING;

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
      'finding.concern.link',
      'finding.evidence.add',
      'finding.confirm',
      'quote.draft.create',
      'quote.scope.add',
      'quote.scope.remove',
      'quote.issue',
      'quote.customer.approve',
      'quote.customer.decline',
      'quote.revision.create'
    )
  );

ALTER TABLE commercial_authority_evidence
  DROP CONSTRAINT IF EXISTS commercial_authority_evidence_evidence_type_check;

ALTER TABLE commercial_authority_evidence
  ADD CONSTRAINT commercial_authority_evidence_evidence_type_check
  CHECK (
    evidence_type IN (
      'commercial.aggregate.created',
      'commercial.aggregate.version_advanced',
      'evaluation_created',
      'evaluation_draft_updated',
      'evaluation_completed',
      'quote_draft_created',
      'quote_scope_item_added',
      'quote_scope_item_removed',
      'quote_issued',
      'quote_revision_created'
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
      'quote.scope.add',
      'quote.scope.remove',
      'quote.issue',
      'quote.revision.create'
    )
  );

ALTER TABLE commercial_authority_evidence
  DROP CONSTRAINT IF EXISTS commercial_authority_evidence_capability_milestone_check;

ALTER TABLE commercial_authority_evidence
  ADD CONSTRAINT commercial_authority_evidence_capability_milestone_check
  CHECK (
    capability_milestone_id IN (
      'MC-WORKFLOW-002A',
      'MC-WORKFLOW-002B',
      'MC-JOB-LIFECYCLE-004F-A',
      'MC-JOB-LIFECYCLE-004F-B',
      'MC-JOB-LIFECYCLE-004F-C'
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS
  commercial_authority_aggregates_quote_source_uidx
ON commercial_authority_aggregates(
  id,
  aggregate_type,
  owning_engine,
  ordinary_request_id,
  relationship_id
);

CREATE UNIQUE INDEX IF NOT EXISTS
  canonical_recommendation_version_quote_source_uidx
ON canonical_recommendation_versions(
  recommendation_id,
  version,
  job_id
);

CREATE TABLE IF NOT EXISTS canonical_quotes (
  id UUID PRIMARY KEY,

  aggregate_type TEXT NOT NULL DEFAULT 'quote'
    CHECK (aggregate_type = 'quote'),

  owning_engine TEXT NOT NULL DEFAULT 'authorization_engine'
    CHECK (owning_engine = 'authorization_engine'),

  job_id UUID NOT NULL,
  job_request_id INTEGER NOT NULL,
  relationship_id INTEGER NOT NULL,
  issuer_participant_id UUID NOT NULL,

  parent_quote_id UUID,
  lineage_type TEXT
    CHECK (lineage_type IN ('REVISED_QUOTE', 'SUPPLEMENTAL_QUOTE')),
  lineage_reason_category TEXT
    CHECK (
      lineage_reason_category IN (
        'SCOPE_CHANGE',
        'PRICING_CHANGE',
        'CUSTOMER_DECLINED',
        'SUPPLEMENTAL_WORK',
        'OTHER'
      )
    ),

  currency TEXT NOT NULL
    CHECK (currency ~ '^[A-Z]{3}$'),

  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (
      status IN (
        'DRAFT',
        'ISSUED'
      )
    ),

  issued_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT canonical_quote_aggregate_source_fk
    FOREIGN KEY (
      id,
      aggregate_type,
      owning_engine,
      job_request_id,
      relationship_id
    )
    REFERENCES commercial_authority_aggregates(
      id,
      aggregate_type,
      owning_engine,
      ordinary_request_id,
      relationship_id
    )
    ON DELETE RESTRICT,

  CONSTRAINT canonical_quote_job_fk
    FOREIGN KEY (job_id, job_request_id, relationship_id)
    REFERENCES jobs(id, job_request_id, source_request_relationship_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_quote_issuer_fk
    FOREIGN KEY (issuer_participant_id, job_id)
    REFERENCES relationship_participants(id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_quote_parent_fk
    FOREIGN KEY (parent_quote_id, job_id)
    REFERENCES canonical_quotes(id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_quote_lineage_shape_check
    CHECK (
      (
        parent_quote_id IS NULL
        AND lineage_type IS NULL
        AND lineage_reason_category IS NULL
      )
      OR
      (
        parent_quote_id IS NOT NULL
        AND parent_quote_id <> id
        AND lineage_type IS NOT NULL
        AND lineage_reason_category IS NOT NULL
      )
    ),

  CONSTRAINT canonical_quote_identity_job_key
    UNIQUE (id, job_id),

  CONSTRAINT canonical_quote_issued_time_check
    CHECK (
      (status = 'DRAFT' AND issued_at IS NULL)
      OR (status <> 'DRAFT' AND issued_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS canonical_quote_one_draft_per_job_uidx
ON canonical_quotes(job_id)
WHERE status = 'DRAFT';

CREATE UNIQUE INDEX IF NOT EXISTS canonical_quote_one_root_per_job_uidx
ON canonical_quotes(job_id)
WHERE parent_quote_id IS NULL;

CREATE INDEX IF NOT EXISTS canonical_quote_job_status_idx
ON canonical_quotes(job_id, status, updated_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS canonical_quote_versions (
  quote_id UUID NOT NULL,
  version INTEGER NOT NULL
    CHECK (version >= 1),
  job_id UUID NOT NULL,

  status TEXT NOT NULL
    CHECK (
      status IN (
        'DRAFT',
        'ISSUED',
        'APPROVED',
        'DECLINED',
        'SUPERSEDED'
      )
    ),

  currency TEXT NOT NULL
    CHECK (currency ~ '^[A-Z]{3}$'),

  materials_subtotal_minor BIGINT NOT NULL DEFAULT 0
    CHECK (materials_subtotal_minor >= 0),
  labor_service_subtotal_minor BIGINT NOT NULL DEFAULT 0
    CHECK (labor_service_subtotal_minor >= 0),
  total_minor BIGINT NOT NULL DEFAULT 0
    CHECK (total_minor >= 0),
  scope_item_count INTEGER NOT NULL DEFAULT 0
    CHECK (scope_item_count >= 0),

  conditions_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(conditions_snapshot) = 'array'),
  exclusions_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(exclusions_snapshot) = 'array'),

  issued_at TIMESTAMPTZ,

  created_by_participant_id UUID NOT NULL,

  integrity_algorithm TEXT NOT NULL DEFAULT 'sha256'
    CHECK (integrity_algorithm = 'sha256'),
  integrity_hash TEXT NOT NULL
    CHECK (integrity_hash ~ '^[0-9a-f]{64}$'),
  integrity_version SMALLINT NOT NULL DEFAULT 1
    CHECK (integrity_version = 1),

  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT canonical_quote_version_key
    PRIMARY KEY (quote_id, version),

  CONSTRAINT canonical_quote_version_identity_fk
    FOREIGN KEY (quote_id, job_id)
    REFERENCES canonical_quotes(id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_quote_version_actor_fk
    FOREIGN KEY (created_by_participant_id, job_id)
    REFERENCES relationship_participants(id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_quote_version_total_check
    CHECK (
      total_minor =
        materials_subtotal_minor + labor_service_subtotal_minor
    ),

  CONSTRAINT canonical_quote_version_scope_key
    UNIQUE (quote_id, version, job_id),

  CONSTRAINT canonical_quote_version_issuance_key
    UNIQUE (
      quote_id,
      version,
      job_id,
      status,
      issued_at,
      integrity_hash
    ),

  CONSTRAINT canonical_quote_version_issued_time_check
    CHECK (
      (status = 'DRAFT' AND issued_at IS NULL)
      OR (status <> 'DRAFT' AND issued_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS canonical_quote_version_history_idx
ON canonical_quote_versions(quote_id, version ASC, created_at ASC);

CREATE TABLE IF NOT EXISTS canonical_quote_scope_items (
  id UUID PRIMARY KEY,
  quote_id UUID NOT NULL,
  job_id UUID NOT NULL,
  created_by_participant_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT canonical_quote_scope_item_quote_fk
    FOREIGN KEY (quote_id, job_id)
    REFERENCES canonical_quotes(id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_quote_scope_item_actor_fk
    FOREIGN KEY (created_by_participant_id, job_id)
    REFERENCES relationship_participants(id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_quote_scope_item_identity_key
    UNIQUE (id, quote_id, job_id)
);

CREATE TABLE IF NOT EXISTS canonical_quote_scope_item_snapshots (
  quote_id UUID NOT NULL,
  quote_version INTEGER NOT NULL,
  scope_item_id UUID NOT NULL,
  scope_item_revision INTEGER NOT NULL DEFAULT 1
    CHECK (scope_item_revision >= 1),
  job_id UUID NOT NULL,
  sequence INTEGER NOT NULL
    CHECK (sequence >= 1),

  classification TEXT NOT NULL
    CHECK (classification IN ('MATERIAL', 'LABOR_SERVICE')),

  scope_semantic TEXT NOT NULL
    CHECK (
      scope_semantic IN (
        'COMPLETED_BILLABLE_SERVICE',
        'TEMPORARY_SERVICE',
        'FUTURE_WORK',
        'MATERIAL_INCLUDED',
        'MATERIAL_EXCLUDED',
        'CUSTOMER_SUPPLIED_MATERIAL',
        'SEPARATE_PROPOSAL'
      )
    ),

  material_responsibility TEXT NOT NULL
    CHECK (
      material_responsibility IN (
        'PROFESSIONAL_SUPPLIED',
        'CUSTOMER_SUPPLIED',
        'EXCLUDED',
        'PENDING_SELECTION',
        'NOT_APPLICABLE'
      )
    ),

  description TEXT NOT NULL
    CHECK (char_length(btrim(description)) BETWEEN 1 AND 1000),

  quantity INTEGER NOT NULL DEFAULT 1
    CHECK (quantity BETWEEN 1 AND 10000),
  unit_amount_minor BIGINT NOT NULL
    CHECK (unit_amount_minor >= 0),
  line_total_minor BIGINT NOT NULL
    CHECK (line_total_minor >= 0),
  included_in_total BOOLEAN NOT NULL,

  source_type TEXT NOT NULL
    CHECK (
      source_type IN (
        'FINDING',
        'RECOMMENDATION',
        'WORKSTREAM',
        'WORK_ACTIVITY',
        'WORKSTREAM_OBLIGATION',
        'MANUAL_PROFESSIONAL'
      )
    ),
  source_version INTEGER
    CHECK (source_version IS NULL OR source_version >= 1),
  source_workstream_version INTEGER
    CHECK (
      source_workstream_version IS NULL
      OR source_workstream_version >= 1
    ),
  source_finding_id UUID,
  source_recommendation_id UUID,
  source_workstream_id UUID,
  source_activity_id UUID,
  source_obligation_id UUID,

  created_by_participant_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT canonical_quote_scope_snapshot_key
    PRIMARY KEY (quote_id, quote_version, scope_item_id),

  CONSTRAINT canonical_quote_scope_snapshot_sequence_key
    UNIQUE (quote_id, quote_version, sequence),

  CONSTRAINT canonical_quote_scope_snapshot_quote_version_fk
    FOREIGN KEY (quote_id, quote_version, job_id)
    REFERENCES canonical_quote_versions(quote_id, version, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_quote_scope_snapshot_item_fk
    FOREIGN KEY (scope_item_id, quote_id, job_id)
    REFERENCES canonical_quote_scope_items(id, quote_id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_quote_scope_snapshot_actor_fk
    FOREIGN KEY (created_by_participant_id, job_id)
    REFERENCES relationship_participants(id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_quote_scope_snapshot_finding_fk
    FOREIGN KEY (source_finding_id, source_version, job_id)
    REFERENCES canonical_evaluation_finding_versions(
      finding_id,
      version,
      job_id
    )
    ON DELETE RESTRICT,

  CONSTRAINT canonical_quote_scope_snapshot_recommendation_fk
    FOREIGN KEY (source_recommendation_id, source_version, job_id)
    REFERENCES canonical_recommendation_versions(
      recommendation_id,
      version,
      job_id
    )
    ON DELETE RESTRICT,

  CONSTRAINT canonical_quote_scope_snapshot_workstream_fk
    FOREIGN KEY (source_workstream_id, source_workstream_version, job_id)
    REFERENCES canonical_workstream_versions(workstream_id, version, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_quote_scope_snapshot_activity_fk
    FOREIGN KEY (
      source_activity_id,
      source_version,
      source_workstream_id,
      job_id
    )
    REFERENCES canonical_work_activity_versions(
      activity_id,
      version,
      workstream_id,
      job_id
    )
    ON DELETE RESTRICT,

  CONSTRAINT canonical_quote_scope_snapshot_obligation_fk
    FOREIGN KEY (
      source_obligation_id,
      source_version,
      source_workstream_id,
      job_id
    )
    REFERENCES canonical_workstream_obligation_versions(
      obligation_id,
      version,
      workstream_id,
      job_id
    )
    ON DELETE RESTRICT,

  CONSTRAINT canonical_quote_scope_snapshot_amount_check
    CHECK (line_total_minor = unit_amount_minor * quantity),

  CONSTRAINT canonical_quote_scope_snapshot_commercial_shape_check
    CHECK (
      (
        classification = 'MATERIAL'
        AND scope_semantic IN (
          'MATERIAL_INCLUDED',
          'MATERIAL_EXCLUDED',
          'CUSTOMER_SUPPLIED_MATERIAL',
          'SEPARATE_PROPOSAL'
        )
        AND material_responsibility <> 'NOT_APPLICABLE'
      )
      OR
      (
        classification = 'LABOR_SERVICE'
        AND scope_semantic IN (
          'COMPLETED_BILLABLE_SERVICE',
          'TEMPORARY_SERVICE',
          'FUTURE_WORK',
          'SEPARATE_PROPOSAL'
        )
        AND material_responsibility = 'NOT_APPLICABLE'
      )
    ),

  CONSTRAINT canonical_quote_scope_snapshot_inclusion_check
    CHECK (
      included_in_total = (
        (
          classification = 'MATERIAL'
          AND scope_semantic = 'MATERIAL_INCLUDED'
          AND material_responsibility = 'PROFESSIONAL_SUPPLIED'
        )
        OR
        (
          classification = 'LABOR_SERVICE'
          AND scope_semantic IN (
            'COMPLETED_BILLABLE_SERVICE',
            'TEMPORARY_SERVICE',
            'FUTURE_WORK'
          )
        )
      )
    ),

  CONSTRAINT canonical_quote_scope_snapshot_source_shape_check
    CHECK (
      (
        source_type = 'MANUAL_PROFESSIONAL'
        AND source_version IS NULL
        AND source_workstream_version IS NULL
        AND source_finding_id IS NULL
        AND source_recommendation_id IS NULL
        AND source_workstream_id IS NULL
        AND source_activity_id IS NULL
        AND source_obligation_id IS NULL
      )
      OR
      (
        source_type = 'FINDING'
        AND source_version IS NOT NULL
        AND source_workstream_version IS NULL
        AND source_finding_id IS NOT NULL
        AND source_recommendation_id IS NULL
        AND source_workstream_id IS NULL
        AND source_activity_id IS NULL
        AND source_obligation_id IS NULL
      )
      OR
      (
        source_type = 'RECOMMENDATION'
        AND source_version IS NOT NULL
        AND source_workstream_version IS NULL
        AND source_finding_id IS NULL
        AND source_recommendation_id IS NOT NULL
        AND source_workstream_id IS NULL
        AND source_activity_id IS NULL
        AND source_obligation_id IS NULL
      )
      OR
      (
        source_type = 'WORKSTREAM'
        AND source_version IS NULL
        AND source_workstream_version IS NOT NULL
        AND source_finding_id IS NULL
        AND source_recommendation_id IS NULL
        AND source_workstream_id IS NOT NULL
        AND source_activity_id IS NULL
        AND source_obligation_id IS NULL
      )
      OR
      (
        source_type = 'WORK_ACTIVITY'
        AND source_version IS NOT NULL
        AND source_workstream_version IS NULL
        AND source_finding_id IS NULL
        AND source_recommendation_id IS NULL
        AND source_workstream_id IS NOT NULL
        AND source_activity_id IS NOT NULL
        AND source_obligation_id IS NULL
      )
      OR
      (
        source_type = 'WORKSTREAM_OBLIGATION'
        AND source_version IS NOT NULL
        AND source_workstream_version IS NULL
        AND source_finding_id IS NULL
        AND source_recommendation_id IS NULL
        AND source_workstream_id IS NOT NULL
        AND source_activity_id IS NULL
        AND source_obligation_id IS NOT NULL
      )
    )
);

CREATE INDEX IF NOT EXISTS canonical_quote_scope_snapshot_order_idx
ON canonical_quote_scope_item_snapshots(
  quote_id,
  quote_version,
  sequence ASC,
  scope_item_id ASC
);

CREATE INDEX IF NOT EXISTS canonical_quote_scope_source_lookup_idx
ON canonical_quote_scope_item_snapshots(
  source_type,
  source_finding_id,
  source_recommendation_id,
  source_workstream_id,
  source_activity_id,
  source_obligation_id,
  source_version,
  source_workstream_version
);

CREATE TABLE IF NOT EXISTS canonical_quote_issuances (
  quote_id UUID PRIMARY KEY,
  quote_version INTEGER NOT NULL,
  job_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'ISSUED'
    CHECK (status = 'ISSUED'),
  issuer_participant_id UUID NOT NULL,
  authority_grant_id UUID NOT NULL,
  commercial_evidence_id UUID NOT NULL UNIQUE,
  idempotency_id UUID NOT NULL UNIQUE,
  issued_at TIMESTAMPTZ NOT NULL,
  source_snapshot_integrity_hash TEXT NOT NULL
    CHECK (source_snapshot_integrity_hash ~ '^[0-9a-f]{64}$'),

  CONSTRAINT canonical_quote_issuance_version_fk
    FOREIGN KEY (
      quote_id,
      quote_version,
      job_id,
      status,
      issued_at,
      source_snapshot_integrity_hash
    )
    REFERENCES canonical_quote_versions(
      quote_id,
      version,
      job_id,
      status,
      issued_at,
      integrity_hash
    )
    ON DELETE RESTRICT,

  CONSTRAINT canonical_quote_issuance_actor_fk
    FOREIGN KEY (issuer_participant_id, job_id)
    REFERENCES relationship_participants(id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_quote_issuance_grant_fk
    FOREIGN KEY (authority_grant_id, job_id)
    REFERENCES lifecycle_authority_grants(id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_quote_issuance_evidence_fk
    FOREIGN KEY (commercial_evidence_id)
    REFERENCES commercial_authority_evidence(id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_quote_issuance_idempotency_fk
    FOREIGN KEY (idempotency_id)
    REFERENCES commercial_command_idempotency(id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS canonical_quote_issuance_job_idx
ON canonical_quote_issuances(job_id, issued_at DESC, quote_id);

CREATE UNIQUE INDEX IF NOT EXISTS canonical_quote_issuance_decision_source_uidx
ON canonical_quote_issuances(
  quote_id,
  quote_version,
  job_id,
  source_snapshot_integrity_hash
);

CREATE UNIQUE INDEX IF NOT EXISTS
  relationship_participant_quote_decision_scope_uidx
ON relationship_participants(id, job_id, request_relationship_id);

CREATE TABLE IF NOT EXISTS canonical_quote_customer_decisions (
  id UUID PRIMARY KEY,
  quote_id UUID NOT NULL UNIQUE,
  issued_quote_version INTEGER NOT NULL,
  job_id UUID NOT NULL,
  relationship_id INTEGER NOT NULL,
  customer_participant_id UUID NOT NULL,
  authority_grant_id UUID NOT NULL,
  decision TEXT NOT NULL
    CHECK (decision IN ('APPROVED', 'DECLINED')),
  idempotency_id UUID NOT NULL UNIQUE,
  issued_integrity_hash TEXT NOT NULL
    CHECK (issued_integrity_hash ~ '^[0-9a-f]{64}$'),
  decided_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT canonical_quote_customer_decision_issuance_fk
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

  CONSTRAINT canonical_quote_customer_decision_relationship_fk
    FOREIGN KEY (relationship_id)
    REFERENCES request_relationships(id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_quote_customer_decision_actor_fk
    FOREIGN KEY (customer_participant_id, job_id, relationship_id)
    REFERENCES relationship_participants(id, job_id, request_relationship_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_quote_customer_decision_grant_fk
    FOREIGN KEY (authority_grant_id, job_id)
    REFERENCES lifecycle_authority_grants(id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT canonical_quote_customer_decision_idempotency_fk
    FOREIGN KEY (idempotency_id)
    REFERENCES commercial_command_idempotency(id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS canonical_quote_customer_decision_job_idx
ON canonical_quote_customer_decisions(
  job_id,
  decided_at DESC,
  quote_id
);

CREATE OR REPLACE FUNCTION prevent_canonical_quote_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'canonical Quote history is append-only';
END;
$$;

CREATE OR REPLACE FUNCTION prevent_canonical_quote_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'canonical Quote identity cannot be deleted';
END;
$$;

CREATE OR REPLACE FUNCTION protect_canonical_quote_identity_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'issued canonical Quote identity is immutable';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.aggregate_type IS DISTINCT FROM OLD.aggregate_type
    OR NEW.owning_engine IS DISTINCT FROM OLD.owning_engine
    OR NEW.job_id IS DISTINCT FROM OLD.job_id
    OR NEW.job_request_id IS DISTINCT FROM OLD.job_request_id
    OR NEW.relationship_id IS DISTINCT FROM OLD.relationship_id
    OR NEW.issuer_participant_id IS DISTINCT FROM OLD.issuer_participant_id
    OR NEW.parent_quote_id IS DISTINCT FROM OLD.parent_quote_id
    OR NEW.lineage_type IS DISTINCT FROM OLD.lineage_type
    OR NEW.lineage_reason_category IS DISTINCT FROM OLD.lineage_reason_category
    OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'canonical Quote identity fields are immutable';
  END IF;

  IF NEW.status = 'DRAFT' AND NEW.issued_at IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'ISSUED'
    AND OLD.issued_at IS NULL
    AND NEW.issued_at IS NOT NULL
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'canonical Quote status transition is not permitted';
END;
$$;

DO $$
DECLARE
  table_name TEXT;
  trigger_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'canonical_quote_versions',
    'canonical_quote_scope_items',
    'canonical_quote_scope_item_snapshots',
    'canonical_quote_issuances',
    'canonical_quote_customer_decisions'
  ]
  LOOP
    trigger_name := table_name || '_append_only';
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgname = trigger_name AND NOT tgisinternal
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I '
        'FOR EACH ROW EXECUTE FUNCTION prevent_canonical_quote_history_mutation()',
        trigger_name,
        table_name
      );
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'canonical_quotes_prevent_delete' AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER canonical_quotes_prevent_delete
    BEFORE DELETE ON canonical_quotes
    FOR EACH ROW EXECUTE FUNCTION prevent_canonical_quote_delete();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'canonical_quotes_protect_update' AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER canonical_quotes_protect_update
    BEFORE UPDATE ON canonical_quotes
    FOR EACH ROW EXECUTE FUNCTION protect_canonical_quote_identity_update();
  END IF;
END;
$$;
