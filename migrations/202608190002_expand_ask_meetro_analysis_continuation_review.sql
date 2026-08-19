-- MC-QUICK-QUOTE-PHOTO-INTELLIGENCE-001B3B-R1 / R1-03C
-- Expand the append-only Ask Meetro workflow-review operation allowlist to
-- include governed private Job Analysis continuation proposals.
--
-- This grants review-event persistence only. It creates no Quote, Job,
-- Request, Conversation, Invoice, Payment, Visit, lifecycle, customer-
-- visibility, publication, pricing, or canonical mutation authority.
-- Continuation proposals remain advisory and require explicit professional
-- ACCEPTED / EDITED / REJECTED decisions before reviewed content can be
-- trusted by a later continuation.

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
    'quick_quote.photo_assist',
    'quick_quote.analysis.continue'
  ));

COMMENT ON CONSTRAINT
  intelligence_workflow_review_events_operation_type_check
  ON intelligence_workflow_review_events
IS
  'Allows only governed non-canonical workflow proposal operations, including private Quick Quote Job Analysis continuation.';
