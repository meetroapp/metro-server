CREATE TABLE IF NOT EXISTS request_relationships (
  id SERIAL PRIMARY KEY,

  post_id INTEGER NOT NULL
    REFERENCES posts(id)
    ON DELETE CASCADE,

  homeowner_id INTEGER NOT NULL
    REFERENCES users(id)
    ON DELETE CASCADE,

  contractor_id INTEGER NOT NULL
    REFERENCES contractor_profiles(id)
    ON DELETE CASCADE,

  professional_user_id INTEGER NOT NULL
    REFERENCES users(id)
    ON DELETE CASCADE,

  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (
      status IN (
        'pending',
        'active',
        'declined',
        'withdrawn',
        'closed'
      )
    ),

  introduction_text TEXT NOT NULL DEFAULT '',

  responded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  accepted_at TIMESTAMP,
  declined_at TIMESTAMP,
  withdrawn_at TIMESTAMP,
  closed_at TIMESTAMP,

  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT request_relationships_unique_response
    UNIQUE (post_id, contractor_id),

  CONSTRAINT request_relationships_different_users
    CHECK (homeowner_id <> professional_user_id)
);

CREATE INDEX IF NOT EXISTS request_relationships_homeowner_idx
ON request_relationships(homeowner_id);

CREATE INDEX IF NOT EXISTS request_relationships_professional_idx
ON request_relationships(professional_user_id);

CREATE INDEX IF NOT EXISTS request_relationships_post_idx
ON request_relationships(post_id);
