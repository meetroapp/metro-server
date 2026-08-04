-- Establish participant-specific canonical conversation read authority.

CREATE TABLE IF NOT EXISTS conversation_participant_state (
  conversation_id INTEGER NOT NULL
    REFERENCES conversations(id)
    ON DELETE CASCADE,

  user_id INTEGER NOT NULL
    REFERENCES users(id)
    ON DELETE CASCADE,

  participant_role TEXT NOT NULL
    CHECK (
      participant_role IN (
        'homeowner',
        'professional'
      )
    ),

  last_read_message_id INTEGER
    REFERENCES messages(id)
    ON DELETE SET NULL,

  last_read_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (conversation_id, user_id)
);

CREATE INDEX IF NOT EXISTS conversation_participant_state_user_idx
ON conversation_participant_state(user_id);

CREATE INDEX IF NOT EXISTS conversation_participant_state_last_read_message_idx
ON conversation_participant_state(last_read_message_id)
WHERE last_read_message_id IS NOT NULL;

INSERT INTO conversation_participant_state
(
  conversation_id,
  user_id,
  participant_role,
  last_read_message_id,
  last_read_at
)
SELECT
  conversations.id,
  participants.user_id,
  participants.participant_role,
  latest_message.id,
  COALESCE(
    latest_message.created_at,
    CURRENT_TIMESTAMP
  )
FROM conversations
CROSS JOIN LATERAL (
  VALUES
    (conversations.homeowner_id, 'homeowner'),
    (
      conversations.professional_user_id,
      'professional'
    )
) AS participants(user_id, participant_role)
LEFT JOIN LATERAL (
  SELECT
    messages.id,
    messages.created_at
  FROM messages
  WHERE messages.conversation_id = conversations.id
  ORDER BY messages.id DESC
  LIMIT 1
) AS latest_message ON TRUE
ON CONFLICT (conversation_id, user_id)
DO NOTHING;
