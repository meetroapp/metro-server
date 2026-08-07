-- MC-CONVERSATION-COMMERCIAL-JOB-REQUEST-001B-3
-- Establish exact homeowner selection and ordinary conversation provenance.
--
-- This forward-only migration is additive. It creates no selection,
-- conversation, participant, or legacy reconciliation record by itself.

CREATE UNIQUE INDEX IF NOT EXISTS
  request_relationships_one_active_ordinary_uidx
ON request_relationships(post_id)
WHERE post_id IS NOT NULL
  AND emergency_request_id IS NULL
  AND status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS
  professional_responses_id_post_uidx
ON professional_responses(id, post_id);

CREATE TABLE IF NOT EXISTS request_selections (
  id BIGSERIAL PRIMARY KEY,

  post_id INTEGER NOT NULL,
  professional_response_id BIGINT NOT NULL,
  request_relationship_id INTEGER NOT NULL,
  selected_by_user_id INTEGER NOT NULL,
  contractor_id INTEGER NOT NULL,
  professional_user_id INTEGER NOT NULL,
  selected_response_version INTEGER NOT NULL
    CHECK (selected_response_version >= 2),
  conversation_id INTEGER NOT NULL,

  selected_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at TIMESTAMPTZ,
  end_reason TEXT
    CHECK (
      end_reason IS NULL
      OR end_reason IN (
        'request_cancelled',
        'request_expired',
        'request_closed',
        'request_superseded'
      )
    ),

  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT request_selections_response_key
    UNIQUE (professional_response_id),

  CONSTRAINT request_selections_relationship_key
    UNIQUE (request_relationship_id),

  CONSTRAINT request_selections_conversation_key
    UNIQUE (conversation_id),

  CONSTRAINT request_selections_identity_tuple_key
    UNIQUE (
      id,
      professional_response_id,
      request_relationship_id,
      post_id,
      selected_by_user_id,
      contractor_id,
      professional_user_id,
      selected_response_version,
      conversation_id
    ),

  CONSTRAINT request_selections_command_result_tuple_key
    UNIQUE (
      id,
      professional_response_id,
      request_relationship_id,
      post_id,
      selected_by_user_id,
      conversation_id
    ),

  CONSTRAINT request_selections_lifecycle_check
    CHECK (
      (
        ended_at IS NULL
        AND end_reason IS NULL
      )
      OR
      (
        ended_at IS NOT NULL
        AND end_reason IS NOT NULL
        AND ended_at >= selected_at
      )
    ),

  CONSTRAINT request_selections_post_homeowner_fk
    FOREIGN KEY (post_id, selected_by_user_id)
    REFERENCES posts(id, user_id)
    ON DELETE RESTRICT,

  CONSTRAINT request_selections_business_owner_fk
    FOREIGN KEY (contractor_id, professional_user_id)
    REFERENCES contractor_profiles(id, user_id)
    ON DELETE RESTRICT,

  CONSTRAINT request_selections_response_identity_fk
    FOREIGN KEY (
      professional_response_id,
      request_relationship_id,
      post_id,
      selected_by_user_id,
      contractor_id,
      professional_user_id
    )
    REFERENCES professional_responses(
      id,
      request_relationship_id,
      post_id,
      homeowner_id,
      contractor_id,
      professional_user_id
    )
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,

  CONSTRAINT request_selections_response_version_fk
    FOREIGN KEY (
      professional_response_id,
      selected_response_version
    )
    REFERENCES professional_response_versions(
      professional_response_id,
      version
    )
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,

  CONSTRAINT request_selections_relationship_identity_fk
    FOREIGN KEY (
      request_relationship_id,
      post_id,
      selected_by_user_id,
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
    DEFERRABLE INITIALLY DEFERRED
);

CREATE UNIQUE INDEX IF NOT EXISTS
  request_selections_one_active_per_post_uidx
ON request_selections(post_id)
WHERE ended_at IS NULL;

CREATE INDEX IF NOT EXISTS request_selections_homeowner_idx
ON request_selections(
  selected_by_user_id,
  selected_at DESC,
  id ASC
);

CREATE INDEX IF NOT EXISTS request_selections_professional_idx
ON request_selections(
  professional_user_id,
  selected_at DESC,
  id ASC
);

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS request_selection_id BIGINT;

CREATE UNIQUE INDEX IF NOT EXISTS
  conversations_request_selection_uidx
ON conversations(request_selection_id)
WHERE request_selection_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS
  conversations_request_selection_identity_uidx
ON conversations(
  id,
  relationship_id,
  homeowner_id,
  contractor_id,
  professional_user_id,
  request_selection_id
);

ALTER TABLE conversations
  ADD CONSTRAINT conversations_request_selection_fk
  FOREIGN KEY (request_selection_id)
  REFERENCES request_selections(id)
  ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE request_selections
  ADD CONSTRAINT request_selections_conversation_identity_fk
  FOREIGN KEY (
    conversation_id,
    request_relationship_id,
    selected_by_user_id,
    contractor_id,
    professional_user_id,
    id
  )
  REFERENCES conversations(
    id,
    relationship_id,
    homeowner_id,
    contractor_id,
    professional_user_id,
    request_selection_id
  )
  ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE IF NOT EXISTS request_selection_command_idempotency (
  id UUID PRIMARY KEY,

  actor_user_id INTEGER NOT NULL
    REFERENCES users(id)
    ON DELETE RESTRICT,

  post_id INTEGER NOT NULL,
  requested_professional_response_id BIGINT NOT NULL,

  command_name TEXT NOT NULL DEFAULT 'request_selection.select'
    CHECK (command_name = 'request_selection.select'),

  command_scope TEXT NOT NULL
    CHECK (char_length(command_scope) BETWEEN 1 AND 200),

  idempotency_key TEXT NOT NULL
    CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),

  request_fingerprint TEXT NOT NULL
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),

  request_selection_id BIGINT,
  request_relationship_id INTEGER,
  conversation_id INTEGER,

  result_classification TEXT
    CHECK (
      result_classification IS NULL
      OR result_classification IN ('created', 'replayed')
    ),

  result_reference JSONB
    CHECK (
      result_reference IS NULL
      OR jsonb_typeof(result_reference) = 'object'
    ),

  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT request_selection_command_scope_key
    UNIQUE (
      actor_user_id,
      command_name,
      command_scope,
      idempotency_key
    ),

  CONSTRAINT request_selection_command_scope_value_check
    CHECK (command_scope = 'post:' || post_id::TEXT),

  CONSTRAINT request_selection_command_post_owner_fk
    FOREIGN KEY (post_id, actor_user_id)
    REFERENCES posts(id, user_id)
    ON DELETE RESTRICT,

  CONSTRAINT request_selection_command_response_fk
    FOREIGN KEY (
      requested_professional_response_id,
      post_id
    )
    REFERENCES professional_responses(id, post_id)
    ON DELETE RESTRICT,

  CONSTRAINT request_selection_command_completion_check
    CHECK (
      (
        request_selection_id IS NULL
        AND request_relationship_id IS NULL
        AND conversation_id IS NULL
        AND result_classification IS NULL
        AND result_reference IS NULL
        AND completed_at IS NULL
      )
      OR
      (
        request_selection_id IS NOT NULL
        AND request_relationship_id IS NOT NULL
        AND conversation_id IS NOT NULL
        AND result_classification IS NOT NULL
        AND result_reference IS NOT NULL
        AND completed_at IS NOT NULL
      )
    ),

  CONSTRAINT request_selection_command_result_fk
    FOREIGN KEY (
      request_selection_id,
      requested_professional_response_id,
      request_relationship_id,
      post_id,
      actor_user_id,
      conversation_id
    )
    REFERENCES request_selections(
      id,
      professional_response_id,
      request_relationship_id,
      post_id,
      selected_by_user_id,
      conversation_id
    )
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS request_selection_command_result_idx
ON request_selection_command_idempotency(
  request_selection_id,
  created_at ASC
)
WHERE request_selection_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS request_selection_evidence (
  id BIGSERIAL PRIMARY KEY,

  request_selection_id BIGINT NOT NULL,
  post_id INTEGER NOT NULL,
  professional_response_id BIGINT NOT NULL,
  selected_response_version INTEGER NOT NULL,
  request_relationship_id INTEGER NOT NULL,
  actor_user_id INTEGER NOT NULL,
  contractor_id INTEGER NOT NULL,
  professional_user_id INTEGER NOT NULL,
  conversation_id INTEGER NOT NULL,

  event_type TEXT NOT NULL DEFAULT 'request_selection_created'
    CHECK (event_type = 'request_selection_created'),

  previous_response_status TEXT NOT NULL
    CHECK (previous_response_status = 'submitted'),

  new_response_status TEXT NOT NULL
    CHECK (new_response_status = 'selected'),

  previous_relationship_status TEXT NOT NULL
    CHECK (previous_relationship_status = 'pending'),

  new_relationship_status TEXT NOT NULL
    CHECK (new_relationship_status = 'active'),

  idempotency_id UUID NOT NULL
    REFERENCES request_selection_command_idempotency(id)
    ON DELETE RESTRICT,

  correlation_id UUID NOT NULL,
  safe_payload JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(safe_payload) = 'object'),

  occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  persisted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  governing_contract_id TEXT NOT NULL DEFAULT
    'MC-CONVERSATION-COMMERCIAL-JOB-REQUEST-001B'
    CHECK (
      governing_contract_id =
        'MC-CONVERSATION-COMMERCIAL-JOB-REQUEST-001B'
    ),

  implementation_milestone_id TEXT NOT NULL
    CHECK (
      implementation_milestone_id =
        'MC-CONVERSATION-COMMERCIAL-JOB-REQUEST-001B-3'
    ),

  CONSTRAINT request_selection_evidence_selection_key
    UNIQUE (request_selection_id),

  CONSTRAINT request_selection_evidence_idempotency_key
    UNIQUE (idempotency_id),

  CONSTRAINT request_selection_evidence_identity_fk
    FOREIGN KEY (
      request_selection_id,
      professional_response_id,
      request_relationship_id,
      post_id,
      actor_user_id,
      contractor_id,
      professional_user_id,
      selected_response_version,
      conversation_id
    )
    REFERENCES request_selections(
      id,
      professional_response_id,
      request_relationship_id,
      post_id,
      selected_by_user_id,
      contractor_id,
      professional_user_id,
      selected_response_version,
      conversation_id
    )
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED
);

