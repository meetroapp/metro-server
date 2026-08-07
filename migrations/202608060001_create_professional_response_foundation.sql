-- MC-CONVERSATION-COMMERCIAL-JOB-REQUEST-001B-2B
-- Establish canonical ordinary Professional Response persistence.
--
-- This forward-only migration is additive. It creates no response, selection,
-- or runtime authority for existing records and performs no legacy backfill.

-- These redundant compound indexes let foreign keys prove that the request
-- owner and business owner were derived from the same canonical records.
CREATE UNIQUE INDEX IF NOT EXISTS posts_id_user_id_uidx
ON posts(id, user_id);

CREATE UNIQUE INDEX IF NOT EXISTS contractor_profiles_id_user_id_uidx
ON contractor_profiles(id, user_id);

CREATE UNIQUE INDEX IF NOT EXISTS
  request_relationships_professional_response_party_uidx
ON request_relationships(
  id,
  post_id,
  homeowner_id,
  contractor_id,
  professional_user_id
);

CREATE UNIQUE INDEX IF NOT EXISTS
  request_relationships_reconciliation_source_uidx
ON request_relationships(
  id,
  post_id,
  emergency_request_id
);

CREATE TABLE IF NOT EXISTS professional_responses (
  id BIGSERIAL PRIMARY KEY,

  post_id INTEGER NOT NULL
    REFERENCES posts(id)
    ON DELETE RESTRICT,

  request_relationship_id INTEGER NOT NULL,

  homeowner_id INTEGER NOT NULL
    REFERENCES users(id)
    ON DELETE RESTRICT,

  contractor_id INTEGER NOT NULL
    REFERENCES contractor_profiles(id)
    ON DELETE RESTRICT,

  professional_user_id INTEGER NOT NULL
    REFERENCES users(id)
    ON DELETE RESTRICT,

  status TEXT NOT NULL DEFAULT 'submitted'
    CHECK (
      status IN (
        'submitted',
        'withdrawn',
        'declined',
        'selected',
        'not_selected',
        'expired',
        'cancelled',
        'closed'
      )
    ),

  introduction_text TEXT NOT NULL
    CHECK (char_length(introduction_text) BETWEEN 1 AND 2000),

  origin TEXT NOT NULL DEFAULT 'canonical_command'
    CHECK (
      origin IN (
        'canonical_command',
        'legacy_reconciliation'
      )
    ),

  current_version INTEGER NOT NULL DEFAULT 1
    CHECK (current_version >= 1),

  submitted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  selected_at TIMESTAMPTZ,
  last_transition_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  terminal_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT professional_responses_request_business_key
    UNIQUE (post_id, contractor_id),

  CONSTRAINT professional_responses_relationship_key
    UNIQUE (request_relationship_id),

  CONSTRAINT professional_responses_reciprocal_key
    UNIQUE (id, request_relationship_id),

  CONSTRAINT professional_responses_identity_tuple_key
    UNIQUE (
      id,
      request_relationship_id,
      post_id,
      homeowner_id,
      contractor_id,
      professional_user_id
    ),

  CONSTRAINT professional_responses_command_result_tuple_key
    UNIQUE (
      id,
      request_relationship_id,
      post_id,
      contractor_id,
      professional_user_id
    ),

  CONSTRAINT professional_responses_evidence_tuple_key
    UNIQUE (
      id,
      request_relationship_id,
      post_id,
      contractor_id
    ),

  CONSTRAINT professional_responses_different_users_check
    CHECK (homeowner_id <> professional_user_id),

  CONSTRAINT professional_responses_status_timestamps_check
    CHECK (
      (
        status = 'submitted'
        AND selected_at IS NULL
        AND terminal_at IS NULL
      )
      OR
      (
        status = 'selected'
        AND selected_at IS NOT NULL
        AND terminal_at IS NULL
      )
      OR
      (
        status IN (
          'withdrawn',
          'declined',
          'not_selected',
          'expired',
          'cancelled',
          'closed'
        )
        AND terminal_at IS NOT NULL
      )
    ),

  CONSTRAINT professional_responses_timestamp_order_check
    CHECK (
      submitted_at >= created_at
      AND last_transition_at >= submitted_at
      AND (selected_at IS NULL OR selected_at >= submitted_at)
      AND (terminal_at IS NULL OR terminal_at >= submitted_at)
      AND updated_at >= created_at
    ),

  CONSTRAINT professional_responses_post_homeowner_fk
    FOREIGN KEY (post_id, homeowner_id)
    REFERENCES posts(id, user_id)
    ON DELETE RESTRICT,

  CONSTRAINT professional_responses_business_owner_fk
    FOREIGN KEY (contractor_id, professional_user_id)
    REFERENCES contractor_profiles(id, user_id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS professional_responses_professional_idx
ON professional_responses(
  professional_user_id,
  submitted_at DESC,
  id ASC
);

CREATE INDEX IF NOT EXISTS professional_responses_homeowner_idx
ON professional_responses(
  homeowner_id,
  submitted_at DESC,
  id ASC
);

CREATE INDEX IF NOT EXISTS professional_responses_request_status_idx
ON professional_responses(
  post_id,
  status,
  submitted_at ASC,
  id ASC
);

CREATE TABLE IF NOT EXISTS professional_response_versions (
  professional_response_id BIGINT NOT NULL
    REFERENCES professional_responses(id)
    ON DELETE RESTRICT,

  version INTEGER NOT NULL
    CHECK (version >= 1),

  previous_version INTEGER,

  status TEXT NOT NULL
    CHECK (
      status IN (
        'submitted',
        'withdrawn',
        'declined',
        'selected',
        'not_selected',
        'expired',
        'cancelled',
        'closed'
      )
    ),

  introduction_text TEXT NOT NULL
    CHECK (char_length(introduction_text) BETWEEN 1 AND 2000),

  content_fingerprint TEXT NOT NULL
    CHECK (content_fingerprint ~ '^[0-9a-f]{64}$'),

  transition_reason TEXT NOT NULL
    CHECK (
      transition_reason IN (
        'submitted',
        'withdrawn',
        'declined',
        'selected',
        'not_selected',
        'expired',
        'cancelled',
        'closed',
        'legacy_reconciled'
      )
    ),

  actor_type TEXT NOT NULL
    CHECK (
      actor_type IN (
        'professional',
        'homeowner',
        'system',
        'reconciliation'
      )
    ),

  actor_user_id INTEGER
    REFERENCES users(id)
    ON DELETE RESTRICT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT professional_response_versions_key
    PRIMARY KEY (professional_response_id, version),

  CONSTRAINT professional_response_versions_sequence_check
    CHECK (
      (
        version = 1
        AND previous_version IS NULL
      )
      OR
      (
        version > 1
        AND previous_version = version - 1
      )
    ),

  CONSTRAINT professional_response_versions_actor_check
    CHECK (
      (
        actor_type IN ('professional', 'homeowner')
        AND actor_user_id IS NOT NULL
      )
      OR
      (
        actor_type IN ('system', 'reconciliation')
        AND actor_user_id IS NULL
      )
    )
);

CREATE INDEX IF NOT EXISTS professional_response_versions_history_idx
ON professional_response_versions(
  professional_response_id,
  version ASC,
  created_at ASC
);

ALTER TABLE professional_responses
  ADD CONSTRAINT professional_responses_current_version_fk
  FOREIGN KEY (id, current_version)
  REFERENCES professional_response_versions(
    professional_response_id,
    version
  )
  ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE IF NOT EXISTS professional_response_command_idempotency (
  id UUID PRIMARY KEY,

  actor_user_id INTEGER NOT NULL
    REFERENCES users(id)
    ON DELETE RESTRICT,

  contractor_id INTEGER NOT NULL
    REFERENCES contractor_profiles(id)
    ON DELETE RESTRICT,

  post_id INTEGER NOT NULL
    REFERENCES posts(id)
    ON DELETE RESTRICT,

  command_name TEXT NOT NULL DEFAULT 'professional_response.submit'
    CHECK (command_name = 'professional_response.submit'),

  command_scope TEXT NOT NULL
    CHECK (char_length(command_scope) BETWEEN 1 AND 300),

  idempotency_key TEXT NOT NULL
    CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),

  request_fingerprint TEXT NOT NULL
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),

  professional_response_id BIGINT,
  request_relationship_id INTEGER,

  result_classification TEXT
    CHECK (
      result_classification IS NULL
      OR result_classification IN ('created', 'existing')
    ),

  result_reference JSONB
    CHECK (
      result_reference IS NULL
      OR jsonb_typeof(result_reference) = 'object'
    ),

  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT professional_response_command_scope_key
    UNIQUE (
      actor_user_id,
      command_name,
      command_scope,
      idempotency_key
    ),

  CONSTRAINT professional_response_command_scope_value_check
    CHECK (
      command_scope =
        'post:' || post_id::TEXT || ':business:' || contractor_id::TEXT
    ),

  CONSTRAINT professional_response_command_business_owner_fk
    FOREIGN KEY (contractor_id, actor_user_id)
    REFERENCES contractor_profiles(id, user_id)
    ON DELETE RESTRICT,

  CONSTRAINT professional_response_command_completion_check
    CHECK (
      (
        professional_response_id IS NULL
        AND request_relationship_id IS NULL
        AND result_classification IS NULL
        AND result_reference IS NULL
        AND completed_at IS NULL
      )
      OR
      (
        professional_response_id IS NOT NULL
        AND request_relationship_id IS NOT NULL
        AND result_classification IS NOT NULL
        AND result_reference IS NOT NULL
        AND completed_at IS NOT NULL
      )
    ),

  CONSTRAINT professional_response_command_result_fk
    FOREIGN KEY (
      professional_response_id,
      request_relationship_id,
      post_id,
      contractor_id,
      actor_user_id
    )
    REFERENCES professional_responses(
      id,
      request_relationship_id,
      post_id,
      contractor_id,
      professional_user_id
    )
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS professional_response_command_result_idx
ON professional_response_command_idempotency(
  professional_response_id,
  created_at ASC
)
WHERE professional_response_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS professional_response_evidence (
  id BIGSERIAL PRIMARY KEY,

  professional_response_id BIGINT NOT NULL,
  request_relationship_id INTEGER NOT NULL,
  post_id INTEGER NOT NULL,
  contractor_id INTEGER NOT NULL,

  actor_type TEXT NOT NULL
    CHECK (
      actor_type IN (
        'professional',
        'homeowner',
        'system',
        'reconciliation'
      )
    ),

  actor_user_id INTEGER
    REFERENCES users(id)
    ON DELETE RESTRICT,

  event_type TEXT NOT NULL
    CHECK (
      event_type IN (
        'professional_response_submitted',
        'professional_response_withdrawn',
        'professional_response_declined',
        'professional_response_selected',
        'professional_response_not_selected',
        'professional_response_expired',
        'professional_response_cancelled',
        'professional_response_closed',
        'legacy_professional_response_reconciled'
      )
    ),

  previous_status TEXT
    CHECK (
      previous_status IS NULL
      OR previous_status IN (
        'submitted',
        'withdrawn',
        'declined',
        'selected',
        'not_selected',
        'expired',
        'cancelled',
        'closed'
      )
    ),

  new_status TEXT NOT NULL
    CHECK (
      new_status IN (
        'submitted',
        'withdrawn',
        'declined',
        'selected',
        'not_selected',
        'expired',
        'cancelled',
        'closed'
      )
    ),

  previous_version INTEGER NOT NULL
    CHECK (previous_version >= 0),

  resulting_version INTEGER NOT NULL
    CHECK (resulting_version >= 1),

  idempotency_id UUID
    REFERENCES professional_response_command_idempotency(id)
    ON DELETE RESTRICT,

  correlation_id UUID,
  causation_id UUID,

  safe_payload JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(safe_payload) = 'object'),

  occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  persisted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  governing_contract_id TEXT NOT NULL
    DEFAULT 'MC-CONVERSATION-COMMERCIAL-JOB-REQUEST-001B'
    CHECK (
      governing_contract_id =
        'MC-CONVERSATION-COMMERCIAL-JOB-REQUEST-001B'
    ),

  implementation_milestone_id TEXT NOT NULL
    CHECK (
      char_length(implementation_milestone_id) <= 160
      AND implementation_milestone_id ~
        '^MC-CONVERSATION-COMMERCIAL-JOB-REQUEST-001B-[1-9][0-9]*[A-Z]?(-[A-Z0-9]+)*$'
    ),

  CONSTRAINT professional_response_evidence_version_check
    CHECK (resulting_version = previous_version + 1),

  CONSTRAINT professional_response_evidence_actor_check
    CHECK (
      (
        actor_type IN ('professional', 'homeowner')
        AND actor_user_id IS NOT NULL
      )
      OR
      (
        actor_type IN ('system', 'reconciliation')
        AND actor_user_id IS NULL
      )
    ),

  CONSTRAINT professional_response_evidence_order_key
    UNIQUE (professional_response_id, resulting_version),

  CONSTRAINT professional_response_evidence_identity_fk
    FOREIGN KEY (
      professional_response_id,
      request_relationship_id,
      post_id,
      contractor_id
    )
    REFERENCES professional_responses(
      id,
      request_relationship_id,
      post_id,
      contractor_id
    )
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,

  CONSTRAINT professional_response_evidence_version_fk
    FOREIGN KEY (
      professional_response_id,
      resulting_version
    )
    REFERENCES professional_response_versions(
      professional_response_id,
      version
    )
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS professional_response_evidence_order_idx
ON professional_response_evidence(
  professional_response_id,
  resulting_version ASC,
  persisted_at ASC,
  id ASC
);

CREATE TABLE IF NOT EXISTS professional_response_reconciliations (
  id BIGSERIAL PRIMARY KEY,

  request_relationship_id INTEGER NOT NULL
    REFERENCES request_relationships(id)
    ON DELETE RESTRICT,

  post_id INTEGER,
  emergency_request_id INTEGER,

  decision_version INTEGER NOT NULL DEFAULT 1
    CHECK (decision_version >= 1),

  source_kind TEXT NOT NULL
    CHECK (source_kind IN ('ordinary', 'emergency')),

  relationship_classification TEXT NOT NULL
    CHECK (
      relationship_classification IN (
        'ordinary_pending_candidate',
        'ordinary_pending_ambiguous',
        'ordinary_active_discovery_legacy',
        'ordinary_active_conversation_linked',
        'ordinary_terminal_candidate',
        'ordinary_terminal_ambiguous',
        'participant_or_owner_mismatch',
        'duplicate_or_collision',
        'emergency_excluded'
      )
    ),

  reconciliation_status TEXT NOT NULL
    CHECK (
      reconciliation_status IN (
        'unresolved',
        'quarantined',
        'eligible',
        'reconciled',
        'excluded',
        'rejected'
      )
    ),

  evidence_classification TEXT NOT NULL
    CHECK (
      evidence_classification IN (
        'explicit_response_proven',
        'insufficient',
        'active_only',
        'conversation_only',
        'participant_mismatch',
        'duplicate_conflict',
        'emergency_source'
      )
    ),

  professional_response_id BIGINT,

  decision_actor_user_id INTEGER
    REFERENCES users(id)
    ON DELETE RESTRICT,

  decision_process TEXT NOT NULL
    CHECK (char_length(decision_process) BETWEEN 1 AND 160),

  decision_reason TEXT NOT NULL
    CHECK (char_length(decision_reason) BETWEEN 1 AND 1000),

  idempotency_key TEXT NOT NULL
    CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),

  evidence_fingerprint TEXT NOT NULL
    CHECK (evidence_fingerprint ~ '^[0-9a-f]{64}$'),

  safe_metadata JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(safe_metadata) = 'object'),

  decided_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT professional_response_reconciliation_version_key
    UNIQUE (request_relationship_id, decision_version),

  CONSTRAINT professional_response_reconciliation_idempotency_key
    UNIQUE (request_relationship_id, idempotency_key),

  CONSTRAINT professional_response_reconciliation_evidence_key
    UNIQUE (request_relationship_id, evidence_fingerprint),

  CONSTRAINT professional_response_reconciliation_result_check
    CHECK (
      (
        reconciliation_status = 'reconciled'
        AND source_kind = 'ordinary'
        AND professional_response_id IS NOT NULL
      )
      OR
      (
        reconciliation_status <> 'reconciled'
        AND professional_response_id IS NULL
      )
    ),

  CONSTRAINT professional_response_reconciliation_emergency_check
    CHECK (
      (
        source_kind = 'ordinary'
        AND post_id IS NOT NULL
        AND emergency_request_id IS NULL
        AND relationship_classification <> 'emergency_excluded'
        AND reconciliation_status <> 'excluded'
        AND evidence_classification <> 'emergency_source'
      )
      OR
      (
        source_kind = 'emergency'
        AND post_id IS NULL
        AND emergency_request_id IS NOT NULL
        AND relationship_classification = 'emergency_excluded'
        AND reconciliation_status = 'excluded'
        AND evidence_classification = 'emergency_source'
        AND professional_response_id IS NULL
      )
    ),

  CONSTRAINT professional_response_reconciliation_source_fk
    FOREIGN KEY (
      request_relationship_id,
      post_id,
      emergency_request_id
    )
    REFERENCES request_relationships(
      id,
      post_id,
      emergency_request_id
    )
    ON DELETE RESTRICT,

  CONSTRAINT professional_response_reconciliation_response_fk
    FOREIGN KEY (
      professional_response_id,
      request_relationship_id
    )
    REFERENCES professional_responses(
      id,
      request_relationship_id
    )
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS professional_response_reconciliation_status_idx
ON professional_response_reconciliations(
  reconciliation_status,
  decided_at ASC,
  id ASC
);

