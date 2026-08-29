-- MC-MAT-U1-D2: additive canonical Materials / Work Preparation authority
-- foundation. Schema and static capability vocabulary only; no business rows.

CREATE UNIQUE INDEX IF NOT EXISTS canonical_quote_version_work_preparation_source_uidx
ON canonical_quote_versions(quote_id, version, job_id, currency, integrity_hash);

CREATE UNIQUE INDEX IF NOT EXISTS canonical_quote_scope_snapshot_work_preparation_source_uidx
ON canonical_quote_scope_item_snapshots(quote_id, quote_version, scope_item_id, job_id);

CREATE UNIQUE INDEX IF NOT EXISTS participant_role_assignment_work_preparation_creator_uidx
ON participant_role_assignments(id, participant_id, job_id, role);

CREATE TABLE IF NOT EXISTS canonical_work_preparation_command_idempotency (
  id UUID PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  actor_participant_id UUID NOT NULL,
  command_name TEXT NOT NULL CHECK (command_name IN (
    'work_preparation.plan.create', 'work_preparation.plan.revise',
    'work_preparation.purchase.record', 'work_preparation.purchase.correct',
    'work_preparation.customer_item.request', 'work_preparation.customer_item.receive',
    'work_preparation.material.stage', 'work_preparation.inventory.allocate',
    'work_preparation.tools.ready', 'work_preparation.equipment.ready',
    'work_preparation.preparation.record', 'work_preparation.evidence.attach'
  )),
  command_scope TEXT NOT NULL CHECK (char_length(btrim(command_scope)) BETWEEN 1 AND 300),
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  request_fingerprint TEXT NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  result_reference JSONB,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT canonical_work_preparation_command_actor_fk
    FOREIGN KEY (actor_participant_id, job_id)
    REFERENCES relationship_participants(id, job_id) ON DELETE RESTRICT,
  CONSTRAINT canonical_work_preparation_command_result_check CHECK (
    (result_reference IS NULL AND completed_at IS NULL)
    OR (result_reference IS NOT NULL AND jsonb_typeof(result_reference) = 'object' AND completed_at IS NOT NULL)
  ),
  CONSTRAINT canonical_work_preparation_command_identity_job_key UNIQUE (id, job_id),
  CONSTRAINT canonical_work_preparation_command_actor_identity_key UNIQUE (id, job_id, actor_participant_id),
  CONSTRAINT canonical_work_preparation_command_replay_key
    UNIQUE (actor_participant_id, command_name, command_scope, idempotency_key)
);

