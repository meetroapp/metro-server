-- MC-PL-WPWE-FINAL: additive Work Plan execution visibility and append-only
-- Work Activity update command support. Existing Activities remain private.

ALTER TABLE canonical_work_activity_versions
  ADD COLUMN IF NOT EXISTS customer_visible BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE canonical_workflow_command_idempotency
  DROP CONSTRAINT IF EXISTS canonical_workflow_command_idempotency_command_name_check;

ALTER TABLE canonical_workflow_command_idempotency
  ADD CONSTRAINT canonical_workflow_command_idempotency_command_name_check
  CHECK (
    command_name IN (
      'workstream.create',
      'finding.assign_workstream',
      'work_activity.create',
      'work_activity.update',
      'work_activity.progress',
      'work_obligation.create',
      'finding.resolve',
      'work_obligation.transition',
      'workstream.complete'
    )
  );
