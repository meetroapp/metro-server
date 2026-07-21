-- Add canonical conversation identity to messages without changing legacy quote-request compatibility.

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS conversation_id INTEGER
    REFERENCES conversations(id)
    ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS messages_conversation_id_created_at_id_idx
  ON messages(conversation_id, created_at ASC, id ASC);
