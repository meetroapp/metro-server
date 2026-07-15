-- Governed additive workflow-event persistence required by authenticated routes.
CREATE TABLE IF NOT EXISTS workflow_events (
  id SERIAL PRIMARY KEY,
  quote_request_id INTEGER NOT NULL REFERENCES quote_requests(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workflow_type TEXT NOT NULL,
  workflow_status TEXT,
  workflow_payload JSONB DEFAULT '{}'::jsonb,
  event_label TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS workflow_events_quote_request_id_created_at_idx
  ON workflow_events(quote_request_id, created_at ASC);