CREATE UNIQUE INDEX IF NOT EXISTS
  professional_response_reconciliation_resolved_uidx
ON professional_response_reconciliations(request_relationship_id)
WHERE reconciliation_status = 'reconciled';

ALTER TABLE request_relationships
  ADD COLUMN IF NOT EXISTS professional_response_id BIGINT,
  ADD COLUMN IF NOT EXISTS ordinary_authority_source TEXT,
  ADD COLUMN IF NOT EXISTS current_version INTEGER,
  ADD COLUMN IF NOT EXISTS closure_reason TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS
  request_relationships_professional_response_uidx
ON request_relationships(professional_response_id)
WHERE professional_response_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS
  request_relationships_professional_response_reciprocal_uidx
ON request_relationships(id, professional_response_id);

ALTER TABLE request_relationships
  ADD CONSTRAINT request_relationships_ordinary_authority_source_check
  CHECK (
    ordinary_authority_source IS NULL
    OR ordinary_authority_source = 'professional_response'
  ),

  ADD CONSTRAINT request_relationships_closure_reason_value_check
  CHECK (
    closure_reason IS NULL
    OR closure_reason IN (
      'professional_withdrew',
      'homeowner_declined',
      'other_professional_selected',
      'request_expired',
      'request_cancelled',
      'request_closed',
      'request_superseded'
    )
  ),

  ADD CONSTRAINT request_relationships_professional_response_shape_check
  CHECK (
    (
      emergency_request_id IS NOT NULL
      AND post_id IS NULL
      AND professional_response_id IS NULL
      AND ordinary_authority_source IS NULL
      AND current_version IS NULL
      AND closure_reason IS NULL
    )
    OR
    (
      post_id IS NOT NULL
      AND emergency_request_id IS NULL
      AND (
        (
          professional_response_id IS NULL
          AND ordinary_authority_source IS NULL
          AND current_version IS NULL
          AND closure_reason IS NULL
        )
        OR
        (
          professional_response_id IS NOT NULL
          AND ordinary_authority_source = 'professional_response'
          AND current_version >= 1
          AND status IN ('pending', 'active', 'closed')
          AND (
            (
              status IN ('pending', 'active')
              AND closure_reason IS NULL
            )
            OR
            (
              status = 'closed'
              AND closure_reason IS NOT NULL
            )
          )
        )
      )
    )
  ),

  ADD CONSTRAINT request_relationships_professional_response_reciprocal_fk
  FOREIGN KEY (professional_response_id, id)
  REFERENCES professional_responses(id, request_relationship_id)
  ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE professional_responses
  ADD CONSTRAINT professional_responses_relationship_identity_fk
  FOREIGN KEY (
    request_relationship_id,
    post_id,
    homeowner_id,
    contractor_id,
    professional_user_id
  )
  REFERENCES request_relationships(
    id,
    post_id,
    homeowner_id,
    contractor_id,
    professional_user_id
  )
  ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED,

  ADD CONSTRAINT professional_responses_relationship_reciprocal_fk
  FOREIGN KEY (request_relationship_id, id)
  REFERENCES request_relationships(id, professional_response_id)
  ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED;

