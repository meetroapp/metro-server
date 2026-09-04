-- MEETRO EVALUATION REVISION R1
-- Additive authority vocabulary only.
--
-- A completed Evaluation remains completed and retains its original
-- completion timestamp. A professional revision appends a new canonical
-- Evaluation version through evaluation.revise / evaluation_revised.
--
-- This migration does not alter Quote, approval, deposit, payment,
-- scheduling, work, completion, relationship, or customer authority.

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
      'quote.draft.import_business_document',
      'quote.scope.add',
      'quote.scope.remove',
      'quote.issue',
      'quote.customer.approve',
      'quote.customer.decline',
      'quote.revision.create',
      'quote.external.approve',
      'evaluation.revise'
    )
  );

ALTER TABLE commercial_authority_evidence
  DROP CONSTRAINT IF EXISTS commercial_authority_evidence_evidence_type_check;

ALTER TABLE commercial_authority_evidence
  ADD CONSTRAINT commercial_authority_evidence_evidence_type_check
  CHECK (
    evidence_type IN (
      'commercial.aggregate.created',
      'commercial.aggregate.version_advanced',
      'evaluation_created',
      'evaluation_draft_updated',
      'evaluation_completed',
      'quote_draft_created',
      'quote_scope_item_added',
      'quote_scope_item_removed',
      'quote_issued',
      'quote_revision_created',
      'evaluation_revised'
    )
  );

ALTER TABLE commercial_authority_evidence
  DROP CONSTRAINT IF EXISTS commercial_authority_evidence_source_command_check;

ALTER TABLE commercial_authority_evidence
  ADD CONSTRAINT commercial_authority_evidence_source_command_check
  CHECK (
    source_command IN (
      'commercial.aggregate.create',
      'commercial.aggregate.version.advance',
      'evaluation.create',
      'evaluation.draft.update',
      'evaluation.complete',
      'quote.draft.create',
      'quote.draft.import_business_document',
      'quote.scope.add',
      'quote.scope.remove',
      'quote.issue',
      'quote.revision.create',
      'evaluation.revise'
    )
  );
