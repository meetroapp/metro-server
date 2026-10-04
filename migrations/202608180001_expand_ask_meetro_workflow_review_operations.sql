-- MC-QUICK-QUOTE-PHOTO-INTELLIGENCE-001B3A:
-- allow append-only human review evidence for the governed standalone
-- Quick Quote photo-assistance proposal. This expands only the advisory
-- review-event operation allowlist and grants no Quote, Job, Request,
-- lifecycle, financial, customer-visibility, or publication authority.


ALTER TABLE intelligence_workflow_review_events
  DROP CONSTRAINT IF EXISTS
    intelligence_workflow_review_events_operation_type_check;

ALTER TABLE intelligence_workflow_review_events
  ADD CONSTRAINT intelligence_workflow_review_events_operation_type_check
  CHECK (operation_type IN (
    'job_request.interpret',
    'evaluation.assist',
    'estimate.compose',
    'invoice.assist',
    'quick_quote.photo_assist'
  ));


COMMENT ON CONSTRAINT
  intelligence_workflow_review_events_operation_type_check
  ON intelligence_workflow_review_events
IS
  'Allows only governed non-canonical workflow proposal operations, including standalone Quick Quote photo assistance.';