-- Versions, evidence, and reconciliation decisions are append-only. Corrections
-- append a later governed record instead of rewriting preserved evidence.
CREATE FUNCTION prevent_professional_response_append_only_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'Professional Response append-only records cannot be mutated.'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER professional_response_versions_append_only
BEFORE UPDATE OR DELETE ON professional_response_versions
FOR EACH ROW
EXECUTE FUNCTION prevent_professional_response_append_only_mutation();

CREATE TRIGGER professional_response_evidence_append_only
BEFORE UPDATE OR DELETE ON professional_response_evidence
FOR EACH ROW
EXECUTE FUNCTION prevent_professional_response_append_only_mutation();

CREATE TRIGGER professional_response_reconciliations_append_only
BEFORE UPDATE OR DELETE ON professional_response_reconciliations
FOR EACH ROW
EXECUTE FUNCTION prevent_professional_response_append_only_mutation();

-- Cross-table CHECK constraints cannot inspect the linked row. This deferred
-- constraint trigger verifies the final response/relationship state pair and
-- exact participant tuple at transaction commit, after both reciprocal rows
-- have been assembled.
CREATE FUNCTION validate_professional_response_relationship_pair()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  response_record professional_responses%ROWTYPE;
  relationship_record request_relationships%ROWTYPE;
  response_id BIGINT;
