-- MC-WORK-U1-D2: additive canonical Approved Work execution authority
-- foundation. Schema and static capability vocabulary only; no business rows.

INSERT INTO lifecycle_capabilities (capability)
VALUES
  ('approved_work.execution.manage'),
  ('approved_work.execute')
ON CONFLICT (capability) DO NOTHING;

CREATE UNIQUE INDEX IF NOT EXISTS canonical_approved_work_execution_scope_source_uidx
ON canonical_quote_scope_item_snapshots(
  quote_id, quote_version, scope_item_id, job_id, included_in_total
);

CREATE UNIQUE INDEX IF NOT EXISTS canonical_work_activity_execution_start_source_uidx
ON canonical_work_activity_versions(
  activity_id, version, workstream_id, job_id, status
);

CREATE UNIQUE INDEX IF NOT EXISTS canonical_visit_approved_work_execution_source_uidx
ON canonical_visits(
  id, job_id, purpose, approved_quote_decision_id
);

CREATE TABLE IF NOT EXISTS canonical_approved_work_execution_command_idempotency (
  id UUID PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  actor_participant_id UUID NOT NULL,
  command_name TEXT NOT NULL CHECK (command_name IN (
    'approved_work.execution.materialize',
    'approved_work.execution.bind_workstream',
    'approved_work.execution.classify_activity',
    'approved_work.execution.supersede',
    'approved_work.execution.close',
    'approved_work.execution.reconcile_legacy',
    'approved_work.execution.start.record'
  )),
  command_scope TEXT NOT NULL
    CHECK (char_length(btrim(command_scope)) BETWEEN 1 AND 300),
  idempotency_key TEXT NOT NULL
    CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  request_fingerprint TEXT NOT NULL
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  result_reference JSONB,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT canonical_approved_work_execution_command_actor_fk
    FOREIGN KEY (actor_participant_id, job_id)
    REFERENCES relationship_participants(id, job_id) ON DELETE RESTRICT,
  CONSTRAINT canonical_approved_work_execution_command_result_check CHECK (
    (result_reference IS NULL AND completed_at IS NULL)
    OR (
      result_reference IS NOT NULL
      AND jsonb_typeof(result_reference) = 'object'
      AND completed_at IS NOT NULL
    )
  ),
  CONSTRAINT canonical_approved_work_execution_command_identity_job_key
    UNIQUE (id, job_id),
  CONSTRAINT canonical_approved_work_execution_command_actor_identity_key
    UNIQUE (id, job_id, actor_participant_id),
  CONSTRAINT canonical_approved_work_execution_command_replay_key
    UNIQUE (actor_participant_id, command_name, command_scope, idempotency_key)
);

CREATE INDEX IF NOT EXISTS canonical_approved_work_execution_command_job_idx
ON canonical_approved_work_execution_command_idempotency(
  job_id, command_name, created_at DESC, id DESC
);

