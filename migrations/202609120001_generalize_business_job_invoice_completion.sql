-- Preserve marketplace identity; accept only a real business-customer Job as
-- the alternative Invoice owner. Existing append-only evidence is not rewritten.
ALTER TABLE canonical_invoices ALTER COLUMN job_request_id DROP NOT NULL,
  ALTER COLUMN relationship_id DROP NOT NULL;
ALTER TABLE canonical_invoices ADD CONSTRAINT canonical_invoice_exact_job_fk
  FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE RESTRICT;

CREATE FUNCTION assert_canonical_invoice_job_origin() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job jobs%ROWTYPE;
BEGIN
 SELECT * INTO job FROM jobs WHERE id=NEW.job_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Invoice Job unavailable'; END IF;
 IF job.source_type='ordinary_request_selection' THEN
   IF NEW.job_request_id IS DISTINCT FROM job.job_request_id OR NEW.relationship_id IS DISTINCT FROM job.source_request_relationship_id
   THEN RAISE EXCEPTION 'Invoice marketplace authority mismatch'; END IF;
 ELSIF job.source_type='business_document' THEN
   IF NEW.job_request_id IS NOT NULL OR NEW.relationship_id IS NOT NULL OR job.business_contact_id IS NULL OR job.business_customer_relationship_id IS NULL
   THEN RAISE EXCEPTION 'Invoice business customer authority mismatch'; END IF;
 ELSE RAISE EXCEPTION 'Unsupported Invoice Job origin'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER canonical_invoice_job_origin_guard BEFORE INSERT OR UPDATE ON canonical_invoices
 FOR EACH ROW EXECUTE FUNCTION assert_canonical_invoice_job_origin();

ALTER TABLE canonical_invoice_issuances ALTER COLUMN conversation_id DROP NOT NULL,
  ALTER COLUMN message_id DROP NOT NULL;
ALTER TABLE canonical_invoice_issuances ADD COLUMN delivery_channel TEXT NOT NULL DEFAULT 'MEETRO';
ALTER TABLE canonical_invoice_issuances ADD CONSTRAINT canonical_invoice_issuance_transport_check CHECK (
 (delivery_channel='MEETRO' AND conversation_id IS NOT NULL AND message_id IS NOT NULL)
 OR (delivery_channel='EXTERNAL' AND conversation_id IS NULL AND message_id IS NULL));
CREATE FUNCTION assert_external_invoice_issuance_origin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.delivery_channel='EXTERNAL' AND NOT EXISTS(SELECT 1 FROM jobs WHERE id=NEW.job_id AND source_type='business_document'
   AND business_customer_relationship_id IS NOT NULL AND business_contact_id IS NOT NULL)
 THEN RAISE EXCEPTION 'External Invoice issuance requires exact business customer Job'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER canonical_invoice_external_issuance_origin_guard BEFORE INSERT ON canonical_invoice_issuances
 FOR EACH ROW EXECUTE FUNCTION assert_external_invoice_issuance_origin();

-- The professional participant is real. Bootstrap the same work-management
-- capabilities for existing business Jobs without creating a customer participant.
INSERT INTO lifecycle_authority_grants(id,grantee_participant_id,grantor_participant_id,job_id,
 capability,scope_type,scope_job_id,source_evidence_type,source_evidence_reference,idempotency_key)
 SELECT gen_random_uuid(),p.id,p.id,j.id,c.capability,'job',j.id,'business_document',
 j.originating_business_document_id::text,'business-document:'||j.originating_business_document_id::text||':grant:'||c.capability
 FROM jobs j JOIN contractor_profiles profiles ON profiles.id=j.contractor_profile_id
 JOIN relationship_participants p ON p.job_id=j.id AND p.user_id=profiles.user_id AND p.request_relationship_id IS NULL
 CROSS JOIN lifecycle_capabilities c
 WHERE j.source_type='business_document' AND c.capability IN
 ('workstream.create','workstream.read','finding.assign_workstream','work_activity.create','work_activity.progress',
 'work_activity.read','work_obligation.create','work_obligation.read','finding.resolve','work_obligation.transition','workstream.complete')
 ON CONFLICT DO NOTHING;

CREATE TABLE canonical_invoice_external_communications (
 id UUID PRIMARY KEY, invoice_id UUID NOT NULL, invoice_version INTEGER NOT NULL, job_id UUID NOT NULL,
 actor_user_id INTEGER NOT NULL REFERENCES users(id), purpose TEXT NOT NULL CHECK(purpose IN ('INVOICE','REMINDER')),
 recipient_email TEXT NOT NULL, customer_message TEXT, idempotency_key TEXT NOT NULL,
 request_fingerprint TEXT NOT NULL CHECK(request_fingerprint ~ '^[0-9a-f]{64}$'),
 state TEXT NOT NULL CHECK(state IN ('REQUESTING','DELIVERY_REQUESTED','FAILED')),
 provider_status TEXT, provider_reference TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, completed_at TIMESTAMPTZ,
 FOREIGN KEY(invoice_id,invoice_version,job_id) REFERENCES canonical_invoice_versions(invoice_id,version,job_id) ON DELETE RESTRICT,
 UNIQUE(actor_user_id,idempotency_key),
 CHECK((state='REQUESTING' AND completed_at IS NULL) OR (state<>'REQUESTING' AND completed_at IS NOT NULL))
);
CREATE FUNCTION guard_invoice_external_communication() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Invoice communication evidence cannot be deleted'; END IF;
 IF OLD.state<>'REQUESTING' OR NEW.state='REQUESTING'
   OR (to_jsonb(NEW)-ARRAY['state','provider_status','provider_reference','completed_at']) IS DISTINCT FROM
      (to_jsonb(OLD)-ARRAY['state','provider_status','provider_reference','completed_at'])
 THEN RAISE EXCEPTION 'Invoice communication evidence cannot be rewritten'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER invoice_external_communication_evidence_guard BEFORE UPDATE OR DELETE ON canonical_invoice_external_communications
 FOR EACH ROW EXECUTE FUNCTION guard_invoice_external_communication();

CREATE UNIQUE INDEX canonical_quote_approval_invoice_source_key ON canonical_quote_approvals(id,job_id,quote_id,issued_quote_version);
ALTER TABLE canonical_invoice_line_item_snapshots ADD COLUMN source_quote_approval_id UUID;
ALTER TABLE canonical_invoice_line_item_snapshots ADD CONSTRAINT canonical_invoice_line_approval_fk
 FOREIGN KEY(source_quote_approval_id,job_id,source_quote_id,source_quote_version)
 REFERENCES canonical_quote_approvals(id,job_id,quote_id,issued_quote_version) ON DELETE RESTRICT;
CREATE FUNCTION assert_business_invoice_line_approval() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.source_type='APPROVED_QUOTE_SCOPE' AND EXISTS(SELECT 1 FROM jobs WHERE id=NEW.job_id AND source_type='business_document')
 AND (NEW.source_quote_approval_id IS NULL OR NOT EXISTS(SELECT 1 FROM canonical_quote_approvals WHERE id=NEW.source_quote_approval_id
   AND job_id=NEW.job_id AND quote_id=NEW.source_quote_id AND issued_quote_version=NEW.source_quote_version AND approval_source='EXTERNAL_EVIDENCE'))
 THEN RAISE EXCEPTION 'External Invoice scope requires exact approved Quote evidence'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER canonical_invoice_line_external_approval_guard BEFORE INSERT ON canonical_invoice_line_item_snapshots
 FOR EACH ROW EXECUTE FUNCTION assert_business_invoice_line_approval();
