-- MC-PL-EFR-FINAL: preserve explicit customer visibility for versioned
-- Findings and Recommendations. Existing records remain professional-only.

ALTER TABLE canonical_evaluation_finding_versions
  ADD COLUMN IF NOT EXISTS customer_visible BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE canonical_recommendation_versions
  ADD COLUMN IF NOT EXISTS customer_visible BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE commercial_command_idempotency
  DROP CONSTRAINT IF EXISTS commercial_command_idempotency_command_name_check;

ALTER TABLE commercial_command_idempotency
  ADD CONSTRAINT commercial_command_idempotency_command_name_check
  CHECK (
    command_name IN (
      'commercial.aggregate.create',
      'commercial.aggregate.version.advance',
      'evaluation.create',
      'evaluation.draft.update',
      'evaluation.complete',
      'finding.submit',
      'finding.update',
      'finding.concern.link',
      'finding.evidence.add',
      'finding.confirm',
      'quote.draft.create',
      'quote.scope.add',
      'quote.scope.remove',
      'quote.issue',
      'quote.customer.approve',
      'quote.customer.decline',
      'quote.revision.create'
    )
  );

ALTER TABLE canonical_recommendation_command_idempotency
  DROP CONSTRAINT IF EXISTS canonical_recommendation_command_idempotency_command_name_check;

ALTER TABLE canonical_recommendation_command_idempotency
  ADD CONSTRAINT canonical_recommendation_command_idempotency_command_name_check
  CHECK (
    command_name IN (
      'recommendation.create',
      'recommendation.update',
      'recommendation.transition',
      'customer_constraint.record'
    )
  );