CREATE TABLE IF NOT EXISTS canonical_approved_work_executions (
  id UUID PRIMARY KEY,
  job_id UUID NOT NULL,
  job_request_id INTEGER NOT NULL,
  relationship_id INTEGER NOT NULL,
  quote_id UUID NOT NULL,
  issued_quote_version INTEGER NOT NULL CHECK (issued_quote_version >= 1),
  approved_customer_decision_id UUID NOT NULL UNIQUE,
  approved_customer_decision TEXT NOT NULL DEFAULT 'APPROVED'
    CHECK (approved_customer_decision = 'APPROVED'),
  commercial_currency TEXT NOT NULL CHECK (commercial_currency ~ '^[A-Z]{3}$'),
  source_integrity_hash TEXT NOT NULL
    CHECK (source_integrity_hash ~ '^[0-9a-f]{64}$'),
  customer_participant_id UUID NOT NULL,
  created_by_professional_participant_id UUID NOT NULL,
  created_by_role_assignment_id UUID NOT NULL,
  created_by_role TEXT NOT NULL DEFAULT 'PRIMARY_PROFESSIONAL'
    CHECK (created_by_role = 'PRIMARY_PROFESSIONAL'),
  created_command_idempotency_id UUID NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT canonical_approved_work_execution_job_fk
    FOREIGN KEY (job_id, job_request_id, relationship_id)
    REFERENCES jobs(id, job_request_id, source_request_relationship_id)
    ON DELETE RESTRICT,
  CONSTRAINT canonical_approved_work_execution_quote_version_fk
    FOREIGN KEY (
      quote_id, issued_quote_version, job_id, commercial_currency,
      source_integrity_hash
    )
    REFERENCES canonical_quote_versions(
      quote_id, version, job_id, currency, integrity_hash
    ) ON DELETE RESTRICT,
  CONSTRAINT canonical_approved_work_execution_decision_fk
    FOREIGN KEY (
      approved_customer_decision_id, quote_id, issued_quote_version, job_id,
      relationship_id, approved_customer_decision, source_integrity_hash,
      customer_participant_id
    )
    REFERENCES canonical_quote_customer_decisions(
      id, quote_id, issued_quote_version, job_id, relationship_id, decision,
      issued_integrity_hash, customer_participant_id
    ) ON DELETE RESTRICT,
  CONSTRAINT canonical_approved_work_execution_customer_fk
    FOREIGN KEY (customer_participant_id, job_id, relationship_id)
    REFERENCES relationship_participants(id, job_id, request_relationship_id)
    ON DELETE RESTRICT,
  CONSTRAINT canonical_approved_work_execution_creator_role_fk
    FOREIGN KEY (
      created_by_role_assignment_id, created_by_professional_participant_id,
      job_id, created_by_role
    )
    REFERENCES participant_role_assignments(id, participant_id, job_id, role)
    ON DELETE RESTRICT,
  CONSTRAINT canonical_approved_work_execution_create_command_fk
    FOREIGN KEY (
      created_command_idempotency_id, job_id,
      created_by_professional_participant_id
    )
    REFERENCES canonical_approved_work_execution_command_idempotency(
      id, job_id, actor_participant_id
    ) ON DELETE RESTRICT,
  CONSTRAINT canonical_approved_work_execution_identity_scope_key
    UNIQUE (id, job_id, relationship_id),
  CONSTRAINT canonical_approved_work_execution_customer_scope_key
    UNIQUE (id, job_id, relationship_id, customer_participant_id),
  CONSTRAINT canonical_approved_work_execution_decision_scope_key
    UNIQUE (
      id, approved_customer_decision_id, job_id, relationship_id
    ),
  CONSTRAINT canonical_approved_work_execution_quote_scope_key
    UNIQUE (id, quote_id, issued_quote_version, job_id)
);

CREATE INDEX IF NOT EXISTS canonical_approved_work_execution_job_idx
ON canonical_approved_work_executions(
  job_id, created_at ASC, approved_customer_decision_id ASC
);

CREATE INDEX IF NOT EXISTS canonical_approved_work_execution_quote_idx
ON canonical_approved_work_executions(
  quote_id, issued_quote_version, approved_customer_decision_id
);

