-- Common Quote approval authority for preparation and execution.
-- Historical append-only rows are preserved. New evidence derives and validates
-- common identity from its exact canonical root; generic FKs close NULL-composite gaps.

ALTER TABLE canonical_work_preparation_plans ADD COLUMN quote_approval_id UUID, ADD COLUMN approval_source TEXT;

ALTER TABLE canonical_work_preparation_plans ALTER COLUMN relationship_id DROP NOT NULL;

ALTER TABLE canonical_work_preparation_plans ALTER COLUMN job_request_id DROP NOT NULL,
    ALTER COLUMN approved_customer_decision_id DROP NOT NULL,
    ALTER COLUMN approved_customer_decision DROP NOT NULL,
    ALTER COLUMN approved_customer_decision DROP DEFAULT,
    ALTER COLUMN customer_participant_id DROP NOT NULL;

ALTER TABLE canonical_work_preparation_plans ADD CONSTRAINT common_3957626ded_shape CHECK (quote_approval_id IS NOT NULL AND approval_source IS NOT NULL AND ((approval_source='MEETRO_CUSTOMER' AND relationship_id IS NOT NULL) OR (approval_source='EXTERNAL_EVIDENCE' AND relationship_id IS NULL)) AND ((approval_source='MEETRO_CUSTOMER' AND job_request_id IS NOT NULL AND approved_customer_decision_id IS NOT NULL AND approved_customer_decision='APPROVED' AND customer_participant_id IS NOT NULL) OR (approval_source='EXTERNAL_EVIDENCE' AND job_request_id IS NULL AND approved_customer_decision_id IS NULL AND approved_customer_decision IS NULL AND customer_participant_id IS NULL))) NOT VALID;

ALTER TABLE canonical_work_preparation_plans ADD CONSTRAINT common_3957626ded_approval_fk
 FOREIGN KEY (quote_approval_id,job_id,approval_source) REFERENCES canonical_quote_approvals(id,job_id,approval_source) ON DELETE RESTRICT;

CREATE UNIQUE INDEX common_3957626ded_approval_uidx ON canonical_work_preparation_plans(quote_approval_id) WHERE quote_approval_id IS NOT NULL;
ALTER TABLE canonical_work_preparation_plans ADD CONSTRAINT common_3957626ded_exact_approval_fk
 FOREIGN KEY (quote_approval_id,quote_id,issued_quote_version,job_id,approval_source,source_integrity_hash)
 REFERENCES canonical_quote_approvals(id,quote_id,issued_quote_version,job_id,approval_source,issued_integrity_hash) ON DELETE RESTRICT;
ALTER TABLE canonical_work_preparation_plans ADD CONSTRAINT common_3957626ded_customer_binding_fk
 FOREIGN KEY (quote_approval_id,approved_customer_decision_id) REFERENCES canonical_quote_approvals(id,customer_decision_id) ON DELETE RESTRICT;

ALTER TABLE canonical_work_preparation_plan_versions ADD COLUMN quote_approval_id UUID, ADD COLUMN approval_source TEXT;

ALTER TABLE canonical_work_preparation_plan_versions ALTER COLUMN relationship_id DROP NOT NULL;

ALTER TABLE canonical_work_preparation_plan_versions ADD CONSTRAINT common_dfb2df3e81_shape CHECK (quote_approval_id IS NOT NULL AND approval_source IS NOT NULL AND ((approval_source='MEETRO_CUSTOMER' AND relationship_id IS NOT NULL) OR (approval_source='EXTERNAL_EVIDENCE' AND relationship_id IS NULL))) NOT VALID;

ALTER TABLE canonical_work_preparation_plan_versions ADD CONSTRAINT common_dfb2df3e81_approval_fk
 FOREIGN KEY (quote_approval_id,job_id,approval_source) REFERENCES canonical_quote_approvals(id,job_id,approval_source) ON DELETE RESTRICT;

ALTER TABLE canonical_work_preparation_items ADD COLUMN quote_approval_id UUID, ADD COLUMN approval_source TEXT;

ALTER TABLE canonical_work_preparation_items ALTER COLUMN relationship_id DROP NOT NULL;

ALTER TABLE canonical_work_preparation_items ADD CONSTRAINT common_4cf63e0e14_shape CHECK (quote_approval_id IS NOT NULL AND approval_source IS NOT NULL AND ((approval_source='MEETRO_CUSTOMER' AND relationship_id IS NOT NULL) OR (approval_source='EXTERNAL_EVIDENCE' AND relationship_id IS NULL))) NOT VALID;

ALTER TABLE canonical_work_preparation_items ADD CONSTRAINT common_4cf63e0e14_approval_fk
 FOREIGN KEY (quote_approval_id,job_id,approval_source) REFERENCES canonical_quote_approvals(id,job_id,approval_source) ON DELETE RESTRICT;

ALTER TABLE canonical_work_preparation_item_snapshots ADD COLUMN quote_approval_id UUID, ADD COLUMN approval_source TEXT;

ALTER TABLE canonical_work_preparation_item_snapshots ALTER COLUMN relationship_id DROP NOT NULL;

ALTER TABLE canonical_work_preparation_item_snapshots ADD CONSTRAINT common_fabf43a48d_shape CHECK (quote_approval_id IS NOT NULL AND approval_source IS NOT NULL AND ((approval_source='MEETRO_CUSTOMER' AND relationship_id IS NOT NULL) OR (approval_source='EXTERNAL_EVIDENCE' AND relationship_id IS NULL))) NOT VALID;

ALTER TABLE canonical_work_preparation_item_snapshots ADD CONSTRAINT common_fabf43a48d_approval_fk
 FOREIGN KEY (quote_approval_id,job_id,approval_source) REFERENCES canonical_quote_approvals(id,job_id,approval_source) ON DELETE RESTRICT;

ALTER TABLE canonical_material_purchase_records ADD COLUMN quote_approval_id UUID, ADD COLUMN approval_source TEXT;

