-- MC-QUICK-QUOTE-PHOTO-INTELLIGENCE-001B3B-R1 / R1-02A
-- Durable private Quick Quote Job Analysis session foundation.
--
-- This migration creates only private, non-canonical analysis-session
-- persistence: exact user ownership, append-only evidence versions,
-- deterministic turn ordering, and bounded command idempotency.
--
-- It creates no Quote, Job, Request, Conversation, Invoice, Payment,
-- lifecycle, customer-visibility, publication, or provider authority.
-- It creates no business rows and performs no historical backfill.
--
-- Analysis session, evidence, and turn rows are immutable while present.
-- DELETE is intentionally not blocked because an explicit governed discard
-- must be able to permanently remove this private working draft later.

CREATE TABLE IF NOT EXISTS quick_quote_analysis_command_idempotency (
  id UUID PRIMARY KEY,

  actor_user_id INTEGER NOT NULL
    REFERENCES users(id)
    ON DELETE RESTRICT,

  authority_scope TEXT NOT NULL
    CHECK (char_length(authority_scope) BETWEEN 1 AND 200),

  command_name TEXT NOT NULL
    CHECK (
      command_name IN (
        'quick_quote.analysis_session.create',
        'quick_quote.analysis_evidence.append',
        'quick_quote.analysis_turn.append',
        'quick_quote.analysis_session.discard'
      )
    ),

  command_scope TEXT NOT NULL
    CHECK (char_length(btrim(command_scope)) BETWEEN 1 AND 300),

  idempotency_key TEXT NOT NULL
    CHECK (
      idempotency_key ~*
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    ),

  request_fingerprint TEXT NOT NULL
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),

  result_reference JSONB,

  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT quick_quote_analysis_command_authority_scope_check
    CHECK (authority_scope = 'user:' || actor_user_id::TEXT),

  CONSTRAINT quick_quote_analysis_command_result_check
    CHECK (
      (
        result_reference IS NULL
        AND completed_at IS NULL
      )
      OR
      (
        result_reference IS NOT NULL
        AND jsonb_typeof(result_reference) = 'object'
        AND octet_length(result_reference::TEXT) <= 4096
        AND completed_at IS NOT NULL
      )
    ),

  CONSTRAINT quick_quote_analysis_command_key
    UNIQUE (
      actor_user_id,
      authority_scope,
      command_name,
      command_scope,
      idempotency_key
    ),

  CONSTRAINT quick_quote_analysis_command_actor_identity_key
    UNIQUE (id, actor_user_id)
);

CREATE INDEX IF NOT EXISTS quick_quote_analysis_command_actor_created_idx
ON quick_quote_analysis_command_idempotency(
  actor_user_id,
  command_name,
  created_at DESC,
  id DESC
);


CREATE TABLE IF NOT EXISTS quick_quote_analysis_sessions (
  id UUID PRIMARY KEY,

  actor_user_id INTEGER NOT NULL
    REFERENCES users(id)
    ON DELETE RESTRICT,

  authority_scope TEXT NOT NULL
    CHECK (char_length(authority_scope) BETWEEN 1 AND 200),

  authority_classification TEXT NOT NULL
    DEFAULT 'PRIVATE_NON_CANONICAL'
    CHECK (authority_classification = 'PRIVATE_NON_CANONICAL'),

  created_command_idempotency_id UUID NOT NULL UNIQUE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT quick_quote_analysis_session_authority_scope_check
    CHECK (authority_scope = 'user:' || actor_user_id::TEXT),

  CONSTRAINT quick_quote_analysis_session_create_command_fk
    FOREIGN KEY (
      created_command_idempotency_id,
      actor_user_id
    )
    REFERENCES quick_quote_analysis_command_idempotency(
      id,
      actor_user_id
    )
    ON DELETE RESTRICT,

  CONSTRAINT quick_quote_analysis_session_actor_identity_key
    UNIQUE (id, actor_user_id)
);

CREATE INDEX IF NOT EXISTS quick_quote_analysis_session_actor_created_idx
ON quick_quote_analysis_sessions(
  actor_user_id,
  created_at DESC,
  id DESC
);


CREATE TABLE IF NOT EXISTS quick_quote_analysis_evidence_versions (
  session_id UUID NOT NULL,

  version INTEGER NOT NULL
    CHECK (version >= 1),

  actor_user_id INTEGER NOT NULL,

  professional_input TEXT NOT NULL DEFAULT ''
    CHECK (char_length(professional_input) <= 4000),

  photo_references JSONB NOT NULL DEFAULT '[]'::jsonb,

  evidence_fingerprint TEXT NOT NULL
    CHECK (evidence_fingerprint ~ '^[0-9a-f]{64}$'),

  command_idempotency_id UUID NOT NULL UNIQUE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT quick_quote_analysis_evidence_key
    PRIMARY KEY (session_id, version),

  CONSTRAINT quick_quote_analysis_evidence_session_fk
    FOREIGN KEY (
      session_id,
      actor_user_id
    )
    REFERENCES quick_quote_analysis_sessions(
      id,
      actor_user_id
    )
    ON DELETE CASCADE,

  CONSTRAINT quick_quote_analysis_evidence_command_fk
    FOREIGN KEY (
      command_idempotency_id,
      actor_user_id
    )
    REFERENCES quick_quote_analysis_command_idempotency(
      id,
      actor_user_id
    )
    ON DELETE RESTRICT,

  CONSTRAINT quick_quote_analysis_evidence_photos_check
    CHECK (
      jsonb_typeof(photo_references) = 'array'
      AND jsonb_array_length(photo_references) <= 5
      AND octet_length(photo_references::TEXT) <= 32768
    ),

  CONSTRAINT quick_quote_analysis_evidence_nonempty_check
    CHECK (
      char_length(btrim(professional_input)) > 0
      OR jsonb_array_length(photo_references) > 0
    ),

  CONSTRAINT quick_quote_analysis_evidence_actor_identity_key
    UNIQUE (session_id, version, actor_user_id)
);