CREATE TABLE IF NOT EXISTS canonical_approved_work_execution_versions (
  execution_id UUID NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  job_id UUID NOT NULL,
  relationship_id INTEGER NOT NULL,
  customer_participant_id UUID NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('ACTIVE', 'SUPERSEDED', 'CLOSED')),
  successor_execution_id UUID,
  recorded_by_participant_id UUID NOT NULL,
  command_idempotency_id UUID NOT NULL UNIQUE,
  integrity_algorithm TEXT NOT NULL DEFAULT 'sha256'
    CHECK (integrity_algorithm = 'sha256'),
  integrity_hash TEXT NOT NULL CHECK (integrity_hash ~ '^[0-9a-f]{64}$'),
  integrity_version SMALLINT NOT NULL DEFAULT 1 CHECK (integrity_version = 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT canonical_approved_work_execution_version_key
    PRIMARY KEY (execution_id, version),
  CONSTRAINT canonical_approved_work_execution_version_execution_fk
    FOREIGN KEY (
      execution_id, job_id, relationship_id, customer_participant_id
    )
    REFERENCES canonical_approved_work_executions(
      id, job_id, relationship_id, customer_participant_id
    ) ON DELETE RESTRICT,
  CONSTRAINT canonical_approved_work_execution_version_successor_fk
    FOREIGN KEY (
      successor_execution_id, job_id, relationship_id, customer_participant_id
    )
    REFERENCES canonical_approved_work_executions(
      id, job_id, relationship_id, customer_participant_id
    ) ON DELETE RESTRICT,
  CONSTRAINT canonical_approved_work_execution_version_actor_fk
    FOREIGN KEY (recorded_by_participant_id, job_id, relationship_id)
    REFERENCES relationship_participants(id, job_id, request_relationship_id)
    ON DELETE RESTRICT,
  CONSTRAINT canonical_approved_work_execution_version_command_fk
    FOREIGN KEY (
      command_idempotency_id, job_id, recorded_by_participant_id
    )
    REFERENCES canonical_approved_work_execution_command_idempotency(
      id, job_id, actor_participant_id
    ) ON DELETE RESTRICT,
  CONSTRAINT canonical_approved_work_execution_version_state_shape_check CHECK (
    (
      state IN ('ACTIVE', 'CLOSED')
      AND successor_execution_id IS NULL
    )
    OR (
      state = 'SUPERSEDED'
      AND successor_execution_id IS NOT NULL
      AND successor_execution_id <> execution_id
    )
  ),
  CONSTRAINT canonical_approved_work_execution_version_identity_scope_key
    UNIQUE (execution_id, version, job_id, relationship_id),
  CONSTRAINT canonical_approved_work_execution_version_state_scope_key
    UNIQUE (execution_id, version, job_id, state)
);

CREATE INDEX IF NOT EXISTS canonical_approved_work_execution_version_latest_idx
ON canonical_approved_work_execution_versions(
  execution_id, version DESC, created_at DESC
);

CREATE OR REPLACE FUNCTION enforce_approved_work_execution_version_sequence()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  previous_version INTEGER;
  previous_state TEXT;
  creates_cycle BOOLEAN;
BEGIN
  PERFORM 1
  FROM canonical_approved_work_executions
  WHERE id = NEW.execution_id
    AND job_id = NEW.job_id
    AND relationship_id = NEW.relationship_id
  FOR UPDATE;

  SELECT version, state
  INTO previous_version, previous_state
  FROM canonical_approved_work_execution_versions
  WHERE execution_id = NEW.execution_id
  ORDER BY version DESC
  LIMIT 1;

  IF NEW.version = 1 THEN
    IF previous_version IS NOT NULL OR NEW.state <> 'ACTIVE' THEN
      RAISE EXCEPTION 'approved Work execution version 1 must be the first ACTIVE version'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    IF previous_version IS NULL OR previous_version <> NEW.version - 1 THEN
      RAISE EXCEPTION 'approved Work execution versions must be contiguous'
        USING ERRCODE = '23514';
    END IF;
    IF previous_state <> 'ACTIVE' OR NEW.state = 'ACTIVE' THEN
      RAISE EXCEPTION 'approved Work execution terminal state cannot transition'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.state = 'SUPERSEDED' THEN
    WITH RECURSIVE successor_chain(execution_id) AS (
      SELECT NEW.successor_execution_id
      UNION
      SELECT current.successor_execution_id
      FROM successor_chain chain
      JOIN LATERAL (
        SELECT versions.successor_execution_id
        FROM canonical_approved_work_execution_versions versions
        WHERE versions.execution_id = chain.execution_id
          AND versions.state = 'SUPERSEDED'
        ORDER BY versions.version DESC
        LIMIT 1
      ) current ON current.successor_execution_id IS NOT NULL
    )
    SELECT EXISTS (
      SELECT 1 FROM successor_chain
      WHERE execution_id = NEW.execution_id
    ) INTO creates_cycle;
    IF creates_cycle THEN
      RAISE EXCEPTION 'approved Work execution supersession cannot be circular'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER canonical_approved_work_execution_version_sequence_guard