ALTER TABLE canonical_material_purchase_records ALTER COLUMN relationship_id DROP NOT NULL;

ALTER TABLE canonical_material_purchase_records ADD CONSTRAINT common_0362848f1f_shape CHECK (quote_approval_id IS NOT NULL AND approval_source IS NOT NULL AND ((approval_source='MEETRO_CUSTOMER' AND relationship_id IS NOT NULL) OR (approval_source='EXTERNAL_EVIDENCE' AND relationship_id IS NULL))) NOT VALID;

ALTER TABLE canonical_material_purchase_records ADD CONSTRAINT common_0362848f1f_approval_fk
 FOREIGN KEY (quote_approval_id,job_id,approval_source) REFERENCES canonical_quote_approvals(id,job_id,approval_source) ON DELETE RESTRICT;

ALTER TABLE canonical_material_purchase_corrections ADD COLUMN quote_approval_id UUID, ADD COLUMN approval_source TEXT;

ALTER TABLE canonical_material_purchase_corrections ALTER COLUMN relationship_id DROP NOT NULL;

ALTER TABLE canonical_material_purchase_corrections ADD CONSTRAINT common_213059ce62_shape CHECK (quote_approval_id IS NOT NULL AND approval_source IS NOT NULL AND ((approval_source='MEETRO_CUSTOMER' AND relationship_id IS NOT NULL) OR (approval_source='EXTERNAL_EVIDENCE' AND relationship_id IS NULL))) NOT VALID;

ALTER TABLE canonical_material_purchase_corrections ADD CONSTRAINT common_213059ce62_approval_fk
 FOREIGN KEY (quote_approval_id,job_id,approval_source) REFERENCES canonical_quote_approvals(id,job_id,approval_source) ON DELETE RESTRICT;

ALTER TABLE canonical_work_preparation_events ADD COLUMN quote_approval_id UUID, ADD COLUMN approval_source TEXT;

ALTER TABLE canonical_work_preparation_events ALTER COLUMN relationship_id DROP NOT NULL;

ALTER TABLE canonical_work_preparation_events ADD CONSTRAINT common_a32644fc02_shape CHECK (quote_approval_id IS NOT NULL AND approval_source IS NOT NULL AND ((approval_source='MEETRO_CUSTOMER' AND relationship_id IS NOT NULL) OR (approval_source='EXTERNAL_EVIDENCE' AND relationship_id IS NULL))) NOT VALID;

ALTER TABLE canonical_work_preparation_events ADD CONSTRAINT common_a32644fc02_approval_fk
 FOREIGN KEY (quote_approval_id,job_id,approval_source) REFERENCES canonical_quote_approvals(id,job_id,approval_source) ON DELETE RESTRICT;

ALTER TABLE canonical_work_preparation_evidence_references ADD COLUMN quote_approval_id UUID, ADD COLUMN approval_source TEXT;

ALTER TABLE canonical_work_preparation_evidence_references ALTER COLUMN relationship_id DROP NOT NULL;

ALTER TABLE canonical_work_preparation_evidence_references ADD CONSTRAINT common_2dd7e8f2c6_shape CHECK (quote_approval_id IS NOT NULL AND approval_source IS NOT NULL AND ((approval_source='MEETRO_CUSTOMER' AND relationship_id IS NOT NULL) OR (approval_source='EXTERNAL_EVIDENCE' AND relationship_id IS NULL))) NOT VALID;

ALTER TABLE canonical_work_preparation_evidence_references ADD CONSTRAINT common_2dd7e8f2c6_approval_fk
 FOREIGN KEY (quote_approval_id,job_id,approval_source) REFERENCES canonical_quote_approvals(id,job_id,approval_source) ON DELETE RESTRICT;

ALTER TABLE canonical_approved_work_executions ADD COLUMN quote_approval_id UUID, ADD COLUMN approval_source TEXT;

ALTER TABLE canonical_approved_work_executions ALTER COLUMN relationship_id DROP NOT NULL;

ALTER TABLE canonical_approved_work_executions ALTER COLUMN job_request_id DROP NOT NULL,
    ALTER COLUMN approved_customer_decision_id DROP NOT NULL,
    ALTER COLUMN approved_customer_decision DROP NOT NULL,
    ALTER COLUMN approved_customer_decision DROP DEFAULT,
    ALTER COLUMN customer_participant_id DROP NOT NULL;

ALTER TABLE canonical_approved_work_executions ADD CONSTRAINT common_b7c174ee72_shape CHECK (quote_approval_id IS NOT NULL AND approval_source IS NOT NULL AND ((approval_source='MEETRO_CUSTOMER' AND relationship_id IS NOT NULL) OR (approval_source='EXTERNAL_EVIDENCE' AND relationship_id IS NULL)) AND ((approval_source='MEETRO_CUSTOMER' AND job_request_id IS NOT NULL AND approved_customer_decision_id IS NOT NULL AND approved_customer_decision='APPROVED' AND customer_participant_id IS NOT NULL) OR (approval_source='EXTERNAL_EVIDENCE' AND job_request_id IS NULL AND approved_customer_decision_id IS NULL AND approved_customer_decision IS NULL AND customer_participant_id IS NULL))) NOT VALID;

ALTER TABLE canonical_approved_work_executions ADD CONSTRAINT common_b7c174ee72_approval_fk
 FOREIGN KEY (quote_approval_id,job_id,approval_source) REFERENCES canonical_quote_approvals(id,job_id,approval_source) ON DELETE RESTRICT;

CREATE UNIQUE INDEX common_b7c174ee72_approval_uidx ON canonical_approved_work_executions(quote_approval_id) WHERE quote_approval_id IS NOT NULL;
ALTER TABLE canonical_approved_work_executions ADD CONSTRAINT common_b7c174ee72_exact_approval_fk
 FOREIGN KEY (quote_approval_id,quote_id,issued_quote_version,job_id,approval_source,source_integrity_hash)
 REFERENCES canonical_quote_approvals(id,quote_id,issued_quote_version,job_id,approval_source,issued_integrity_hash) ON DELETE RESTRICT;