CREATE INDEX IF NOT EXISTS canonical_work_preparation_command_job_idx
ON canonical_work_preparation_command_idempotency(job_id, command_name, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS canonical_work_preparation_plans (
  id UUID PRIMARY KEY,
  job_id UUID NOT NULL,
  job_request_id INTEGER NOT NULL,
  relationship_id INTEGER NOT NULL,
  quote_id UUID NOT NULL,
  issued_quote_version INTEGER NOT NULL CHECK (issued_quote_version >= 1),
  approved_customer_decision_id UUID NOT NULL UNIQUE,
  approved_customer_decision TEXT NOT NULL DEFAULT 'APPROVED' CHECK (approved_customer_decision = 'APPROVED'),
  customer_participant_id UUID NOT NULL,
  commercial_currency TEXT NOT NULL CHECK (commercial_currency ~ '^[A-Z]{3}$'),
  source_integrity_hash TEXT NOT NULL CHECK (source_integrity_hash ~ '^[0-9a-f]{64}$'),
  created_by_professional_participant_id UUID NOT NULL,
  created_by_role_assignment_id UUID NOT NULL,
  created_by_role TEXT NOT NULL DEFAULT 'PRIMARY_PROFESSIONAL' CHECK (created_by_role = 'PRIMARY_PROFESSIONAL'),
  created_command_idempotency_id UUID NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT canonical_work_preparation_plan_job_fk
    FOREIGN KEY (job_id, job_request_id, relationship_id)
    REFERENCES jobs(id, job_request_id, source_request_relationship_id) ON DELETE RESTRICT,
  CONSTRAINT canonical_work_preparation_plan_quote_version_fk
    FOREIGN KEY (quote_id, issued_quote_version, job_id, commercial_currency, source_integrity_hash)
    REFERENCES canonical_quote_versions(quote_id, version, job_id, currency, integrity_hash) ON DELETE RESTRICT,
  CONSTRAINT canonical_work_preparation_plan_approved_decision_fk
    FOREIGN KEY (approved_customer_decision_id, quote_id, issued_quote_version, job_id,
      relationship_id, approved_customer_decision, source_integrity_hash, customer_participant_id)
    REFERENCES canonical_quote_customer_decisions(id, quote_id, issued_quote_version, job_id,
      relationship_id, decision, issued_integrity_hash, customer_participant_id) ON DELETE RESTRICT,
  CONSTRAINT canonical_work_preparation_plan_customer_fk
    FOREIGN KEY (customer_participant_id, job_id, relationship_id)
    REFERENCES relationship_participants(id, job_id, request_relationship_id) ON DELETE RESTRICT,
  CONSTRAINT canonical_work_preparation_plan_creator_role_fk
    FOREIGN KEY (created_by_role_assignment_id, created_by_professional_participant_id, job_id, created_by_role)
    REFERENCES participant_role_assignments(id, participant_id, job_id, role) ON DELETE RESTRICT,
  CONSTRAINT canonical_work_preparation_plan_create_command_fk
    FOREIGN KEY (created_command_idempotency_id, job_id, created_by_professional_participant_id)
    REFERENCES canonical_work_preparation_command_idempotency(id, job_id, actor_participant_id) ON DELETE RESTRICT,
  CONSTRAINT canonical_work_preparation_plan_identity_job_key UNIQUE (id, job_id),
  CONSTRAINT canonical_work_preparation_plan_identity_scope_key UNIQUE (id, job_id, relationship_id),
  CONSTRAINT canonical_work_preparation_plan_source_quote_key UNIQUE (id, job_id, quote_id, issued_quote_version)
);

CREATE INDEX IF NOT EXISTS canonical_work_preparation_plan_job_idx
ON canonical_work_preparation_plans(job_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS canonical_work_preparation_plan_quote_idx
ON canonical_work_preparation_plans(quote_id, issued_quote_version, approved_customer_decision_id);

CREATE TABLE IF NOT EXISTS canonical_work_preparation_plan_versions (
  plan_id UUID NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  job_id UUID NOT NULL,
  relationship_id INTEGER NOT NULL,
  planning_state TEXT NOT NULL CHECK (planning_state IN ('PLANNING', 'PLANNED', 'RETIRED')),
  work_start_policy TEXT NOT NULL DEFAULT 'NONE' CHECK (work_start_policy IN ('NONE', 'REQUIRED_ITEMS_READY')),
  internal_notes TEXT CHECK (internal_notes IS NULL OR char_length(btrim(internal_notes)) BETWEEN 1 AND 5000),
  recorded_by_participant_id UUID NOT NULL,
  command_idempotency_id UUID NOT NULL UNIQUE,
  integrity_algorithm TEXT NOT NULL DEFAULT 'sha256' CHECK (integrity_algorithm = 'sha256'),
  integrity_hash TEXT NOT NULL CHECK (integrity_hash ~ '^[0-9a-f]{64}$'),
  integrity_version SMALLINT NOT NULL DEFAULT 1 CHECK (integrity_version = 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT canonical_work_preparation_plan_version_key PRIMARY KEY (plan_id, version),
  CONSTRAINT canonical_work_preparation_plan_version_plan_fk
    FOREIGN KEY (plan_id, job_id, relationship_id)
    REFERENCES canonical_work_preparation_plans(id, job_id, relationship_id) ON DELETE RESTRICT,
  CONSTRAINT canonical_work_preparation_plan_version_actor_fk
    FOREIGN KEY (recorded_by_participant_id, job_id, relationship_id)
    REFERENCES relationship_participants(id, job_id, request_relationship_id) ON DELETE RESTRICT,
  CONSTRAINT canonical_work_preparation_plan_version_command_fk
    FOREIGN KEY (command_idempotency_id, job_id, recorded_by_participant_id)
    REFERENCES canonical_work_preparation_command_idempotency(id, job_id, actor_participant_id) ON DELETE RESTRICT,
  CONSTRAINT canonical_work_preparation_plan_version_identity_job_key UNIQUE (plan_id, version, job_id),
  CONSTRAINT canonical_work_preparation_plan_version_identity_scope_key UNIQUE (plan_id, version, job_id, relationship_id)
);

CREATE INDEX IF NOT EXISTS canonical_work_preparation_plan_version_latest_idx
ON canonical_work_preparation_plan_versions(plan_id, version DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS canonical_work_preparation_items (
  id UUID PRIMARY KEY,
  plan_id UUID NOT NULL,
  job_id UUID NOT NULL,
  relationship_id INTEGER NOT NULL,
  created_by_participant_id UUID NOT NULL,
  created_command_idempotency_id UUID NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT canonical_work_preparation_item_plan_fk
    FOREIGN KEY (plan_id, job_id, relationship_id)
    REFERENCES canonical_work_preparation_plans(id, job_id, relationship_id) ON DELETE RESTRICT,
  CONSTRAINT canonical_work_preparation_item_actor_fk
    FOREIGN KEY (created_by_participant_id, job_id, relationship_id)
    REFERENCES relationship_participants(id, job_id, request_relationship_id) ON DELETE RESTRICT,
  CONSTRAINT canonical_work_preparation_item_command_fk
    FOREIGN KEY (created_command_idempotency_id, job_id, created_by_participant_id)
    REFERENCES canonical_work_preparation_command_idempotency(id, job_id, actor_participant_id) ON DELETE RESTRICT,
  CONSTRAINT canonical_work_preparation_item_identity_scope_key UNIQUE (id, plan_id, job_id, relationship_id)
);

CREATE INDEX IF NOT EXISTS canonical_work_preparation_item_plan_idx
ON canonical_work_preparation_items(plan_id, created_at ASC, id ASC);

CREATE TABLE IF NOT EXISTS canonical_work_preparation_item_snapshots (
  plan_id UUID NOT NULL,
  plan_version INTEGER NOT NULL CHECK (plan_version >= 1),
  item_id UUID NOT NULL,
  job_id UUID NOT NULL,
  relationship_id INTEGER NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  item_kind TEXT NOT NULL CHECK (item_kind IN ('MATERIAL', 'TOOL', 'EQUIPMENT', 'PREPARATION_TASK')),
  description TEXT NOT NULL CHECK (char_length(btrim(description)) BETWEEN 1 AND 1000),
  quantity NUMERIC(14, 3) NOT NULL CHECK (quantity > 0),
  unit TEXT NOT NULL CHECK (char_length(btrim(unit)) BETWEEN 1 AND 80),
  provider_responsibility TEXT NOT NULL CHECK (provider_responsibility IN ('BUSINESS', 'CUSTOMER')),
  commercial_treatment TEXT NOT NULL CHECK (commercial_treatment IN (
    'INCLUDED_IN_ACCEPTED_TOTAL', 'SEPARATELY_ACCEPTED', 'CUSTOMER_SUPPLIED',
    'ALLOWANCE', 'APPROVAL_REQUIRED', 'NOT_CUSTOMER_BILLABLE'
  )),
  visibility TEXT NOT NULL DEFAULT 'BUSINESS_ONLY' CHECK (visibility IN ('BUSINESS_ONLY', 'CUSTOMER_VISIBLE')),
  required_for_work_start BOOLEAN NOT NULL DEFAULT FALSE,
  internal_estimated_cost_minor BIGINT CHECK (internal_estimated_cost_minor IS NULL OR internal_estimated_cost_minor >= 0),
  internal_cost_currency TEXT CHECK (internal_cost_currency IS NULL OR internal_cost_currency ~ '^[A-Z]{3}$'),
  source_lineage TEXT NOT NULL CHECK (source_lineage IN ('QUOTE_SCOPE_ITEM', 'ACCEPTED_SCOPE_ELABORATION')),
  source_quote_id UUID NOT NULL,
  source_quote_version INTEGER NOT NULL CHECK (source_quote_version >= 1),
  source_scope_item_id UUID,
  recorded_by_participant_id UUID NOT NULL,
  command_idempotency_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT canonical_work_preparation_item_snapshot_key PRIMARY KEY (plan_id, plan_version, item_id),
  CONSTRAINT canonical_work_preparation_item_snapshot_sequence_key UNIQUE (plan_id, plan_version, sequence),
  CONSTRAINT canonical_work_preparation_item_snapshot_plan_version_fk
    FOREIGN KEY (plan_id, plan_version, job_id, relationship_id)
    REFERENCES canonical_work_preparation_plan_versions(plan_id, version, job_id, relationship_id) ON DELETE RESTRICT,
  CONSTRAINT canonical_work_preparation_item_snapshot_item_fk
    FOREIGN KEY (item_id, plan_id, job_id, relationship_id)
    REFERENCES canonical_work_preparation_items(id, plan_id, job_id, relationship_id) ON DELETE RESTRICT,
  CONSTRAINT canonical_work_preparation_item_snapshot_plan_source_fk
    FOREIGN KEY (plan_id, job_id, source_quote_id, source_quote_version)
    REFERENCES canonical_work_preparation_plans(id, job_id, quote_id, issued_quote_version) ON DELETE RESTRICT,
  CONSTRAINT canonical_work_preparation_item_snapshot_quote_scope_fk
    FOREIGN KEY (source_quote_id, source_quote_version, source_scope_item_id, job_id)
    REFERENCES canonical_quote_scope_item_snapshots(quote_id, quote_version, scope_item_id, job_id) ON DELETE RESTRICT,
  CONSTRAINT canonical_work_preparation_item_snapshot_actor_fk
    FOREIGN KEY (recorded_by_participant_id, job_id, relationship_id)
    REFERENCES relationship_participants(id, job_id, request_relationship_id) ON DELETE RESTRICT,
  CONSTRAINT canonical_work_preparation_item_snapshot_command_fk
    FOREIGN KEY (command_idempotency_id, job_id, recorded_by_participant_id)
    REFERENCES canonical_work_preparation_command_idempotency(id, job_id, actor_participant_id) ON DELETE RESTRICT,
  CONSTRAINT canonical_work_preparation_item_snapshot_cost_shape_check CHECK (
    (internal_estimated_cost_minor IS NULL AND internal_cost_currency IS NULL)
    OR (internal_estimated_cost_minor IS NOT NULL AND internal_cost_currency IS NOT NULL)
  ),
  CONSTRAINT canonical_work_preparation_item_snapshot_responsibility_check CHECK (
    (provider_responsibility = 'CUSTOMER' AND item_kind = 'MATERIAL'
      AND commercial_treatment = 'CUSTOMER_SUPPLIED'
      AND internal_estimated_cost_minor IS NULL AND internal_cost_currency IS NULL)
    OR (provider_responsibility = 'BUSINESS' AND commercial_treatment <> 'CUSTOMER_SUPPLIED')
  ),
  CONSTRAINT canonical_work_preparation_item_snapshot_nonmaterial_check CHECK (
    item_kind = 'MATERIAL'
    OR (provider_responsibility = 'BUSINESS' AND commercial_treatment = 'NOT_CUSTOMER_BILLABLE')
  ),
  CONSTRAINT canonical_work_preparation_item_snapshot_lineage_check CHECK (
    (source_lineage = 'QUOTE_SCOPE_ITEM' AND source_scope_item_id IS NOT NULL)
    OR (source_lineage = 'ACCEPTED_SCOPE_ELABORATION' AND source_scope_item_id IS NULL
      AND commercial_treatment IN ('NOT_CUSTOMER_BILLABLE', 'CUSTOMER_SUPPLIED'))
  ),
  CONSTRAINT canonical_work_preparation_item_snapshot_identity_scope_key
    UNIQUE (plan_id, plan_version, item_id, job_id, relationship_id)
);

CREATE INDEX IF NOT EXISTS canonical_work_preparation_item_snapshot_readiness_idx
ON canonical_work_preparation_item_snapshots(plan_id, plan_version, required_for_work_start, provider_responsibility, item_kind);
CREATE INDEX IF NOT EXISTS canonical_work_preparation_item_snapshot_visibility_idx
ON canonical_work_preparation_item_snapshots(job_id, visibility, plan_id, plan_version);

CREATE TABLE IF NOT EXISTS canonical_material_purchase_records (
  id UUID PRIMARY KEY,
  job_id UUID NOT NULL,
  relationship_id INTEGER NOT NULL,
  plan_id UUID NOT NULL,
  basis_plan_version INTEGER NOT NULL CHECK (basis_plan_version >= 1),
  item_id UUID NOT NULL,
  quantity NUMERIC(14, 3) NOT NULL CHECK (quantity > 0),
  unit TEXT NOT NULL CHECK (char_length(btrim(unit)) BETWEEN 1 AND 80),
  internal_cost_minor BIGINT CHECK (internal_cost_minor IS NULL OR internal_cost_minor > 0),
  internal_cost_currency TEXT CHECK (internal_cost_currency IS NULL OR internal_cost_currency ~ '^[A-Z]{3}$'),
  vendor TEXT CHECK (vendor IS NULL OR char_length(btrim(vendor)) BETWEEN 1 AND 300),
  purchased_at TIMESTAMPTZ NOT NULL,
  external_reference TEXT CHECK (external_reference IS NULL OR char_length(btrim(external_reference)) BETWEEN 1 AND 500),
  visibility TEXT NOT NULL DEFAULT 'BUSINESS_ONLY' CHECK (visibility IN ('BUSINESS_ONLY', 'CUSTOMER_VISIBLE')),
  deposit_gate_type TEXT NOT NULL CHECK (deposit_gate_type IN ('NO_DEPOSIT_REQUIRED', 'SATISFIED')),
  deposit_obligation_id UUID,
  deposit_obligation_version INTEGER CHECK (deposit_obligation_version IS NULL OR deposit_obligation_version >= 1),
  deposit_obligation_state TEXT CHECK (deposit_obligation_state IS NULL OR deposit_obligation_state = 'SATISFIED'),
  deposit_currency TEXT CHECK (deposit_currency IS NULL OR deposit_currency ~ '^[A-Z]{3}$'),
  recorded_by_participant_id UUID NOT NULL,
  command_idempotency_id UUID NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT canonical_material_purchase_plan_fk
    FOREIGN KEY (plan_id, job_id, relationship_id)
    REFERENCES canonical_work_preparation_plans(id, job_id, relationship_id) ON DELETE RESTRICT,
  CONSTRAINT canonical_material_purchase_item_snapshot_fk
    FOREIGN KEY (plan_id, basis_plan_version, item_id, job_id, relationship_id)
    REFERENCES canonical_work_preparation_item_snapshots(plan_id, plan_version, item_id, job_id, relationship_id)
    ON DELETE RESTRICT,
  CONSTRAINT canonical_material_purchase_deposit_version_fk
    FOREIGN KEY (deposit_obligation_id, deposit_obligation_version, job_id, relationship_id, deposit_currency)
    REFERENCES canonical_pre_work_deposit_versions(obligation_id, version, job_id, relationship_id, currency)
    ON DELETE RESTRICT,
  CONSTRAINT canonical_material_purchase_actor_fk
    FOREIGN KEY (recorded_by_participant_id, job_id, relationship_id)
    REFERENCES relationship_participants(id, job_id, request_relationship_id) ON DELETE RESTRICT,
  CONSTRAINT canonical_material_purchase_command_fk
    FOREIGN KEY (command_idempotency_id, job_id, recorded_by_participant_id)
    REFERENCES canonical_work_preparation_command_idempotency(id, job_id, actor_participant_id) ON DELETE RESTRICT,
  CONSTRAINT canonical_material_purchase_cost_shape_check CHECK (
    (internal_cost_minor IS NULL AND internal_cost_currency IS NULL)
    OR (internal_cost_minor IS NOT NULL AND internal_cost_currency IS NOT NULL)
  ),
  CONSTRAINT canonical_material_purchase_deposit_gate_shape_check CHECK (
    (deposit_gate_type = 'NO_DEPOSIT_REQUIRED' AND deposit_obligation_id IS NULL
      AND deposit_obligation_version IS NULL AND deposit_obligation_state IS NULL AND deposit_currency IS NULL)
    OR (deposit_gate_type = 'SATISFIED' AND deposit_obligation_id IS NOT NULL
      AND deposit_obligation_version IS NOT NULL AND deposit_obligation_state = 'SATISFIED'
      AND deposit_currency IS NOT NULL)
  ),
  CONSTRAINT canonical_material_purchase_identity_scope_key
    UNIQUE (id, plan_id, basis_plan_version, item_id, job_id, relationship_id),
  CONSTRAINT canonical_material_purchase_evidence_scope_key UNIQUE (id, plan_id, job_id, relationship_id)
);

CREATE INDEX IF NOT EXISTS canonical_material_purchase_item_idx
ON canonical_material_purchase_records(plan_id, item_id, purchased_at ASC, id ASC);
CREATE INDEX IF NOT EXISTS canonical_material_purchase_gate_idx
ON canonical_material_purchase_records(job_id, deposit_gate_type, deposit_obligation_id, deposit_obligation_version);

CREATE TABLE IF NOT EXISTS canonical_material_purchase_corrections (
  id UUID PRIMARY KEY,
  purchase_id UUID NOT NULL,
  job_id UUID NOT NULL,
  relationship_id INTEGER NOT NULL,
  plan_id UUID NOT NULL,
  basis_plan_version INTEGER NOT NULL CHECK (basis_plan_version >= 1),
  item_id UUID NOT NULL,
  reversed_quantity NUMERIC(14, 3) NOT NULL DEFAULT 0 CHECK (reversed_quantity >= 0),
  reversed_internal_cost_minor BIGINT NOT NULL DEFAULT 0 CHECK (reversed_internal_cost_minor >= 0),
  reason_category TEXT NOT NULL CHECK (reason_category IN ('RETURN', 'VOID', 'CORRECTION', 'REFUND')),
  reason TEXT NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 2000),
  corrected_at TIMESTAMPTZ NOT NULL,
  recorded_by_participant_id UUID NOT NULL,
  command_idempotency_id UUID NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT canonical_material_purchase_correction_purchase_fk
    FOREIGN KEY (purchase_id, plan_id, basis_plan_version, item_id, job_id, relationship_id)
    REFERENCES canonical_material_purchase_records(id, plan_id, basis_plan_version, item_id, job_id, relationship_id)
    ON DELETE RESTRICT,
  CONSTRAINT canonical_material_purchase_correction_actor_fk
    FOREIGN KEY (recorded_by_participant_id, job_id, relationship_id)
    REFERENCES relationship_participants(id, job_id, request_relationship_id) ON DELETE RESTRICT,
  CONSTRAINT canonical_material_purchase_correction_command_fk
    FOREIGN KEY (command_idempotency_id, job_id, recorded_by_participant_id)
    REFERENCES canonical_work_preparation_command_idempotency(id, job_id, actor_participant_id) ON DELETE RESTRICT,
  CONSTRAINT canonical_material_purchase_correction_effect_check
    CHECK (reversed_quantity > 0 OR reversed_internal_cost_minor > 0),
  CONSTRAINT canonical_material_purchase_correction_identity_scope_key
    UNIQUE (id, purchase_id, plan_id, basis_plan_version, item_id, job_id, relationship_id),
  CONSTRAINT canonical_material_purchase_correction_evidence_scope_key UNIQUE (id, plan_id, job_id, relationship_id)
);

CREATE INDEX IF NOT EXISTS canonical_material_purchase_correction_purchase_idx
ON canonical_material_purchase_corrections(purchase_id, corrected_at ASC, id ASC);

CREATE TABLE IF NOT EXISTS canonical_work_preparation_events (
  id UUID PRIMARY KEY,
  plan_id UUID NOT NULL,
  plan_version INTEGER NOT NULL CHECK (plan_version >= 1),
  item_id UUID,
  job_id UUID NOT NULL,
  relationship_id INTEGER NOT NULL,
  event_sequence INTEGER NOT NULL CHECK (event_sequence >= 1),
  previous_event_id UUID,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'PURCHASE_RECORDED', 'PURCHASE_CORRECTED', 'CUSTOMER_ITEM_REQUESTED',
    'CUSTOMER_ITEM_RECEIVED', 'MATERIAL_STAGED', 'BUSINESS_INVENTORY_ALLOCATED',
    'TOOLS_READY', 'EQUIPMENT_READY', 'PREPARATION_STARTED', 'PREPARATION_READY',
    'PREPARATION_BLOCKED'
  )),
  readiness_dimension TEXT NOT NULL CHECK (readiness_dimension IN ('ACQUISITION', 'PREPARATION')),
  resulting_readiness_state TEXT NOT NULL CHECK (resulting_readiness_state IN (
    'NOT_REQUIRED', 'NOT_STARTED', 'PARTIALLY_PURCHASED', 'PURCHASED',
    'CUSTOMER_ITEM_PENDING', 'BLOCKED', 'IN_PROGRESS', 'READY'
  )),
  visibility TEXT NOT NULL DEFAULT 'BUSINESS_ONLY' CHECK (visibility IN ('BUSINESS_ONLY', 'CUSTOMER_VISIBLE')),
  customer_visible_note TEXT CHECK (customer_visible_note IS NULL OR char_length(btrim(customer_visible_note)) BETWEEN 1 AND 1000),
  internal_note TEXT CHECK (internal_note IS NULL OR char_length(btrim(internal_note)) BETWEEN 1 AND 2000),
  purchase_id UUID,
  purchase_correction_id UUID,
  deposit_gate_type TEXT NOT NULL CHECK (deposit_gate_type IN ('NO_DEPOSIT_REQUIRED', 'SATISFIED')),
  deposit_obligation_id UUID,
  deposit_obligation_version INTEGER CHECK (deposit_obligation_version IS NULL OR deposit_obligation_version >= 1),
  deposit_obligation_state TEXT CHECK (deposit_obligation_state IS NULL OR deposit_obligation_state = 'SATISFIED'),
  deposit_currency TEXT CHECK (deposit_currency IS NULL OR deposit_currency ~ '^[A-Z]{3}$'),
  recorded_by_participant_id UUID NOT NULL,
  command_idempotency_id UUID NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT canonical_work_preparation_event_plan_version_fk
    FOREIGN KEY (plan_id, plan_version, job_id, relationship_id)
    REFERENCES canonical_work_preparation_plan_versions(plan_id, version, job_id, relationship_id) ON DELETE RESTRICT,
  CONSTRAINT canonical_work_preparation_event_item_snapshot_fk
    FOREIGN KEY (plan_id, plan_version, item_id, job_id, relationship_id)
    REFERENCES canonical_work_preparation_item_snapshots(plan_id, plan_version, item_id, job_id, relationship_id) ON DELETE RESTRICT,
  CONSTRAINT canonical_work_preparation_event_previous_fk
    FOREIGN KEY (previous_event_id, plan_id, job_id, relationship_id)
    REFERENCES canonical_work_preparation_events(id, plan_id, job_id, relationship_id) ON DELETE RESTRICT,
  CONSTRAINT canonical_work_preparation_event_purchase_fk
    FOREIGN KEY (purchase_id, plan_id, plan_version, item_id, job_id, relationship_id)
    REFERENCES canonical_material_purchase_records(id, plan_id, basis_plan_version, item_id, job_id, relationship_id)
    ON DELETE RESTRICT,
  CONSTRAINT canonical_work_preparation_event_correction_fk
    FOREIGN KEY (purchase_correction_id, purchase_id, plan_id, plan_version, item_id, job_id, relationship_id)
    REFERENCES canonical_material_purchase_corrections(id, purchase_id, plan_id, basis_plan_version, item_id, job_id, relationship_id)
    ON DELETE RESTRICT,
  CONSTRAINT canonical_work_preparation_event_deposit_version_fk
    FOREIGN KEY (deposit_obligation_id, deposit_obligation_version, job_id, relationship_id, deposit_currency)
    REFERENCES canonical_pre_work_deposit_versions(obligation_id, version, job_id, relationship_id, currency)
    ON DELETE RESTRICT,
  CONSTRAINT canonical_work_preparation_event_actor_fk
    FOREIGN KEY (recorded_by_participant_id, job_id, relationship_id)
    REFERENCES relationship_participants(id, job_id, request_relationship_id) ON DELETE RESTRICT,
  CONSTRAINT canonical_work_preparation_event_command_fk
    FOREIGN KEY (command_idempotency_id, job_id, recorded_by_participant_id)
    REFERENCES canonical_work_preparation_command_idempotency(id, job_id, actor_participant_id) ON DELETE RESTRICT,
  CONSTRAINT canonical_work_preparation_event_dimension_state_check CHECK (
    (readiness_dimension = 'ACQUISITION' AND resulting_readiness_state IN (
      'NOT_REQUIRED', 'NOT_STARTED', 'PARTIALLY_PURCHASED', 'PURCHASED',
      'CUSTOMER_ITEM_PENDING', 'BLOCKED', 'READY'))
    OR (readiness_dimension = 'PREPARATION' AND resulting_readiness_state IN (
      'NOT_STARTED', 'IN_PROGRESS', 'READY', 'BLOCKED'))
  ),
  CONSTRAINT canonical_work_preparation_event_deposit_gate_shape_check CHECK (
    (deposit_gate_type = 'NO_DEPOSIT_REQUIRED' AND deposit_obligation_id IS NULL
      AND deposit_obligation_version IS NULL AND deposit_obligation_state IS NULL AND deposit_currency IS NULL)
    OR (deposit_gate_type = 'SATISFIED' AND deposit_obligation_id IS NOT NULL
      AND deposit_obligation_version IS NOT NULL AND deposit_obligation_state = 'SATISFIED'
      AND deposit_currency IS NOT NULL)
  ),
  CONSTRAINT canonical_work_preparation_event_reference_shape_check CHECK (
    (event_type = 'PURCHASE_RECORDED' AND item_id IS NOT NULL AND purchase_id IS NOT NULL AND purchase_correction_id IS NULL)
    OR (event_type = 'PURCHASE_CORRECTED' AND item_id IS NOT NULL AND purchase_id IS NOT NULL AND purchase_correction_id IS NOT NULL)
    OR (event_type IN ('CUSTOMER_ITEM_REQUESTED', 'CUSTOMER_ITEM_RECEIVED', 'MATERIAL_STAGED',
      'BUSINESS_INVENTORY_ALLOCATED', 'TOOLS_READY', 'EQUIPMENT_READY')
      AND item_id IS NOT NULL AND purchase_id IS NULL AND purchase_correction_id IS NULL)
    OR (event_type IN ('PREPARATION_STARTED', 'PREPARATION_READY', 'PREPARATION_BLOCKED')
      AND purchase_id IS NULL AND purchase_correction_id IS NULL)
  ),
  CONSTRAINT canonical_work_preparation_event_sequence_key UNIQUE (plan_id, event_sequence),
  CONSTRAINT canonical_work_preparation_event_identity_scope_key UNIQUE (id, plan_id, job_id, relationship_id)
);

CREATE INDEX IF NOT EXISTS canonical_work_preparation_event_plan_idx
ON canonical_work_preparation_events(plan_id, event_sequence ASC, created_at ASC, id ASC);
CREATE INDEX IF NOT EXISTS canonical_work_preparation_event_readiness_idx
ON canonical_work_preparation_events(job_id, readiness_dimension, resulting_readiness_state, created_at DESC);

CREATE TABLE IF NOT EXISTS canonical_work_preparation_evidence_references (
  id UUID PRIMARY KEY,
  plan_id UUID NOT NULL,
  job_id UUID NOT NULL,
  relationship_id INTEGER NOT NULL,
  purchase_id UUID,
  purchase_correction_id UUID,
  event_id UUID,
  evidence_type TEXT NOT NULL CHECK (evidence_type IN (
    'PURCHASE_RECEIPT', 'VENDOR_INVOICE', 'PURCHASE_PHOTO', 'STAGING_PHOTO',
    'PREPARATION_PHOTO', 'EXTERNAL_REFERENCE'
  )),
  reference_namespace TEXT NOT NULL CHECK (reference_namespace ~ '^[a-z][a-z0-9_.-]{1,79}$'),
  reference_id TEXT NOT NULL CHECK (char_length(btrim(reference_id)) BETWEEN 1 AND 500),
  visibility TEXT NOT NULL DEFAULT 'BUSINESS_ONLY' CHECK (visibility IN ('BUSINESS_ONLY', 'CUSTOMER_VISIBLE')),
  recorded_by_participant_id UUID NOT NULL,
  command_idempotency_id UUID NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT canonical_work_preparation_evidence_plan_fk
    FOREIGN KEY (plan_id, job_id, relationship_id)
    REFERENCES canonical_work_preparation_plans(id, job_id, relationship_id) ON DELETE RESTRICT,
  CONSTRAINT canonical_work_preparation_evidence_purchase_fk
    FOREIGN KEY (purchase_id, plan_id, job_id, relationship_id)
    REFERENCES canonical_material_purchase_records(id, plan_id, job_id, relationship_id) ON DELETE RESTRICT,
  CONSTRAINT canonical_work_preparation_evidence_correction_fk
    FOREIGN KEY (purchase_correction_id, plan_id, job_id, relationship_id)
    REFERENCES canonical_material_purchase_corrections(id, plan_id, job_id, relationship_id) ON DELETE RESTRICT,
  CONSTRAINT canonical_work_preparation_evidence_event_fk
    FOREIGN KEY (event_id, plan_id, job_id, relationship_id)
    REFERENCES canonical_work_preparation_events(id, plan_id, job_id, relationship_id) ON DELETE RESTRICT,
  CONSTRAINT canonical_work_preparation_evidence_actor_fk
    FOREIGN KEY (recorded_by_participant_id, job_id, relationship_id)
    REFERENCES relationship_participants(id, job_id, request_relationship_id) ON DELETE RESTRICT,
  CONSTRAINT canonical_work_preparation_evidence_command_fk
    FOREIGN KEY (command_idempotency_id, job_id, recorded_by_participant_id)
    REFERENCES canonical_work_preparation_command_idempotency(id, job_id, actor_participant_id) ON DELETE RESTRICT,
  CONSTRAINT canonical_work_preparation_evidence_owner_check
    CHECK (num_nonnulls(purchase_id, purchase_correction_id, event_id) = 1),
  CONSTRAINT canonical_work_preparation_evidence_reference_key
    UNIQUE (plan_id, evidence_type, reference_namespace, reference_id)
);

CREATE INDEX IF NOT EXISTS canonical_work_preparation_evidence_owner_idx
ON canonical_work_preparation_evidence_references(plan_id, purchase_id, purchase_correction_id, event_id);
CREATE INDEX IF NOT EXISTS canonical_work_preparation_evidence_visibility_idx
ON canonical_work_preparation_evidence_references(job_id, visibility, created_at DESC);

CREATE OR REPLACE FUNCTION enforce_work_preparation_plan_version_sequence()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM canonical_work_preparation_plans
  WHERE id = NEW.plan_id AND job_id = NEW.job_id FOR UPDATE;
  IF NEW.version = 1 THEN
    IF EXISTS (SELECT 1 FROM canonical_work_preparation_plan_versions WHERE plan_id = NEW.plan_id) THEN
      RAISE EXCEPTION 'work preparation plan version 1 already exists' USING ERRCODE = '23514';
    END IF;
  ELSIF NOT EXISTS (
    SELECT 1 FROM canonical_work_preparation_plan_versions
    WHERE plan_id = NEW.plan_id AND version = NEW.version - 1
  ) THEN
    RAISE EXCEPTION 'work preparation plan versions must be contiguous' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER canonical_work_preparation_plan_version_sequence_guard
BEFORE INSERT ON canonical_work_preparation_plan_versions
FOR EACH ROW EXECUTE FUNCTION enforce_work_preparation_plan_version_sequence();

CREATE OR REPLACE FUNCTION enforce_canonical_material_purchase_item()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item_record RECORD;
BEGIN
  SELECT item_kind, provider_responsibility INTO item_record
  FROM canonical_work_preparation_item_snapshots
  WHERE plan_id = NEW.plan_id AND plan_version = NEW.basis_plan_version
    AND item_id = NEW.item_id AND job_id = NEW.job_id
    AND relationship_id = NEW.relationship_id;
  IF NOT FOUND OR item_record.item_kind <> 'MATERIAL'
    OR item_record.provider_responsibility <> 'BUSINESS' THEN
    RAISE EXCEPTION 'material purchases require an exact BUSINESS-provided MATERIAL item'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER canonical_material_purchase_item_guard
BEFORE INSERT ON canonical_material_purchase_records
FOR EACH ROW EXECUTE FUNCTION enforce_canonical_material_purchase_item();

CREATE OR REPLACE FUNCTION enforce_canonical_material_purchase_correction_limit()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  purchase_record RECORD;
  corrected_quantity NUMERIC(14, 3);
  corrected_cost BIGINT;
BEGIN
  SELECT quantity, internal_cost_minor INTO purchase_record
  FROM canonical_material_purchase_records WHERE id = NEW.purchase_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NEW; END IF;
  SELECT COALESCE(sum(reversed_quantity), 0), COALESCE(sum(reversed_internal_cost_minor), 0)
  INTO corrected_quantity, corrected_cost
  FROM canonical_material_purchase_corrections WHERE purchase_id = NEW.purchase_id;
  IF corrected_quantity + NEW.reversed_quantity > purchase_record.quantity THEN
    RAISE EXCEPTION 'material purchase quantity correction exceeds original evidence' USING ERRCODE = '23514';
  END IF;
  IF purchase_record.internal_cost_minor IS NULL THEN
    IF NEW.reversed_internal_cost_minor > 0 THEN
      RAISE EXCEPTION 'cannot reverse unrecorded internal material cost' USING ERRCODE = '23514';
    END IF;
  ELSIF corrected_cost + NEW.reversed_internal_cost_minor > purchase_record.internal_cost_minor THEN
    RAISE EXCEPTION 'material purchase cost correction exceeds original evidence' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER canonical_material_purchase_correction_limit_guard
BEFORE INSERT ON canonical_material_purchase_corrections
FOR EACH ROW EXECUTE FUNCTION enforce_canonical_material_purchase_correction_limit();

CREATE OR REPLACE FUNCTION enforce_work_preparation_event_sequence()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected_previous UUID;
BEGIN
  PERFORM 1 FROM canonical_work_preparation_plans
  WHERE id = NEW.plan_id AND job_id = NEW.job_id FOR UPDATE;
  IF NEW.event_sequence = 1 THEN
    IF NEW.previous_event_id IS NOT NULL OR EXISTS (
      SELECT 1 FROM canonical_work_preparation_events WHERE plan_id = NEW.plan_id
    ) THEN
      RAISE EXCEPTION 'first work preparation event must have no predecessor' USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT id INTO expected_previous FROM canonical_work_preparation_events
    WHERE plan_id = NEW.plan_id AND event_sequence = NEW.event_sequence - 1;
    IF expected_previous IS NULL OR NEW.previous_event_id IS DISTINCT FROM expected_previous THEN
      RAISE EXCEPTION 'work preparation events must be contiguous and exact' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER canonical_work_preparation_event_sequence_guard
BEFORE INSERT ON canonical_work_preparation_events
FOR EACH ROW EXECUTE FUNCTION enforce_work_preparation_event_sequence();

CREATE OR REPLACE FUNCTION enforce_work_preparation_event_item_semantics()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item_record RECORD;
BEGIN
  IF NEW.item_id IS NULL THEN RETURN NEW; END IF;
  SELECT item_kind, provider_responsibility INTO item_record
  FROM canonical_work_preparation_item_snapshots
  WHERE plan_id = NEW.plan_id AND plan_version = NEW.plan_version
    AND item_id = NEW.item_id AND job_id = NEW.job_id
    AND relationship_id = NEW.relationship_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF NEW.event_type IN ('CUSTOMER_ITEM_REQUESTED', 'CUSTOMER_ITEM_RECEIVED')
    AND NOT (item_record.item_kind = 'MATERIAL' AND item_record.provider_responsibility = 'CUSTOMER') THEN
    RAISE EXCEPTION 'customer item events require a CUSTOMER-provided MATERIAL item' USING ERRCODE = '23514';
  END IF;
  IF NEW.event_type IN ('MATERIAL_STAGED', 'BUSINESS_INVENTORY_ALLOCATED')
    AND NOT (item_record.item_kind = 'MATERIAL' AND item_record.provider_responsibility = 'BUSINESS') THEN
    RAISE EXCEPTION 'business material events require a BUSINESS-provided MATERIAL item' USING ERRCODE = '23514';
  END IF;
  IF NEW.event_type = 'TOOLS_READY' AND item_record.item_kind <> 'TOOL' THEN
    RAISE EXCEPTION 'TOOLS_READY requires a TOOL item' USING ERRCODE = '23514';
  END IF;
  IF NEW.event_type = 'EQUIPMENT_READY' AND item_record.item_kind <> 'EQUIPMENT' THEN
    RAISE EXCEPTION 'EQUIPMENT_READY requires an EQUIPMENT item' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER canonical_work_preparation_event_item_semantics_guard
BEFORE INSERT ON canonical_work_preparation_events
FOR EACH ROW EXECUTE FUNCTION enforce_work_preparation_event_item_semantics();

INSERT INTO lifecycle_capabilities (capability)
VALUES ('work_preparation.plan.read'), ('work_preparation.plan.write'),
  ('work_preparation.purchase.record'), ('work_preparation.preparation.record'),
  ('work_preparation.read_customer')
ON CONFLICT (capability) DO NOTHING;

-- Command idempotency is intentionally mutable only for one-time completion.
DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'canonical_work_preparation_plans', 'canonical_work_preparation_plan_versions',
    'canonical_work_preparation_items', 'canonical_work_preparation_item_snapshots',
    'canonical_material_purchase_records', 'canonical_material_purchase_corrections',
    'canonical_work_preparation_events', 'canonical_work_preparation_evidence_references'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = table_name || '_append_only' AND NOT tgisinternal) THEN
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION prevent_lifecycle_append_only_mutation()',
        table_name || '_append_only', table_name
      );
    END IF;
  END LOOP;
END $$;