BEFORE INSERT ON canonical_approved_work_execution_versions
FOR EACH ROW EXECUTE FUNCTION enforce_approved_work_execution_version_sequence();

CREATE TABLE IF NOT EXISTS canonical_approved_work_execution_workstreams (
  id UUID PRIMARY KEY,
  execution_id UUID NOT NULL,
  workstream_id UUID NOT NULL UNIQUE,
  job_id UUID NOT NULL,
  relationship_id INTEGER NOT NULL,
  bound_by_professional_participant_id UUID NOT NULL,
  bound_by_role_assignment_id UUID NOT NULL,
  bound_by_role TEXT NOT NULL DEFAULT 'PRIMARY_PROFESSIONAL'
    CHECK (bound_by_role = 'PRIMARY_PROFESSIONAL'),
  command_idempotency_id UUID NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT canonical_approved_work_execution_workstream_execution_fk
    FOREIGN KEY (execution_id, job_id, relationship_id)
    REFERENCES canonical_approved_work_executions(id, job_id, relationship_id)
    ON DELETE RESTRICT,
  CONSTRAINT canonical_approved_work_execution_workstream_job_fk
    FOREIGN KEY (job_id, relationship_id)
    REFERENCES jobs(id, source_request_relationship_id) ON DELETE RESTRICT,
  CONSTRAINT canonical_approved_work_execution_workstream_workstream_fk
    FOREIGN KEY (workstream_id, job_id)
    REFERENCES canonical_workstreams(id, job_id) ON DELETE RESTRICT,
  CONSTRAINT canonical_approved_work_execution_workstream_actor_role_fk
    FOREIGN KEY (
      bound_by_role_assignment_id, bound_by_professional_participant_id,
      job_id, bound_by_role
    )
    REFERENCES participant_role_assignments(id, participant_id, job_id, role)
    ON DELETE RESTRICT,
  CONSTRAINT canonical_approved_work_execution_workstream_command_fk
    FOREIGN KEY (
      command_idempotency_id, job_id,
      bound_by_professional_participant_id
    )
    REFERENCES canonical_approved_work_execution_command_idempotency(
      id, job_id, actor_participant_id
    ) ON DELETE RESTRICT,
  CONSTRAINT canonical_approved_work_execution_workstream_scope_key
    UNIQUE (execution_id, workstream_id, job_id, relationship_id),
  CONSTRAINT canonical_approved_work_execution_workstream_identity_job_key
    UNIQUE (id, job_id)
);

CREATE INDEX IF NOT EXISTS canonical_approved_work_execution_workstream_execution_idx
ON canonical_approved_work_execution_workstreams(
  execution_id, created_at ASC, workstream_id ASC
);