CREATE INDEX IF NOT EXISTS quick_quote_analysis_evidence_latest_idx
ON quick_quote_analysis_evidence_versions(
  session_id,
  version DESC
);


CREATE TABLE IF NOT EXISTS quick_quote_analysis_turns (
  id UUID PRIMARY KEY,

  session_id UUID NOT NULL,

  turn_index INTEGER NOT NULL
    CHECK (turn_index >= 1),

  actor_user_id INTEGER NOT NULL,

  evidence_version INTEGER NOT NULL
    CHECK (evidence_version >= 1),

  role TEXT NOT NULL
    CHECK (role IN ('PROFESSIONAL', 'MEETRO')),

  authority_classification TEXT NOT NULL
    DEFAULT 'PRIVATE_NON_CANONICAL'
    CHECK (authority_classification = 'PRIVATE_NON_CANONICAL'),

  turn_payload JSONB NOT NULL,

  command_idempotency_id UUID NOT NULL UNIQUE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT quick_quote_analysis_turn_session_fk
    FOREIGN KEY (
      session_id,
      actor_user_id
    )
    REFERENCES quick_quote_analysis_sessions(
      id,
      actor_user_id
    )
    ON DELETE CASCADE,

  CONSTRAINT quick_quote_analysis_turn_evidence_fk
    FOREIGN KEY (
      session_id,
      evidence_version,
      actor_user_id
    )
    REFERENCES quick_quote_analysis_evidence_versions(
      session_id,
      version,
      actor_user_id
    )
    ON DELETE CASCADE,

  CONSTRAINT quick_quote_analysis_turn_command_fk
    FOREIGN KEY (
      command_idempotency_id,
      actor_user_id
    )
    REFERENCES quick_quote_analysis_command_idempotency(
      id,
      actor_user_id
    )
    ON DELETE RESTRICT,

  CONSTRAINT quick_quote_analysis_turn_payload_check
    CHECK (
      jsonb_typeof(turn_payload) = 'object'
      AND octet_length(turn_payload::TEXT) <= 65536
    ),

  CONSTRAINT quick_quote_analysis_turn_order_key
    UNIQUE (session_id, turn_index),

  CONSTRAINT quick_quote_analysis_turn_actor_identity_key
    UNIQUE (id, session_id, actor_user_id)
);

CREATE INDEX IF NOT EXISTS quick_quote_analysis_turn_history_idx
ON quick_quote_analysis_turns(
  session_id,
  turn_index ASC,
  id ASC
);


CREATE OR REPLACE FUNCTION prevent_quick_quote_analysis_private_history_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'Quick Quote private analysis session history is immutable while present'
    USING ERRCODE = '55000';
END;
$$;


DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'quick_quote_analysis_sessions_immutable'
  ) THEN
    CREATE TRIGGER quick_quote_analysis_sessions_immutable
    BEFORE UPDATE ON quick_quote_analysis_sessions
    FOR EACH ROW
    EXECUTE FUNCTION prevent_quick_quote_analysis_private_history_update();
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'quick_quote_analysis_evidence_versions_immutable'
  ) THEN
    CREATE TRIGGER quick_quote_analysis_evidence_versions_immutable
    BEFORE UPDATE ON quick_quote_analysis_evidence_versions
    FOR EACH ROW
    EXECUTE FUNCTION prevent_quick_quote_analysis_private_history_update();
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'quick_quote_analysis_turns_immutable'
  ) THEN
    CREATE TRIGGER quick_quote_analysis_turns_immutable
    BEFORE UPDATE ON quick_quote_analysis_turns
    FOR EACH ROW
    EXECUTE FUNCTION prevent_quick_quote_analysis_private_history_update();
  END IF;
END
$$;


COMMENT ON TABLE quick_quote_analysis_command_idempotency IS
  'Bounded retry identity for private Quick Quote Job Analysis session commands; stores no provider transport and grants no business authority.';

COMMENT ON TABLE quick_quote_analysis_sessions IS
  'Private non-canonical Quick Quote Job Analysis session identity owned by one authenticated user and removable by explicit governed discard.';

COMMENT ON TABLE quick_quote_analysis_evidence_versions IS
  'Immutable evidence versions for one private Job Analysis session; professional input and governed photo references remain non-canonical working evidence.';

COMMENT ON TABLE quick_quote_analysis_turns IS
  'Ordered private Job Analysis conversation turns bound to the exact evidence version they were created from; no Quote or lifecycle authority is granted.';
