-- Private draft archive only; this grants no canonical cancellation/void authority.
ALTER TABLE business_document_working_drafts
  DROP CONSTRAINT IF EXISTS business_document_working_drafts_draft_status_check;
ALTER TABLE business_document_working_drafts
  ADD CONSTRAINT business_document_working_drafts_draft_status_check
  CHECK (draft_status IN ('WORKING_DRAFT', 'ARCHIVED'));

ALTER TABLE business_document_working_drafts
  ADD CONSTRAINT business_document_archived_number_required
  CHECK (draft_status <> 'ARCHIVED' OR document_number IS NOT NULL);

CREATE OR REPLACE FUNCTION preserve_numbered_business_document_history()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.document_number IS NOT NULL THEN
      RAISE EXCEPTION 'numbered business documents must be archived, not deleted'
        USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.draft_status = 'ARCHIVED' THEN
    RAISE EXCEPTION 'archived business documents are immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER preserve_numbered_business_document_history_trigger
BEFORE UPDATE OR DELETE ON business_document_working_drafts
FOR EACH ROW EXECUTE FUNCTION preserve_numbered_business_document_history();

-- The existing number uniqueness index and number immutability trigger remain.
COMMENT ON COLUMN business_document_working_drafts.draft_status IS
  'Private WORKING_DRAFT or immutable numbered ARCHIVED history; never canonical Quote/Invoice lifecycle authority.';