CREATE TABLE IF NOT EXISTS canonical_work_activity_execution_classifications (
  activity_id UUID PRIMARY KEY,
  classified_activity_version INTEGER NOT NULL
    CHECK (classified_activity_version >= 1),
  workstream_id UUID NOT NULL,
  job_id UUID NOT NULL,
  relationship_id INTEGER NOT NULL,
  classification TEXT NOT NULL
    CHECK (classification IN ('EXECUTION', 'NON_EXECUTION')),
  execution_id UUID,
  scope_basis TEXT CHECK (scope_basis IN ('DECISION_WIDE', 'QUOTE_SCOPE_ITEM')),
  source_quote_id UUID,
  source_quote_version INTEGER CHECK (
    source_quote_version IS NULL OR source_quote_version >= 1
  ),
  source_scope_item_id UUID,
  source_scope_included_in_total BOOLEAN,
  classified_by_participant_id UUID NOT NULL,
  command_idempotency_id UUID NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT canonical_work_activity_execution_classification_activity_fk
    FOREIGN KEY (activity_id, workstream_id, job_id)
    REFERENCES canonical_work_activities(id, workstream_id, job_id)
    ON DELETE RESTRICT,
  CONSTRAINT canonical_work_activity_execution_classification_version_fk
    FOREIGN KEY (
      activity_id, classified_activity_version, workstream_id, job_id
    )
    REFERENCES canonical_work_activity_versions(
      activity_id, version, workstream_id, job_id
    ) ON DELETE RESTRICT,
  CONSTRAINT canonical_work_activity_execution_classification_job_fk
    FOREIGN KEY (job_id, relationship_id)
    REFERENCES jobs(id, source_request_relationship_id) ON DELETE RESTRICT,
  CONSTRAINT canonical_work_activity_execution_classification_binding_fk
    FOREIGN KEY (execution_id, workstream_id, job_id, relationship_id)
    REFERENCES canonical_approved_work_execution_workstreams(
      execution_id, workstream_id, job_id, relationship_id
    ) ON DELETE RESTRICT,
  CONSTRAINT canonical_work_activity_execution_classification_quote_fk
    FOREIGN KEY (
      execution_id, source_quote_id, source_quote_version, job_id
    )
    REFERENCES canonical_approved_work_executions(
      id, quote_id, issued_quote_version, job_id
    ) ON DELETE RESTRICT,
  CONSTRAINT canonical_work_activity_execution_classification_scope_fk
    FOREIGN KEY (
      source_quote_id, source_quote_version, source_scope_item_id, job_id,
      source_scope_included_in_total
    )
    REFERENCES canonical_quote_scope_item_snapshots(
      quote_id, quote_version, scope_item_id, job_id, included_in_total
    ) ON DELETE RESTRICT,
  CONSTRAINT canonical_work_activity_execution_classification_actor_fk
    FOREIGN KEY (classified_by_participant_id, job_id, relationship_id)
    REFERENCES relationship_participants(id, job_id, request_relationship_id)
    ON DELETE RESTRICT,
  CONSTRAINT canonical_work_activity_execution_classification_command_fk
    FOREIGN KEY (
      command_idempotency_id, job_id, classified_by_participant_id
    )
    REFERENCES canonical_approved_work_execution_command_idempotency(
      id, job_id, actor_participant_id
    ) ON DELETE RESTRICT,
  CONSTRAINT canonical_work_activity_execution_classification_shape_check CHECK (
    (
      classification = 'NON_EXECUTION'
      AND execution_id IS NULL
      AND scope_basis IS NULL
      AND source_quote_id IS NULL
      AND source_quote_version IS NULL
      AND source_scope_item_id IS NULL
      AND source_scope_included_in_total IS NULL
    )
    OR (
      classification = 'EXECUTION'
      AND execution_id IS NOT NULL
      AND (
        (
          scope_basis = 'DECISION_WIDE'
          AND source_quote_id IS NULL
          AND source_quote_version IS NULL
          AND source_scope_item_id IS NULL
          AND source_scope_included_in_total IS NULL
        )
        OR (
          scope_basis = 'QUOTE_SCOPE_ITEM'
          AND source_quote_id IS NOT NULL
          AND source_quote_version IS NOT NULL
          AND source_scope_item_id IS NOT NULL
          AND source_scope_included_in_total = TRUE
        )
      )
    )
  ),
  CONSTRAINT canonical_work_activity_execution_classification_start_key
    UNIQUE (
      activity_id, workstream_id, job_id, execution_id, classification
    )
);

CREATE INDEX IF NOT EXISTS canonical_work_activity_execution_classification_execution_idx
ON canonical_work_activity_execution_classifications(
  execution_id, workstream_id, created_at ASC, activity_id ASC
)
WHERE classification = 'EXECUTION';

CREATE INDEX IF NOT EXISTS canonical_work_activity_non_execution_idx
ON canonical_work_activity_execution_classifications(
  job_id, workstream_id, created_at ASC, activity_id ASC
)
WHERE classification = 'NON_EXECUTION';