BEGIN
  IF TG_TABLE_NAME = 'professional_responses' THEN
    response_id := NEW.id;
  ELSE
    IF NEW.ordinary_authority_source IS NULL
       AND NEW.professional_response_id IS NULL THEN
      RETURN NEW;
    END IF;

    response_id := NEW.professional_response_id;
  END IF;

  SELECT *
  INTO response_record
  FROM professional_responses
  WHERE id = response_id;

  IF response_record.id IS NULL THEN
    RAISE EXCEPTION
      'Canonical Professional Response linkage is incomplete.'
      USING ERRCODE = '23514';
  END IF;

  SELECT *
  INTO relationship_record
  FROM request_relationships
  WHERE id = response_record.request_relationship_id;

  IF relationship_record.id IS NULL THEN
    RAISE EXCEPTION
      'Canonical Professional Response relationship is missing.'
      USING ERRCODE = '23514';
  END IF;

  IF relationship_record.emergency_request_id IS NOT NULL
     OR relationship_record.post_id IS NULL
     OR relationship_record.ordinary_authority_source <>
       'professional_response'
     OR relationship_record.professional_response_id <>
       response_record.id
     OR relationship_record.post_id <>
       response_record.post_id
     OR relationship_record.homeowner_id <>
       response_record.homeowner_id
     OR relationship_record.contractor_id <>
       response_record.contractor_id
     OR relationship_record.professional_user_id <>
       response_record.professional_user_id
     OR relationship_record.current_version <>
       response_record.current_version THEN
    RAISE EXCEPTION
      'Canonical Professional Response identity does not match its relationship.'
      USING ERRCODE = '23514';
  END IF;

  IF (
       response_record.status = 'submitted'
       AND relationship_record.status <> 'pending'
     )
     OR (
       response_record.status = 'selected'
       AND relationship_record.status <> 'active'
     )
     OR (
       response_record.status IN (
         'withdrawn',
         'declined',
         'not_selected',
         'expired',
         'cancelled',
         'closed'
       )
       AND relationship_record.status <> 'closed'
     ) THEN
    RAISE EXCEPTION
      'Canonical Professional Response lifecycle does not match its relationship.'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER professional_responses_relationship_pair_check