CREATE FUNCTION prevent_request_selection_evidence_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'Request Selection evidence cannot be mutated.'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER request_selection_evidence_append_only
BEFORE UPDATE OR DELETE ON request_selection_evidence
FOR EACH ROW
EXECUTE FUNCTION prevent_request_selection_evidence_mutation();

CREATE FUNCTION validate_request_selection_authority()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  selection_record request_selections%ROWTYPE;
  response_record professional_responses%ROWTYPE;
  relationship_record request_relationships%ROWTYPE;
  conversation_record conversations%ROWTYPE;
  selection_id BIGINT;
BEGIN
  IF TG_TABLE_NAME = 'request_selections' THEN
    selection_id := NEW.id;
  ELSIF TG_TABLE_NAME = 'conversations' THEN
    SELECT * INTO relationship_record
    FROM request_relationships
    WHERE id = NEW.relationship_id;

    IF relationship_record.id IS NULL THEN
      RAISE EXCEPTION
        'Conversation relationship authority is missing.'
        USING ERRCODE = '23514';
    END IF;

    IF relationship_record.emergency_request_id IS NOT NULL THEN
      IF NEW.request_selection_id IS NOT NULL THEN
        RAISE EXCEPTION
          'Emergency conversations cannot use ordinary selection authority.'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END IF;

    IF NEW.request_selection_id IS NULL THEN
      RAISE EXCEPTION
        'New ordinary conversations require canonical selection authority.'
        USING ERRCODE = '23514';
    END IF;

    selection_id := NEW.request_selection_id;
  ELSIF TG_TABLE_NAME = 'professional_responses' THEN
    SELECT id INTO selection_id
    FROM request_selections
    WHERE professional_response_id = NEW.id
      AND ended_at IS NULL;

    IF selection_id IS NULL THEN
      RETURN NEW;
    END IF;
  ELSE
    SELECT id INTO selection_id
    FROM request_selections
    WHERE request_relationship_id = NEW.id
      AND ended_at IS NULL;

    IF selection_id IS NULL THEN
      RETURN NEW;
    END IF;
  END IF;

  SELECT * INTO selection_record
  FROM request_selections
  WHERE id = selection_id;

  IF selection_record.id IS NULL OR selection_record.ended_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO response_record
  FROM professional_responses
  WHERE id = selection_record.professional_response_id;

  SELECT * INTO relationship_record
  FROM request_relationships
  WHERE id = selection_record.request_relationship_id;

  SELECT * INTO conversation_record
  FROM conversations
  WHERE id = selection_record.conversation_id;

  IF response_record.id IS NULL
     OR relationship_record.id IS NULL
     OR conversation_record.id IS NULL
     OR response_record.status <> 'selected'
     OR response_record.current_version <>
       selection_record.selected_response_version
     OR relationship_record.status <> 'active'
     OR relationship_record.current_version <>
       selection_record.selected_response_version
     OR relationship_record.emergency_request_id IS NOT NULL
     OR relationship_record.post_id <> selection_record.post_id
     OR relationship_record.professional_response_id <>
       selection_record.professional_response_id
     OR relationship_record.homeowner_id <>
       selection_record.selected_by_user_id
     OR relationship_record.contractor_id <>
       selection_record.contractor_id
     OR relationship_record.professional_user_id <>
       selection_record.professional_user_id
     OR conversation_record.relationship_id <>
       selection_record.request_relationship_id
     OR conversation_record.request_selection_id <> selection_record.id
     OR conversation_record.homeowner_id <>
       selection_record.selected_by_user_id
     OR conversation_record.contractor_id <>
       selection_record.contractor_id
     OR conversation_record.professional_user_id <>
       selection_record.professional_user_id
     OR conversation_record.status <> 'active' THEN
    RAISE EXCEPTION
      'Canonical Request Selection authority is incomplete or inconsistent.'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER request_selections_authority_check