CREATE TABLE IF NOT EXISTS canonical_approved_work_execution_start_events (
  id UUID PRIMARY KEY,
  execution_id UUID NOT NULL,
  job_id UUID NOT NULL,
  relationship_id INTEGER NOT NULL,
  approved_customer_decision_id UUID NOT NULL,
  source_type TEXT NOT NULL
    CHECK (source_type IN ('EXECUTION_ACTIVITY', 'APPROVED_WORK_VISIT')),
  source_activity_id UUID,
  source_activity_version INTEGER CHECK (
    source_activity_version IS NULL OR source_activity_version >= 1
  ),
  source_workstream_id UUID,
  source_activity_classification TEXT,
  source_activity_status TEXT,
  source_visit_id UUID,
  source_visit_version INTEGER CHECK (
    source_visit_version IS NULL OR source_visit_version >= 1
  ),
  source_visit_purpose TEXT,
  source_visit_state TEXT,
  started_at TIMESTAMPTZ NOT NULL,
  recorded_by_participant_id UUID NOT NULL,
  command_idempotency_id UUID NOT NULL UNIQUE,
  integrity_algorithm TEXT NOT NULL DEFAULT 'sha256'
    CHECK (integrity_algorithm = 'sha256'),
  integrity_hash TEXT NOT NULL CHECK (integrity_hash ~ '^[0-9a-f]{64}$'),
  integrity_version SMALLINT NOT NULL DEFAULT 1 CHECK (integrity_version = 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT canonical_approved_work_execution_start_execution_fk
    FOREIGN KEY (
      execution_id, approved_customer_decision_id, job_id, relationship_id
    )
    REFERENCES canonical_approved_work_executions(
      id, approved_customer_decision_id, job_id, relationship_id
    ) ON DELETE RESTRICT,
  CONSTRAINT canonical_approved_work_execution_start_actor_fk
    FOREIGN KEY (recorded_by_participant_id, job_id, relationship_id)
    REFERENCES relationship_participants(id, job_id, request_relationship_id)
    ON DELETE RESTRICT,
  CONSTRAINT canonical_approved_work_execution_start_command_fk
    FOREIGN KEY (
      command_idempotency_id, job_id, recorded_by_participant_id
    )
    REFERENCES canonical_approved_work_execution_command_idempotency(
      id, job_id, actor_participant_id
    ) ON DELETE RESTRICT,
  CONSTRAINT canonical_approved_work_execution_start_activity_classification_fk
    FOREIGN KEY (
      source_activity_id, source_workstream_id, job_id, execution_id,
      source_activity_classification
    )
    REFERENCES canonical_work_activity_execution_classifications(
      activity_id, workstream_id, job_id, execution_id, classification
    ) ON DELETE RESTRICT,
  CONSTRAINT canonical_approved_work_execution_start_activity_version_fk
    FOREIGN KEY (
      source_activity_id, source_activity_version, source_workstream_id,
      job_id, source_activity_status
    )
    REFERENCES canonical_work_activity_versions(
      activity_id, version, workstream_id, job_id, status
    ) ON DELETE RESTRICT,
  CONSTRAINT canonical_approved_work_execution_start_visit_fk
    FOREIGN KEY (
      source_visit_id, job_id, source_visit_purpose,
      approved_customer_decision_id
    )
    REFERENCES canonical_visits(
      id, job_id, purpose, approved_quote_decision_id
    ) ON DELETE RESTRICT,
  CONSTRAINT canonical_approved_work_execution_start_visit_version_fk
    FOREIGN KEY (
      source_visit_id, source_visit_version, job_id, source_visit_state
    )
    REFERENCES canonical_visit_versions(visit_id, version, job_id, state)
    ON DELETE RESTRICT,
  CONSTRAINT canonical_approved_work_execution_start_source_shape_check CHECK (
    (
      source_type = 'EXECUTION_ACTIVITY'
      AND source_activity_id IS NOT NULL
      AND source_activity_version IS NOT NULL
      AND source_workstream_id IS NOT NULL
      AND source_activity_classification = 'EXECUTION'
      AND source_activity_status = 'IN_PROGRESS'
      AND source_visit_id IS NULL
      AND source_visit_version IS NULL
      AND source_visit_purpose IS NULL
      AND source_visit_state IS NULL
    )
    OR (
      source_type = 'APPROVED_WORK_VISIT'
      AND source_activity_id IS NULL
      AND source_activity_version IS NULL
      AND source_workstream_id IS NULL
      AND source_activity_classification IS NULL
      AND source_activity_status IS NULL
      AND source_visit_id IS NOT NULL
      AND source_visit_version IS NOT NULL
      AND source_visit_purpose = 'APPROVED_WORK'
      AND source_visit_state = 'STARTED'
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS canonical_approved_work_execution_start_activity_source_uidx
ON canonical_approved_work_execution_start_events(
  source_activity_id, source_activity_version
)
WHERE source_type = 'EXECUTION_ACTIVITY';

CREATE UNIQUE INDEX IF NOT EXISTS canonical_approved_work_execution_start_visit_source_uidx
ON canonical_approved_work_execution_start_events(
  source_visit_id, source_visit_version
)
WHERE source_type = 'APPROVED_WORK_VISIT';

CREATE INDEX IF NOT EXISTS canonical_approved_work_execution_start_first_idx
ON canonical_approved_work_execution_start_events(
  execution_id, started_at ASC, created_at ASC, id ASC
);

CREATE OR REPLACE FUNCTION enforce_work_preparation_policy_consistency()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  policy TEXT;
BEGIN
  SELECT versions.work_start_policy
  INTO policy
  FROM canonical_work_preparation_plan_versions versions
  WHERE versions.plan_id = NEW.plan_id
    AND versions.version = NEW.plan_version;

  IF policy = 'NONE' AND EXISTS (
    SELECT 1
    FROM canonical_work_preparation_item_snapshots snapshots
    WHERE snapshots.plan_id = NEW.plan_id
      AND snapshots.plan_version = NEW.plan_version
      AND snapshots.required_for_work_start = TRUE
  ) THEN
    RAISE EXCEPTION 'work preparation policy NONE cannot contain required Work-start items'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_work_preparation_version_policy_consistency()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  required_item_present BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM canonical_work_preparation_item_snapshots snapshots
    WHERE snapshots.plan_id = NEW.plan_id
      AND snapshots.plan_version = NEW.version
      AND snapshots.required_for_work_start = TRUE
  ) INTO required_item_present;

  IF NEW.work_start_policy = 'NONE' AND required_item_present THEN
    RAISE EXCEPTION 'work preparation policy NONE cannot contain required Work-start items'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER canonical_work_preparation_policy_version_consistency_guard
AFTER INSERT ON canonical_work_preparation_plan_versions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_work_preparation_version_policy_consistency();

CREATE CONSTRAINT TRIGGER canonical_work_preparation_policy_item_consistency_guard
AFTER INSERT ON canonical_work_preparation_item_snapshots
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_work_preparation_policy_consistency();

DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'canonical_approved_work_executions',
    'canonical_approved_work_execution_versions',
    'canonical_approved_work_execution_workstreams',
    'canonical_work_activity_execution_classifications',
    'canonical_approved_work_execution_start_events'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgname = table_name || '_append_only'
        AND NOT tgisinternal
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I '
        || 'FOR EACH ROW EXECUTE FUNCTION prevent_lifecycle_append_only_mutation()',
        table_name || '_append_only',
        table_name
      );
    END IF;
  END LOOP;
END;
$$;

-- This migration creates no execution, version, binding, classification,
-- start-event, lifecycle grant, Workstream, Activity, Visit, Quote, payment,
-- Work Preparation, Invoice, Job, or other business row. Historical operational
-- rows remain unclassified and unbound; no execution authority is inferred.
