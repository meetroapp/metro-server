-- MC-JOB-LIFECYCLE-004I-Q1: append-only professional review evidence for
-- non-canonical AI Quote Composition Proposals. Canonical Quote authority is
-- intentionally absent from this ledger.

CREATE TABLE IF NOT EXISTS intelligence_quote_composition_feedback (
  id UUID PRIMARY KEY,
  operation_id UUID NOT NULL
    REFERENCES intelligence_operation_idempotency(id)
    ON DELETE RESTRICT,
  proposal_id UUID NOT NULL,
  job_id UUID NOT NULL
    REFERENCES jobs(id)
    ON DELETE RESTRICT,
  professional_user_id INTEGER NOT NULL
    REFERENCES users(id)
    ON DELETE RESTRICT,
  professional_participant_id UUID NOT NULL,
  proposal_element_id TEXT NOT NULL
    CHECK (
      char_length(proposal_element_id) BETWEEN 1 AND 80
      AND proposal_element_id ~ '^[a-z][a-z0-9_-]{0,79}$'
    ),
  action TEXT NOT NULL
    CHECK (action IN ('ACCEPTED', 'EDITED', 'REJECTED')),
  edited_value JSONB,
  canonical_source_references JSONB NOT NULL DEFAULT '[]'::jsonb,
  reason_category TEXT,
  learning_context JSONB NOT NULL,
  idempotency_key UUID NOT NULL,
  request_fingerprint TEXT NOT NULL
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT intelligence_quote_feedback_proposal_operation_check
    CHECK (proposal_id = operation_id),

  CONSTRAINT intelligence_quote_feedback_actor_fk
    FOREIGN KEY (professional_participant_id, job_id)
    REFERENCES relationship_participants(id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT intelligence_quote_feedback_edit_shape_check
    CHECK (
      (action = 'EDITED' AND edited_value IS NOT NULL AND jsonb_typeof(edited_value) = 'object')
      OR
      (action IN ('ACCEPTED', 'REJECTED') AND edited_value IS NULL)
    ),

  CONSTRAINT intelligence_quote_feedback_sources_array_check
    CHECK (jsonb_typeof(canonical_source_references) = 'array'),

  CONSTRAINT intelligence_quote_feedback_learning_object_check
    CHECK (jsonb_typeof(learning_context) = 'object'),

  CONSTRAINT intelligence_quote_feedback_reason_check
    CHECK (
      reason_category IS NULL
      OR (
        char_length(reason_category) BETWEEN 3 AND 80
        AND reason_category ~ '^[A-Z][A-Z0-9_]{2,79}$'
      )
    ),

  CONSTRAINT intelligence_quote_feedback_command_key
    UNIQUE (professional_user_id, proposal_id, proposal_element_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS intelligence_quote_feedback_proposal_order_idx
ON intelligence_quote_composition_feedback(
  proposal_id,
  created_at ASC,
  id ASC
);

CREATE INDEX IF NOT EXISTS intelligence_quote_feedback_learning_idx
ON intelligence_quote_composition_feedback(
  job_id,
  action,
  created_at DESC
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'intelligence_quote_composition_feedback_append_only'
  ) THEN
    CREATE TRIGGER intelligence_quote_composition_feedback_append_only
    BEFORE UPDATE OR DELETE ON intelligence_quote_composition_feedback
    FOR EACH ROW EXECUTE FUNCTION prevent_lifecycle_append_only_mutation();
  END IF;
END
$$;

COMMENT ON TABLE intelligence_quote_composition_feedback IS
  'Append-only professional review evidence for non-canonical AI Quote Composition Proposals; grants no commercial or lifecycle authority.';
