-- MC-AI-CORE-001: append-only human review evidence for non-canonical Ask
-- Meetro workflow proposals. This ledger grants no commercial, lifecycle,
-- financial, or publication authority.

CREATE TABLE IF NOT EXISTS intelligence_workflow_review_events (
  id UUID PRIMARY KEY,
  operation_id UUID NOT NULL
    REFERENCES intelligence_operation_idempotency(id)
    ON DELETE RESTRICT,
  operation_type TEXT NOT NULL
    CHECK (operation_type IN (
      'job_request.interpret',
      'evaluation.assist',
      'estimate.compose',
      'invoice.assist'
    )),
  actor_user_id INTEGER NOT NULL
    REFERENCES users(id)
    ON DELETE RESTRICT,
  proposal_element_id TEXT NOT NULL
    CHECK (
      char_length(proposal_element_id) BETWEEN 1 AND 160
      AND proposal_element_id ~ '^[a-z][a-z0-9_.:-]{0,159}$'
    ),
  action TEXT NOT NULL
    CHECK (action IN ('ACCEPTED', 'EDITED', 'REJECTED')),
  edited_value JSONB,
  record_context JSONB NOT NULL,
  canonical_source_references JSONB NOT NULL DEFAULT '[]'::jsonb,
  reason_category TEXT,
  learning_context JSONB NOT NULL,
  idempotency_key UUID NOT NULL,
  request_fingerprint TEXT NOT NULL
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT intelligence_workflow_review_edit_shape_check
    CHECK (
      (action = 'EDITED' AND edited_value IS NOT NULL)
      OR
      (action IN ('ACCEPTED', 'REJECTED') AND edited_value IS NULL)
    ),

  CONSTRAINT intelligence_workflow_review_context_object_check
    CHECK (jsonb_typeof(record_context) = 'object'),

  CONSTRAINT intelligence_workflow_review_sources_array_check
    CHECK (jsonb_typeof(canonical_source_references) = 'array'),

  CONSTRAINT intelligence_workflow_review_learning_object_check
    CHECK (jsonb_typeof(learning_context) = 'object'),

  CONSTRAINT intelligence_workflow_review_reason_check
    CHECK (
      reason_category IS NULL
      OR (
        char_length(reason_category) BETWEEN 3 AND 80
        AND reason_category ~ '^[A-Z][A-Z0-9_]{2,79}$'
      )
    ),

  CONSTRAINT intelligence_workflow_review_command_key
    UNIQUE (actor_user_id, operation_id, proposal_element_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS intelligence_workflow_review_operation_order_idx
ON intelligence_workflow_review_events(operation_id, created_at ASC, id ASC);

CREATE INDEX IF NOT EXISTS intelligence_workflow_review_actor_learning_idx
ON intelligence_workflow_review_events(actor_user_id, operation_type, action, created_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'intelligence_workflow_review_events_append_only'
  ) THEN
    CREATE TRIGGER intelligence_workflow_review_events_append_only
    BEFORE UPDATE OR DELETE ON intelligence_workflow_review_events
    FOR EACH ROW EXECUTE FUNCTION prevent_lifecycle_append_only_mutation();
  END IF;
END
$$;

COMMENT ON TABLE intelligence_workflow_review_events IS
  'Append-only human review evidence for advisory Ask Meetro proposals; learnedPatternIsCanonicalRule remains false and no canonical authority is granted.';