ALTER TABLE canonical_approved_work_executions ADD CONSTRAINT common_b7c174ee72_customer_binding_fk
 FOREIGN KEY (quote_approval_id,approved_customer_decision_id) REFERENCES canonical_quote_approvals(id,customer_decision_id) ON DELETE RESTRICT;

ALTER TABLE canonical_approved_work_execution_versions ADD COLUMN quote_approval_id UUID, ADD COLUMN approval_source TEXT;

ALTER TABLE canonical_approved_work_execution_versions ALTER COLUMN relationship_id DROP NOT NULL;

ALTER TABLE canonical_approved_work_execution_versions ALTER COLUMN customer_participant_id DROP NOT NULL;

ALTER TABLE canonical_approved_work_execution_versions ADD CONSTRAINT common_2829556891_shape CHECK (quote_approval_id IS NOT NULL AND approval_source IS NOT NULL AND ((approval_source='MEETRO_CUSTOMER' AND relationship_id IS NOT NULL) OR (approval_source='EXTERNAL_EVIDENCE' AND relationship_id IS NULL)) AND ((approval_source='MEETRO_CUSTOMER' AND customer_participant_id IS NOT NULL) OR (approval_source='EXTERNAL_EVIDENCE' AND customer_participant_id IS NULL))) NOT VALID;

ALTER TABLE canonical_approved_work_execution_versions ADD CONSTRAINT common_2829556891_approval_fk
 FOREIGN KEY (quote_approval_id,job_id,approval_source) REFERENCES canonical_quote_approvals(id,job_id,approval_source) ON DELETE RESTRICT;

ALTER TABLE canonical_approved_work_execution_workstreams ADD COLUMN quote_approval_id UUID, ADD COLUMN approval_source TEXT;

ALTER TABLE canonical_approved_work_execution_workstreams ALTER COLUMN relationship_id DROP NOT NULL;

ALTER TABLE canonical_approved_work_execution_workstreams ADD CONSTRAINT common_dc42876948_shape CHECK (quote_approval_id IS NOT NULL AND approval_source IS NOT NULL AND ((approval_source='MEETRO_CUSTOMER' AND relationship_id IS NOT NULL) OR (approval_source='EXTERNAL_EVIDENCE' AND relationship_id IS NULL))) NOT VALID;

ALTER TABLE canonical_approved_work_execution_workstreams ADD CONSTRAINT common_dc42876948_approval_fk
 FOREIGN KEY (quote_approval_id,job_id,approval_source) REFERENCES canonical_quote_approvals(id,job_id,approval_source) ON DELETE RESTRICT;

ALTER TABLE canonical_work_activity_execution_classifications ADD COLUMN quote_approval_id UUID, ADD COLUMN approval_source TEXT;

ALTER TABLE canonical_work_activity_execution_classifications ALTER COLUMN relationship_id DROP NOT NULL;

ALTER TABLE canonical_work_activity_execution_classifications ADD CONSTRAINT common_c0efef8d37_shape CHECK ((classification='EXECUTION' AND quote_approval_id IS NOT NULL AND approval_source IS NOT NULL AND ((approval_source='MEETRO_CUSTOMER' AND relationship_id IS NOT NULL) OR (approval_source='EXTERNAL_EVIDENCE' AND relationship_id IS NULL))) OR (classification='NON_EXECUTION' AND quote_approval_id IS NULL AND approval_source IS NULL)) NOT VALID;

ALTER TABLE canonical_work_activity_execution_classifications ADD CONSTRAINT common_c0efef8d37_approval_fk
 FOREIGN KEY (quote_approval_id,job_id,approval_source) REFERENCES canonical_quote_approvals(id,job_id,approval_source) ON DELETE RESTRICT;

ALTER TABLE canonical_approved_work_execution_start_events ADD COLUMN quote_approval_id UUID, ADD COLUMN approval_source TEXT;

ALTER TABLE canonical_approved_work_execution_start_events ALTER COLUMN relationship_id DROP NOT NULL;

ALTER TABLE canonical_approved_work_execution_start_events ALTER COLUMN approved_customer_decision_id DROP NOT NULL;

ALTER TABLE canonical_approved_work_execution_start_events ADD CONSTRAINT common_fcbf2e4828_shape CHECK (quote_approval_id IS NOT NULL AND approval_source IS NOT NULL AND ((approval_source='MEETRO_CUSTOMER' AND relationship_id IS NOT NULL) OR (approval_source='EXTERNAL_EVIDENCE' AND relationship_id IS NULL)) AND ((approval_source='MEETRO_CUSTOMER' AND approved_customer_decision_id IS NOT NULL) OR (approval_source='EXTERNAL_EVIDENCE' AND approved_customer_decision_id IS NULL))) NOT VALID;

ALTER TABLE canonical_approved_work_execution_start_events ADD CONSTRAINT common_fcbf2e4828_approval_fk
 FOREIGN KEY (quote_approval_id,job_id,approval_source) REFERENCES canonical_quote_approvals(id,job_id,approval_source) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS common_identity_531f512d3cc7 ON relationship_participants(id,job_id);

