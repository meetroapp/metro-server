-- Task 54: durable Emergency -> Standard Job Request follow-up authority.
-- The completed Emergency remains source_type=emergency_request.
-- The follow-up remains an ordinary Job Request in posts and may later
-- materialize its own source_type=ordinary_request_selection Job.

CREATE UNIQUE INDEX IF NOT EXISTS jobs_emergency_follow_up_identity_uidx
ON jobs(id, source_emergency_request_id, created_by_user_id);

CREATE UNIQUE INDEX IF NOT EXISTS emergency_requests_follow_up_owner_identity_uidx
ON emergency_requests(id, homeowner_id);

CREATE UNIQUE INDEX IF NOT EXISTS posts_emergency_follow_up_owner_identity_uidx
ON posts(id, user_id);

CREATE UNIQUE INDEX IF NOT EXISTS job_request_create_command_follow_up_result_uidx
ON job_request_create_command_idempotency(id, actor_user_id, post_id);

CREATE TABLE IF NOT EXISTS emergency_follow_up_job_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  relation_type TEXT NOT NULL DEFAULT 'EMERGENCY_FOLLOW_UP'
    CHECK (relation_type = 'EMERGENCY_FOLLOW_UP'),
  emergency_job_id UUID NOT NULL,
  emergency_request_id INTEGER NOT NULL,
  homeowner_user_id INTEGER NOT NULL,
  follow_up_job_request_id INTEGER NOT NULL,
  job_request_create_command_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT emergency_follow_up_job_request_unique UNIQUE (follow_up_job_request_id),
  CONSTRAINT emergency_follow_up_command_unique UNIQUE (job_request_create_command_id),

  CONSTRAINT emergency_follow_up_job_identity_fkey
    FOREIGN KEY (emergency_job_id, emergency_request_id, homeowner_user_id)
    REFERENCES jobs(id, source_emergency_request_id, created_by_user_id)
    ON DELETE RESTRICT,

  CONSTRAINT emergency_follow_up_request_owner_fkey
    FOREIGN KEY (emergency_request_id, homeowner_user_id)
    REFERENCES emergency_requests(id, homeowner_id)
    ON DELETE RESTRICT,

  CONSTRAINT emergency_follow_up_standard_request_owner_fkey
    FOREIGN KEY (follow_up_job_request_id, homeowner_user_id)
    REFERENCES posts(id, user_id)
    ON DELETE RESTRICT,

  CONSTRAINT emergency_follow_up_create_command_fkey
    FOREIGN KEY (job_request_create_command_id, homeowner_user_id, follow_up_job_request_id)
    REFERENCES job_request_create_command_idempotency(id, actor_user_id, post_id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS emergency_follow_up_emergency_job_idx
ON emergency_follow_up_job_requests(emergency_job_id, created_at ASC, id ASC);

CREATE INDEX IF NOT EXISTS emergency_follow_up_emergency_request_idx
ON emergency_follow_up_job_requests(emergency_request_id, created_at ASC, id ASC);

CREATE OR REPLACE FUNCTION assert_emergency_follow_up_job_request_authority()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM jobs
    INNER JOIN emergency_requests
      ON emergency_requests.id = jobs.source_emergency_request_id
     AND emergency_requests.homeowner_id = jobs.created_by_user_id
    INNER JOIN canonical_job_completion_records completions
      ON completions.job_id = jobs.id
    INNER JOIN posts
      ON posts.id = NEW.follow_up_job_request_id
     AND posts.user_id = NEW.homeowner_user_id
    INNER JOIN job_request_create_command_idempotency commands
      ON commands.id = NEW.job_request_create_command_id
     AND commands.actor_user_id = NEW.homeowner_user_id
     AND commands.post_id = NEW.follow_up_job_request_id
    WHERE jobs.id = NEW.emergency_job_id
      AND jobs.source_type = 'emergency_request'
      AND jobs.job_request_id IS NULL
      AND jobs.source_emergency_request_id = NEW.emergency_request_id
      AND jobs.created_by_user_id = NEW.homeowner_user_id
      AND emergency_requests.status = 'completed'
      AND emergency_requests.completed_at IS NOT NULL
      AND posts.lifecycle_contract_version = 2
      AND posts.cancelled_at IS NULL
      AND commands.command_name = 'job_request.create'
      AND commands.command_scope = 'ordinary'
      AND commands.completed_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'Emergency follow-up requires one completed Emergency and its homeowner-owned Standard Job Request.'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER emergency_follow_up_job_request_authority_guard
BEFORE INSERT ON emergency_follow_up_job_requests
FOR EACH ROW EXECUTE FUNCTION assert_emergency_follow_up_job_request_authority();

CREATE OR REPLACE FUNCTION guard_emergency_follow_up_job_request_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Emergency follow-up Job Request linkage is immutable.'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER emergency_follow_up_job_request_history_guard
BEFORE UPDATE OR DELETE ON emergency_follow_up_job_requests
FOR EACH ROW EXECUTE FUNCTION guard_emergency_follow_up_job_request_history();

COMMENT ON TABLE emergency_follow_up_job_requests IS
  'Immutable linkage from one completed Emergency Job to a distinct homeowner-owned Standard Job Request. It never converts, overwrites, or changes the Emergency Job source identity.';

COMMENT ON COLUMN emergency_follow_up_job_requests.follow_up_job_request_id IS
  'Ordinary Job Request in posts. Any later canonical Job is resolved through the existing ordinary request selection lifecycle.';