AFTER INSERT OR UPDATE ON professional_responses
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION validate_professional_response_relationship_pair();

CREATE CONSTRAINT TRIGGER request_relationships_professional_response_pair_check
AFTER INSERT OR UPDATE ON request_relationships
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION validate_professional_response_relationship_pair();

COMMENT ON TABLE professional_responses IS
  'Canonical ordinary Professional Response authority; one per Job Request and business profile.';

COMMENT ON TABLE professional_response_versions IS
  'Immutable Professional Response state and content snapshots.';

COMMENT ON TABLE professional_response_command_idempotency IS
  'Durable submit-command retry and canonical result identity.';

COMMENT ON TABLE professional_response_evidence IS
  'Append-only evidence for accepted Professional Response transitions.';

COMMENT ON TABLE professional_response_reconciliations IS
  'Append-only control decisions for legacy relationship reconciliation; no automatic authority.';

-- Forward-only rollback contract:
-- Before any canonical write, a separately reviewed corrective migration may
-- remove only these new objects after proving all new tables are empty. After
-- any canonical write, preserve records and use a roll-forward correction.
--
-- Read-only post-migration validation queries for 001B-2D:
-- SELECT COUNT(*) FROM professional_responses;
-- SELECT COUNT(*) FROM professional_response_versions;
-- SELECT COUNT(*) FROM professional_response_command_idempotency;
-- SELECT COUNT(*) FROM professional_response_evidence;
-- SELECT COUNT(*) FROM professional_response_reconciliations;
-- SELECT COUNT(*) FROM request_relationships
--   WHERE professional_response_id IS NOT NULL;
-- SELECT COUNT(*) FROM request_relationships
--   WHERE emergency_request_id IS NOT NULL
--     AND professional_response_id IS NOT NULL;
