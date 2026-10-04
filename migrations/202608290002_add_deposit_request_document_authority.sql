-- Migration 63 source definition. Writing this file does not execute it.
-- It extends only the existing private working-document and delivery types.

ALTER TABLE business_document_working_drafts
  ADD COLUMN IF NOT EXISTS payment_requirement_id UUID;

CREATE UNIQUE INDEX IF NOT EXISTS
  canonical_pre_work_deposit_obligation_document_binding_uidx
ON canonical_pre_work_deposit_obligations(id, job_id);

ALTER TABLE business_document_working_drafts
  DROP CONSTRAINT IF EXISTS business_document_working_drafts_document_type_check;

ALTER TABLE business_document_working_drafts
  ADD CONSTRAINT business_document_working_drafts_document_type_check
  CHECK (document_type IN ('QUOTE', 'INVOICE', 'DEPOSIT_REQUEST'));

ALTER TABLE business_document_working_drafts
  DROP CONSTRAINT IF EXISTS business_document_working_drafts_payment_requirement_fk;

ALTER TABLE business_document_working_drafts
  ADD CONSTRAINT business_document_working_drafts_payment_requirement_fk
  FOREIGN KEY (payment_requirement_id, job_id)
  REFERENCES canonical_pre_work_deposit_obligations(id, job_id)
  ON DELETE RESTRICT;

ALTER TABLE business_document_working_drafts
  DROP CONSTRAINT IF EXISTS business_document_working_drafts_purpose_shape_check;

ALTER TABLE business_document_working_drafts
  ADD CONSTRAINT business_document_working_drafts_purpose_shape_check
  CHECK (
    (
      document_type = 'DEPOSIT_REQUEST'
      AND payment_requirement_id IS NOT NULL
      AND job_id IS NOT NULL
      AND document_number IS NULL
    )
    OR
    (
      document_type IN ('QUOTE', 'INVOICE')
      AND payment_requirement_id IS NULL
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS
  business_document_working_drafts_deposit_requirement_uidx
ON business_document_working_drafts(contractor_profile_id, payment_requirement_id)
WHERE document_type = 'DEPOSIT_REQUEST';

ALTER TABLE business_document_delivery_events
  DROP CONSTRAINT IF EXISTS business_document_delivery_events_document_type_check;

ALTER TABLE business_document_delivery_events
  ADD CONSTRAINT business_document_delivery_events_document_type_check
  CHECK (document_type IN ('QUOTE', 'INVOICE', 'DEPOSIT_REQUEST'));

COMMENT ON COLUMN business_document_working_drafts.payment_requirement_id IS
  'Exact pre-work deposit obligation requested by a DEPOSIT_REQUEST working document; not payment evidence or Invoice authority.';
