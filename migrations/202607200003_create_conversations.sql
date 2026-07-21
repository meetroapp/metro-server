CREATE TABLE IF NOT EXISTS conversations (
  id SERIAL PRIMARY KEY,

  relationship_id INTEGER NOT NULL
    REFERENCES request_relationships(id)
    ON DELETE RESTRICT,

  homeowner_id INTEGER NOT NULL
    REFERENCES users(id)
    ON DELETE RESTRICT,

  contractor_id INTEGER NOT NULL
    REFERENCES contractor_profiles(id)
    ON DELETE RESTRICT,

  professional_user_id INTEGER NOT NULL
    REFERENCES users(id)
    ON DELETE RESTRICT,

  status TEXT NOT NULL DEFAULT 'active'
    CHECK (
      status IN (
        'active',
        'closed'
      )
    ),

  homeowner_archived_at TIMESTAMP,
  professional_archived_at TIMESTAMP,
  closed_at TIMESTAMP,

  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT conversations_unique_relationship
    UNIQUE (relationship_id),

  CONSTRAINT conversations_different_users
    CHECK (homeowner_id <> professional_user_id)
);

CREATE INDEX IF NOT EXISTS conversations_homeowner_idx
ON conversations(homeowner_id);

CREATE INDEX IF NOT EXISTS conversations_professional_idx
ON conversations(professional_user_id);

CREATE INDEX IF NOT EXISTS conversations_contractor_idx
ON conversations(contractor_id);

CREATE INDEX IF NOT EXISTS conversations_status_idx
ON conversations(status);