AFTER INSERT OR UPDATE ON request_selections
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION validate_request_selection_authority();

CREATE CONSTRAINT TRIGGER conversations_request_selection_authority_check
AFTER INSERT OR UPDATE OF
  relationship_id,
  homeowner_id,
  contractor_id,
  professional_user_id,
  request_selection_id
ON conversations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION validate_request_selection_authority();

CREATE CONSTRAINT TRIGGER professional_responses_selection_authority_check
AFTER UPDATE ON professional_responses
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION validate_request_selection_authority();

CREATE CONSTRAINT TRIGGER request_relationships_selection_authority_check
AFTER UPDATE ON request_relationships
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION validate_request_selection_authority();

COMMENT ON TABLE request_selections IS
  'Append-preserving exact homeowner selection authority for ordinary Job Requests.';

COMMENT ON TABLE request_selection_command_idempotency IS
  'Durable exact homeowner selection command retry and result identity.';

COMMENT ON TABLE request_selection_evidence IS
  'Immutable evidence for accepted homeowner selection transactions.';

COMMENT ON COLUMN conversations.request_selection_id IS
  'Ordinary selection provenance; null for preserved legacy and Emergency conversations.';

-- Forward-only rollback contract:
-- Before any selection write, a separately reviewed corrective migration may
-- remove only these new objects after proving all new tables are empty. After
-- any canonical selection write, preserve evidence and roll forward.
--
-- Read-only post-migration validation queries for 001B-3:
-- SELECT COUNT(*) FROM request_selections;
-- SELECT COUNT(*) FROM request_selection_command_idempotency;
-- SELECT COUNT(*) FROM request_selection_evidence;
-- SELECT COUNT(*) FROM conversations
--   WHERE request_selection_id IS NOT NULL;
-- SELECT COUNT(*) FROM request_relationships
--   WHERE post_id IS NOT NULL AND status = 'active';