ALTER TABLE canonical_approved_work_execution_start_events ADD CONSTRAINT common_generic_27ffe98b7e03 FOREIGN KEY (recorded_by_participant_id,job_id) REFERENCES relationship_participants(id,job_id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS common_identity_a9ada77d2541 ON canonical_approved_work_executions(id,job_id);

ALTER TABLE canonical_approved_work_execution_start_events ADD CONSTRAINT common_generic_f9ec639178e5 FOREIGN KEY (execution_id,job_id) REFERENCES canonical_approved_work_executions(id,job_id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS common_identity_00ec563fcbf2 ON canonical_visits(id,job_id,purpose);

ALTER TABLE canonical_approved_work_execution_start_events ADD CONSTRAINT common_generic_44289deb4ed0 FOREIGN KEY (source_visit_id,job_id,source_visit_purpose) REFERENCES canonical_visits(id,job_id,purpose) ON DELETE RESTRICT;

ALTER TABLE canonical_approved_work_execution_versions ADD CONSTRAINT common_generic_65514c737108 FOREIGN KEY (recorded_by_participant_id,job_id) REFERENCES relationship_participants(id,job_id) ON DELETE RESTRICT;

ALTER TABLE canonical_approved_work_execution_versions ADD CONSTRAINT common_generic_31fa83f36fad FOREIGN KEY (execution_id,job_id) REFERENCES canonical_approved_work_executions(id,job_id) ON DELETE RESTRICT;

ALTER TABLE canonical_approved_work_execution_versions ADD CONSTRAINT common_generic_08eee23fcc58 FOREIGN KEY (successor_execution_id,job_id) REFERENCES canonical_approved_work_executions(id,job_id) ON DELETE RESTRICT;

ALTER TABLE canonical_approved_work_execution_workstreams ADD CONSTRAINT common_generic_7645a60f5554 FOREIGN KEY (execution_id,job_id) REFERENCES canonical_approved_work_executions(id,job_id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS common_identity_35eb418be670 ON jobs(id);

ALTER TABLE canonical_approved_work_execution_workstreams ADD CONSTRAINT common_generic_260a9edfa154 FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE RESTRICT;

ALTER TABLE canonical_approved_work_executions ADD CONSTRAINT common_generic_db60397cb114 FOREIGN KEY (customer_participant_id,job_id) REFERENCES relationship_participants(id,job_id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS common_identity_6bf6e03815f7 ON canonical_quote_customer_decisions(id,quote_id,issued_quote_version,job_id,decision,issued_integrity_hash,customer_participant_id);

ALTER TABLE canonical_approved_work_executions ADD CONSTRAINT common_generic_b46b465047a9 FOREIGN KEY (approved_customer_decision_id,quote_id,issued_quote_version,job_id,approved_customer_decision,source_integrity_hash,customer_participant_id) REFERENCES canonical_quote_customer_decisions(id,quote_id,issued_quote_version,job_id,decision,issued_integrity_hash,customer_participant_id) ON DELETE RESTRICT;

ALTER TABLE canonical_approved_work_executions ADD CONSTRAINT common_generic_b0926d9c3d8f FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE RESTRICT;

ALTER TABLE canonical_material_purchase_corrections ADD CONSTRAINT common_generic_28354b754253 FOREIGN KEY (recorded_by_participant_id,job_id) REFERENCES relationship_participants(id,job_id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS common_identity_974cb483bbd4 ON canonical_material_purchase_records(id,plan_id,basis_plan_version,item_id,job_id);

ALTER TABLE canonical_material_purchase_corrections ADD CONSTRAINT common_generic_41545e3e265e FOREIGN KEY (purchase_id,plan_id,basis_plan_version,item_id,job_id) REFERENCES canonical_material_purchase_records(id,plan_id,basis_plan_version,item_id,job_id) ON DELETE RESTRICT;

ALTER TABLE canonical_material_purchase_records ADD CONSTRAINT common_generic_9c1656671fed FOREIGN KEY (recorded_by_participant_id,job_id) REFERENCES relationship_participants(id,job_id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS common_identity_d1de7ed0719e ON canonical_pre_work_deposit_versions(obligation_id,version,job_id,currency);

ALTER TABLE canonical_material_purchase_records ADD CONSTRAINT common_generic_9bd5f9385191 FOREIGN KEY (deposit_obligation_id,deposit_obligation_version,job_id,deposit_currency) REFERENCES canonical_pre_work_deposit_versions(obligation_id,version,job_id,currency) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS common_identity_ae7c67a58c52 ON canonical_work_preparation_item_snapshots(plan_id,plan_version,item_id,job_id);

ALTER TABLE canonical_material_purchase_records ADD CONSTRAINT common_generic_e4caf057c3a0 FOREIGN KEY (plan_id,basis_plan_version,item_id,job_id) REFERENCES canonical_work_preparation_item_snapshots(plan_id,plan_version,item_id,job_id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS common_identity_5ddd8c554d37 ON canonical_work_preparation_plans(id,job_id);

ALTER TABLE canonical_material_purchase_records ADD CONSTRAINT common_generic_d0afd70442dc FOREIGN KEY (plan_id,job_id) REFERENCES canonical_work_preparation_plans(id,job_id) ON DELETE RESTRICT;

ALTER TABLE canonical_work_activity_execution_classifications ADD CONSTRAINT common_generic_e636c84ea06d FOREIGN KEY (classified_by_participant_id,job_id) REFERENCES relationship_participants(id,job_id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS common_identity_ca380bf35e0c ON canonical_approved_work_execution_workstreams(execution_id,workstream_id,job_id);

ALTER TABLE canonical_work_activity_execution_classifications ADD CONSTRAINT common_generic_9b8bc6ae514b FOREIGN KEY (execution_id,workstream_id,job_id) REFERENCES canonical_approved_work_execution_workstreams(execution_id,workstream_id,job_id) ON DELETE RESTRICT;

ALTER TABLE canonical_work_activity_execution_classifications ADD CONSTRAINT common_generic_5f47a847146b FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE RESTRICT;

ALTER TABLE canonical_work_preparation_events ADD CONSTRAINT common_generic_c464af22a312 FOREIGN KEY (recorded_by_participant_id,job_id) REFERENCES relationship_participants(id,job_id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS common_identity_e00643b00bb1 ON canonical_material_purchase_corrections(id,purchase_id,plan_id,basis_plan_version,item_id,job_id);

ALTER TABLE canonical_work_preparation_events ADD CONSTRAINT common_generic_74bc7820d74d FOREIGN KEY (purchase_correction_id,purchase_id,plan_id,plan_version,item_id,job_id) REFERENCES canonical_material_purchase_corrections(id,purchase_id,plan_id,basis_plan_version,item_id,job_id) ON DELETE RESTRICT;

ALTER TABLE canonical_work_preparation_events ADD CONSTRAINT common_generic_a4ec73b76d98 FOREIGN KEY (deposit_obligation_id,deposit_obligation_version,job_id,deposit_currency) REFERENCES canonical_pre_work_deposit_versions(obligation_id,version,job_id,currency) ON DELETE RESTRICT;

ALTER TABLE canonical_work_preparation_events ADD CONSTRAINT common_generic_8b856897b5d0 FOREIGN KEY (plan_id,plan_version,item_id,job_id) REFERENCES canonical_work_preparation_item_snapshots(plan_id,plan_version,item_id,job_id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS common_identity_998e856b5c45 ON canonical_work_preparation_plan_versions(plan_id,version,job_id);

ALTER TABLE canonical_work_preparation_events ADD CONSTRAINT common_generic_7cbe7f9bd274 FOREIGN KEY (plan_id,plan_version,job_id) REFERENCES canonical_work_preparation_plan_versions(plan_id,version,job_id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS common_identity_784dfc951290 ON canonical_work_preparation_events(id,plan_id,job_id);

ALTER TABLE canonical_work_preparation_events ADD CONSTRAINT common_generic_54ff5d844281 FOREIGN KEY (previous_event_id,plan_id,job_id) REFERENCES canonical_work_preparation_events(id,plan_id,job_id) ON DELETE RESTRICT;

ALTER TABLE canonical_work_preparation_events ADD CONSTRAINT common_generic_37966035aba6 FOREIGN KEY (purchase_id,plan_id,plan_version,item_id,job_id) REFERENCES canonical_material_purchase_records(id,plan_id,basis_plan_version,item_id,job_id) ON DELETE RESTRICT;

ALTER TABLE canonical_work_preparation_evidence_references ADD CONSTRAINT common_generic_62a63d7b7939 FOREIGN KEY (recorded_by_participant_id,job_id) REFERENCES relationship_participants(id,job_id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS common_identity_c564c34e8a64 ON canonical_material_purchase_corrections(id,plan_id,job_id);

ALTER TABLE canonical_work_preparation_evidence_references ADD CONSTRAINT common_generic_18d377ea556e FOREIGN KEY (purchase_correction_id,plan_id,job_id) REFERENCES canonical_material_purchase_corrections(id,plan_id,job_id) ON DELETE RESTRICT;

ALTER TABLE canonical_work_preparation_evidence_references ADD CONSTRAINT common_generic_04971c80959c FOREIGN KEY (event_id,plan_id,job_id) REFERENCES canonical_work_preparation_events(id,plan_id,job_id) ON DELETE RESTRICT;

ALTER TABLE canonical_work_preparation_evidence_references ADD CONSTRAINT common_generic_d2869ba9c476 FOREIGN KEY (plan_id,job_id) REFERENCES canonical_work_preparation_plans(id,job_id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS common_identity_3043f3321ddf ON canonical_material_purchase_records(id,plan_id,job_id);

ALTER TABLE canonical_work_preparation_evidence_references ADD CONSTRAINT common_generic_64003e46a7d7 FOREIGN KEY (purchase_id,plan_id,job_id) REFERENCES canonical_material_purchase_records(id,plan_id,job_id) ON DELETE RESTRICT;

ALTER TABLE canonical_work_preparation_item_snapshots ADD CONSTRAINT common_generic_99e6fc13e369 FOREIGN KEY (recorded_by_participant_id,job_id) REFERENCES relationship_participants(id,job_id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS common_identity_890bc29a47b0 ON canonical_work_preparation_items(id,plan_id,job_id);

ALTER TABLE canonical_work_preparation_item_snapshots ADD CONSTRAINT common_generic_06eb82d0e596 FOREIGN KEY (item_id,plan_id,job_id) REFERENCES canonical_work_preparation_items(id,plan_id,job_id) ON DELETE RESTRICT;

ALTER TABLE canonical_work_preparation_item_snapshots ADD CONSTRAINT common_generic_0daff7721b1a FOREIGN KEY (plan_id,plan_version,job_id) REFERENCES canonical_work_preparation_plan_versions(plan_id,version,job_id) ON DELETE RESTRICT;

ALTER TABLE canonical_work_preparation_items ADD CONSTRAINT common_generic_ca7b325745e5 FOREIGN KEY (created_by_participant_id,job_id) REFERENCES relationship_participants(id,job_id) ON DELETE RESTRICT;

ALTER TABLE canonical_work_preparation_items ADD CONSTRAINT common_generic_f5a24faf6f16 FOREIGN KEY (plan_id,job_id) REFERENCES canonical_work_preparation_plans(id,job_id) ON DELETE RESTRICT;

ALTER TABLE canonical_work_preparation_plan_versions ADD CONSTRAINT common_generic_ef4db320e9de FOREIGN KEY (recorded_by_participant_id,job_id) REFERENCES relationship_participants(id,job_id) ON DELETE RESTRICT;

ALTER TABLE canonical_work_preparation_plan_versions ADD CONSTRAINT common_generic_d26026580d84 FOREIGN KEY (plan_id,job_id) REFERENCES canonical_work_preparation_plans(id,job_id) ON DELETE RESTRICT;

ALTER TABLE canonical_work_preparation_plans ADD CONSTRAINT common_generic_e9bd57d80ea2 FOREIGN KEY (approved_customer_decision_id,quote_id,issued_quote_version,job_id,approved_customer_decision,source_integrity_hash,customer_participant_id) REFERENCES canonical_quote_customer_decisions(id,quote_id,issued_quote_version,job_id,decision,issued_integrity_hash,customer_participant_id) ON DELETE RESTRICT;

ALTER TABLE canonical_work_preparation_plans ADD CONSTRAINT common_generic_b41bbe868559 FOREIGN KEY (customer_participant_id,job_id) REFERENCES relationship_participants(id,job_id) ON DELETE RESTRICT;

ALTER TABLE canonical_work_preparation_plans ADD CONSTRAINT common_generic_3cb999e40108 FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE RESTRICT;

CREATE FUNCTION bind_common_execution_root_approval() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE approval RECORD; origin RECORD;
BEGIN
 SELECT a.* INTO approval FROM canonical_quote_approvals a
 WHERE a.job_id=NEW.job_id AND a.quote_id=NEW.quote_id
   AND a.issued_quote_version=NEW.issued_quote_version AND a.issued_integrity_hash=NEW.source_integrity_hash
   AND ((NEW.quote_approval_id IS NOT NULL AND a.id=NEW.quote_approval_id)
     OR (NEW.quote_approval_id IS NULL AND a.customer_decision_id=NEW.approved_customer_decision_id));
 IF NOT FOUND THEN RAISE EXCEPTION 'Exact common Quote approval required for preparation/execution.' USING ERRCODE = '23503'; END IF;
 IF NEW.approval_source IS NOT NULL AND NEW.approval_source<>approval.approval_source
 THEN RAISE EXCEPTION 'Common approval source mismatch.' USING ERRCODE = '23503'; END IF;
 NEW.quote_approval_id:=approval.id; NEW.approval_source:=approval.approval_source;
 SELECT jobs.*,profiles.user_id AS professional_user_id INTO origin FROM jobs
 LEFT JOIN contractor_profiles profiles ON profiles.id=jobs.contractor_profile_id WHERE jobs.id=NEW.job_id;
 IF NEW.job_request_id IS DISTINCT FROM origin.job_request_id
   OR NEW.relationship_id IS DISTINCT FROM origin.source_request_relationship_id
   OR NEW.approved_customer_decision_id IS DISTINCT FROM approval.customer_decision_id
 THEN RAISE EXCEPTION 'Preparation/execution origin provenance mismatch.' USING ERRCODE = '23503'; END IF;
 IF approval.approval_source='EXTERNAL_EVIDENCE' THEN
   IF origin.source_type<>'business_document' OR NEW.customer_participant_id IS NOT NULL
     OR NEW.approved_customer_decision IS NOT NULL
     OR NOT EXISTS (SELECT 1 FROM relationship_participants actor
       WHERE actor.id=NEW.created_by_professional_participant_id AND actor.job_id=NEW.job_id
         AND actor.user_id=origin.professional_user_id AND actor.request_relationship_id IS NULL)
   THEN RAISE EXCEPTION 'External preparation/execution requires the real business professional.' USING ERRCODE = '23503'; END IF;
 ELSE
   IF origin.source_type<>'ordinary_request_selection'
   THEN RAISE EXCEPTION 'Meetro approval requires marketplace origin.' USING ERRCODE = '23503'; END IF;
   -- Legacy direct insert callers may omit only the constant decision label.
   NEW.approved_customer_decision:=COALESCE(NEW.approved_customer_decision,'APPROVED');
 END IF;
 RETURN NEW;
END; $$;

CREATE TRIGGER a_common_root_approval BEFORE INSERT ON canonical_work_preparation_plans FOR EACH ROW EXECUTE FUNCTION bind_common_execution_root_approval();

CREATE TRIGGER a_common_root_approval BEFORE INSERT ON canonical_approved_work_executions FOR EACH ROW EXECUTE FUNCTION bind_common_execution_root_approval();

CREATE FUNCTION bind_common_execution_child_approval() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE root_record RECORD; approval RECORD; root_id UUID; origin RECORD;
BEGIN
 IF TG_ARGV[0]='plan' THEN
   root_id:=NEW.plan_id;
   SELECT * INTO root_record FROM canonical_work_preparation_plans WHERE id=root_id AND job_id=NEW.job_id;
 ELSE
   root_id:=NEW.execution_id;
   IF root_id IS NULL AND TG_TABLE_NAME='canonical_work_activity_execution_classifications' THEN
     SELECT * INTO origin FROM jobs WHERE id=NEW.job_id;
     IF NOT FOUND OR NEW.relationship_id IS DISTINCT FROM origin.source_request_relationship_id
       OR NEW.quote_approval_id IS NOT NULL OR NEW.approval_source IS NOT NULL
     THEN RAISE EXCEPTION 'Non-execution classification origin mismatch.' USING ERRCODE = '23503'; END IF;
     RETURN NEW;
   END IF;
   SELECT * INTO root_record FROM canonical_approved_work_executions WHERE id=root_id AND job_id=NEW.job_id;
 END IF;
 IF root_record.id IS NULL THEN RAISE EXCEPTION 'Exact preparation/execution root required.' USING ERRCODE = '23503'; END IF;
 SELECT * INTO approval FROM canonical_quote_approvals a WHERE a.job_id=NEW.job_id
   AND (a.id=root_record.quote_approval_id OR
     (root_record.quote_approval_id IS NULL AND a.customer_decision_id=root_record.approved_customer_decision_id));
 IF NOT FOUND OR (NEW.quote_approval_id IS NOT NULL AND NEW.quote_approval_id<>approval.id)
   OR (NEW.approval_source IS NOT NULL AND NEW.approval_source<>approval.approval_source)
   OR NEW.relationship_id IS DISTINCT FROM root_record.relationship_id
 THEN RAISE EXCEPTION 'Preparation/execution child approval mismatch.' USING ERRCODE = '23503'; END IF;
 NEW.quote_approval_id:=approval.id; NEW.approval_source:=approval.approval_source;
 IF TG_TABLE_NAME='canonical_approved_work_execution_versions' THEN
   IF NEW.customer_participant_id IS DISTINCT FROM root_record.customer_participant_id
   THEN RAISE EXCEPTION 'Execution version customer provenance mismatch.' USING ERRCODE = '23503'; END IF;
 END IF;
 IF TG_TABLE_NAME='canonical_approved_work_execution_start_events' THEN
   IF NEW.approved_customer_decision_id IS DISTINCT FROM root_record.approved_customer_decision_id
   THEN RAISE EXCEPTION 'Execution start customer provenance mismatch.' USING ERRCODE = '23503'; END IF;
 END IF;
 RETURN NEW;
END; $$;

CREATE TRIGGER a_common_child_approval BEFORE INSERT ON canonical_work_preparation_plan_versions FOR EACH ROW EXECUTE FUNCTION bind_common_execution_child_approval('plan');

CREATE TRIGGER a_common_child_approval BEFORE INSERT ON canonical_work_preparation_items FOR EACH ROW EXECUTE FUNCTION bind_common_execution_child_approval('plan');

CREATE TRIGGER a_common_child_approval BEFORE INSERT ON canonical_work_preparation_item_snapshots FOR EACH ROW EXECUTE FUNCTION bind_common_execution_child_approval('plan');

CREATE TRIGGER a_common_child_approval BEFORE INSERT ON canonical_material_purchase_records FOR EACH ROW EXECUTE FUNCTION bind_common_execution_child_approval('plan');

CREATE TRIGGER a_common_child_approval BEFORE INSERT ON canonical_material_purchase_corrections FOR EACH ROW EXECUTE FUNCTION bind_common_execution_child_approval('plan');

CREATE TRIGGER a_common_child_approval BEFORE INSERT ON canonical_work_preparation_events FOR EACH ROW EXECUTE FUNCTION bind_common_execution_child_approval('plan');

CREATE TRIGGER a_common_child_approval BEFORE INSERT ON canonical_work_preparation_evidence_references FOR EACH ROW EXECUTE FUNCTION bind_common_execution_child_approval('plan');

CREATE TRIGGER a_common_child_approval BEFORE INSERT ON canonical_approved_work_execution_versions FOR EACH ROW EXECUTE FUNCTION bind_common_execution_child_approval('execution');

CREATE TRIGGER a_common_child_approval BEFORE INSERT ON canonical_approved_work_execution_workstreams FOR EACH ROW EXECUTE FUNCTION bind_common_execution_child_approval('execution');

CREATE TRIGGER a_common_child_approval BEFORE INSERT ON canonical_work_activity_execution_classifications FOR EACH ROW EXECUTE FUNCTION bind_common_execution_child_approval('execution');

CREATE TRIGGER a_common_child_approval BEFORE INSERT ON canonical_approved_work_execution_start_events FOR EACH ROW EXECUTE FUNCTION bind_common_execution_child_approval('execution');

CREATE OR REPLACE FUNCTION enforce_approved_work_execution_version_sequence()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  previous_version INTEGER;
  previous_state TEXT;
  creates_cycle BOOLEAN;
BEGIN
  PERFORM 1
  FROM canonical_approved_work_executions
  WHERE id = NEW.execution_id
    AND job_id = NEW.job_id
    AND relationship_id IS NOT DISTINCT FROM NEW.relationship_id
  FOR UPDATE;

  SELECT version, state
  INTO previous_version, previous_state
  FROM canonical_approved_work_execution_versions
  WHERE execution_id = NEW.execution_id
  ORDER BY version DESC
  LIMIT 1;

  IF NEW.version = 1 THEN
    IF previous_version IS NOT NULL OR NEW.state <> 'ACTIVE' THEN
      RAISE EXCEPTION 'approved Work execution version 1 must be the first ACTIVE version'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    IF previous_version IS NULL OR previous_version <> NEW.version - 1 THEN
      RAISE EXCEPTION 'approved Work execution versions must be contiguous'
        USING ERRCODE = '23514';
    END IF;
    IF previous_state <> 'ACTIVE' OR NEW.state = 'ACTIVE' THEN
      RAISE EXCEPTION 'approved Work execution terminal state cannot transition'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.state = 'SUPERSEDED' THEN
    WITH RECURSIVE successor_chain(execution_id) AS (
      SELECT NEW.successor_execution_id
      UNION
      SELECT current.successor_execution_id
      FROM successor_chain chain
      JOIN LATERAL (
        SELECT versions.successor_execution_id
        FROM canonical_approved_work_execution_versions versions
        WHERE versions.execution_id = chain.execution_id
          AND versions.state = 'SUPERSEDED'
        ORDER BY versions.version DESC
        LIMIT 1
      ) current ON current.successor_execution_id IS NOT NULL
    )
    SELECT EXISTS (
      SELECT 1 FROM successor_chain
      WHERE execution_id = NEW.execution_id
    ) INTO creates_cycle;
    IF creates_cycle THEN
      RAISE EXCEPTION 'approved Work execution supersession cannot be circular'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_canonical_material_purchase_item()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item_record RECORD;
BEGIN
  SELECT item_kind, provider_responsibility INTO item_record
  FROM canonical_work_preparation_item_snapshots
  WHERE plan_id = NEW.plan_id AND plan_version = NEW.basis_plan_version
    AND item_id = NEW.item_id AND job_id = NEW.job_id
    AND relationship_id IS NOT DISTINCT FROM NEW.relationship_id;
  IF NOT FOUND OR item_record.item_kind <> 'MATERIAL'
    OR item_record.provider_responsibility <> 'BUSINESS' THEN
    RAISE EXCEPTION 'material purchases require an exact BUSINESS-provided MATERIAL item'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_work_preparation_event_item_semantics()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item_record RECORD;
BEGIN
  IF NEW.item_id IS NULL THEN RETURN NEW; END IF;
  SELECT item_kind, provider_responsibility INTO item_record
  FROM canonical_work_preparation_item_snapshots
  WHERE plan_id = NEW.plan_id AND plan_version = NEW.plan_version
    AND item_id = NEW.item_id AND job_id = NEW.job_id
    AND relationship_id IS NOT DISTINCT FROM NEW.relationship_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF NEW.event_type IN ('CUSTOMER_ITEM_REQUESTED', 'CUSTOMER_ITEM_RECEIVED')
    AND NOT (item_record.item_kind = 'MATERIAL' AND item_record.provider_responsibility = 'CUSTOMER') THEN
    RAISE EXCEPTION 'customer item events require a CUSTOMER-provided MATERIAL item' USING ERRCODE = '23514';
  END IF;
  IF NEW.event_type IN ('MATERIAL_STAGED', 'BUSINESS_INVENTORY_ALLOCATED')
    AND NOT (item_record.item_kind = 'MATERIAL' AND item_record.provider_responsibility = 'BUSINESS') THEN
    RAISE EXCEPTION 'business material events require a BUSINESS-provided MATERIAL item' USING ERRCODE = '23514';
  END IF;
  IF NEW.event_type = 'TOOLS_READY' AND item_record.item_kind <> 'TOOL' THEN
    RAISE EXCEPTION 'TOOLS_READY requires a TOOL item' USING ERRCODE = '23514';
  END IF;
  IF NEW.event_type = 'EQUIPMENT_READY' AND item_record.item_kind <> 'EQUIPMENT' THEN
    RAISE EXCEPTION 'EQUIPMENT_READY requires an EQUIPMENT item' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE canonical_approved_work_execution_start_events
 ADD COLUMN source_visit_quote_approval_id UUID,
 ADD COLUMN external_confirmation_evidence_id UUID,
 ADD COLUMN confirmed_visit_version INTEGER;
ALTER TABLE canonical_approved_work_execution_start_events
 ADD CONSTRAINT execution_start_common_visit_fk FOREIGN KEY
 (source_visit_id,job_id,source_visit_purpose,source_visit_quote_approval_id)
 REFERENCES canonical_visits(id,job_id,purpose,quote_approval_id) ON DELETE RESTRICT,
 ADD CONSTRAINT execution_start_external_confirmation_fk FOREIGN KEY
 (external_confirmation_evidence_id,source_visit_id,job_id,confirmed_visit_version,quote_approval_id)
 REFERENCES canonical_visit_external_confirmation_evidence(id,visit_id,job_id,scheduled_visit_version,quote_approval_id) ON DELETE RESTRICT,
 ADD CONSTRAINT execution_start_external_confirmation_shape CHECK (
   (approval_source='EXTERNAL_EVIDENCE' AND source_type='APPROVED_WORK_VISIT'
    AND source_visit_quote_approval_id IS NOT NULL AND source_visit_quote_approval_id=quote_approval_id
    AND external_confirmation_evidence_id IS NOT NULL AND confirmed_visit_version IS NOT NULL
    AND confirmed_visit_version=source_visit_version-1)
   OR (approval_source='MEETRO_CUSTOMER' AND external_confirmation_evidence_id IS NULL AND confirmed_visit_version IS NULL)
   OR (source_type='EXECUTION_ACTIVITY' AND source_visit_quote_approval_id IS NULL
    AND external_confirmation_evidence_id IS NULL AND confirmed_visit_version IS NULL)
 ) NOT VALID;
CREATE FUNCTION bind_common_execution_start_visit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE visit RECORD; evidence RECORD;
BEGIN
 IF NEW.source_type='APPROVED_WORK_VISIT' THEN
   SELECT * INTO visit FROM canonical_visits WHERE id=NEW.source_visit_id AND job_id=NEW.job_id;
   IF NOT FOUND OR visit.purpose<>'APPROVED_WORK'
     OR (visit.quote_approval_id IS NOT NULL AND visit.quote_approval_id<>NEW.quote_approval_id)
     OR (visit.quote_approval_id IS NULL AND (NEW.approval_source<>'MEETRO_CUSTOMER'
       OR visit.approved_quote_decision_id IS DISTINCT FROM NEW.approved_customer_decision_id))
   THEN RAISE EXCEPTION 'Execution start requires exact Visit approval.' USING ERRCODE = '23503'; END IF;
   IF NEW.source_visit_quote_approval_id IS NOT NULL AND NEW.source_visit_quote_approval_id IS DISTINCT FROM visit.quote_approval_id
   THEN RAISE EXCEPTION 'Execution start Visit approval mismatch.' USING ERRCODE = '23503'; END IF;
   NEW.source_visit_quote_approval_id:=visit.quote_approval_id;
   IF NEW.approval_source='EXTERNAL_EVIDENCE' THEN
     SELECT * INTO evidence FROM canonical_visit_external_confirmation_evidence
       WHERE visit_id=NEW.source_visit_id AND job_id=NEW.job_id
         AND scheduled_visit_version=NEW.source_visit_version-1 AND quote_approval_id=NEW.quote_approval_id;
     IF NOT FOUND OR (NEW.external_confirmation_evidence_id IS NOT NULL AND NEW.external_confirmation_evidence_id<>evidence.id)
       OR (NEW.confirmed_visit_version IS NOT NULL AND NEW.confirmed_visit_version<>evidence.scheduled_visit_version)
     THEN RAISE EXCEPTION 'External execution start requires exact scheduled confirmation.' USING ERRCODE = '23503'; END IF;
     NEW.external_confirmation_evidence_id:=evidence.id; NEW.confirmed_visit_version:=evidence.scheduled_visit_version;
   END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER b_common_execution_start_visit BEFORE INSERT ON canonical_approved_work_execution_start_events
 FOR EACH ROW EXECUTE FUNCTION bind_common_execution_start_visit();
CREATE FUNCTION require_external_visit_execution_start() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.state='STARTED' AND EXISTS (SELECT 1 FROM canonical_visits WHERE id=NEW.visit_id AND quote_approval_source='EXTERNAL_EVIDENCE')
   AND NOT EXISTS (SELECT 1 FROM canonical_approved_work_execution_start_events
     WHERE source_visit_id=NEW.visit_id AND job_id=NEW.job_id AND source_visit_version=NEW.version
       AND approval_source='EXTERNAL_EVIDENCE' AND external_confirmation_evidence_id IS NOT NULL)
 THEN RAISE EXCEPTION 'External Visit start requires canonical execution start evidence.' USING ERRCODE = '23503'; END IF;
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER canonical_external_visit_execution_start AFTER INSERT ON canonical_visit_versions
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_external_visit_execution_start();
