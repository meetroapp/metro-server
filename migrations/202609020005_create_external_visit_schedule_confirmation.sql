-- Canonical business-recorded external customer schedule confirmation.
-- Adds evidence and vocabulary; never rewrites Visit history or fabricates customer authority.
INSERT INTO lifecycle_capabilities (capability) VALUES ('visit.external_confirmation.record')
ON CONFLICT (capability) DO NOTHING;

ALTER TABLE canonical_visit_command_idempotency
  DROP CONSTRAINT canonical_visit_command_idempotency_command_name_check;
ALTER TABLE canonical_visit_command_idempotency
  ADD CONSTRAINT canonical_visit_command_idempotency_command_name_check CHECK (command_name IN (
    'visit.propose','visit.confirm','visit.change_request','visit.reschedule','visit.cancel',
    'visit.start','visit.complete','visit.link_evaluation','visit.external_confirmation.record'));

ALTER TABLE canonical_visit_events DROP CONSTRAINT canonical_visit_events_event_type_check;
ALTER TABLE canonical_visit_events ADD CONSTRAINT canonical_visit_events_event_type_check CHECK (event_type IN (
  'VISIT_PROPOSED','VISIT_CHANGE_REQUESTED','VISIT_SCHEDULE_PROPOSED','VISIT_CONFIRMED',
  'VISIT_RESCHEDULED','VISIT_CANCELLED','VISIT_STARTED','VISIT_COMPLETED','VISIT_EXTERNAL_CONFIRMATION_RECORDED'));

ALTER TABLE canonical_visit_events DROP CONSTRAINT canonical_visit_event_transition_shape_check;
ALTER TABLE canonical_visit_events
ADD CONSTRAINT canonical_visit_event_transition_shape_check
CHECK (
  (
    event_type = 'VISIT_PROPOSED'
    AND visit_version = 1
    AND previous_visit_version IS NULL
    AND visit_state = 'PROPOSED'
  )
  OR
  (
    event_type = 'VISIT_CHANGE_REQUESTED'
    AND previous_visit_version = visit_version
    AND visit_state IN ('PROPOSED', 'SCHEDULED')
  )
  OR
  (
    event_type = 'VISIT_SCHEDULE_PROPOSED'
    AND visit_version >= 2
    AND previous_visit_version = visit_version - 1
    AND visit_state = 'PROPOSED'
  )
  OR
  (
    event_type IN ('VISIT_CONFIRMED','VISIT_EXTERNAL_CONFIRMATION_RECORDED')
    AND visit_version >= 2
    AND previous_visit_version = visit_version - 1
    AND visit_state = 'SCHEDULED'
  )
  OR
  (
    event_type = 'VISIT_RESCHEDULED'
    AND visit_version >= 2
    AND previous_visit_version = visit_version - 1
    AND visit_state = 'SCHEDULED'
  )
  OR
  (
    event_type = 'VISIT_CANCELLED'
    AND visit_version >= 2
    AND previous_visit_version = visit_version - 1
    AND visit_state = 'CANCELLED'
  )
  OR
  (
    event_type = 'VISIT_STARTED'
    AND visit_version >= 2
    AND previous_visit_version = visit_version - 1
    AND visit_state = 'STARTED'
  )
  OR
  (
    event_type = 'VISIT_COMPLETED'
    AND visit_version >= 2
    AND previous_visit_version = visit_version - 1
    AND visit_state = 'COMPLETED'
  )
);

CREATE UNIQUE INDEX canonical_visit_version_external_identity_uidx ON canonical_visit_versions
  (visit_id,version,job_id,state,integrity_hash);
CREATE UNIQUE INDEX canonical_visit_external_command_uidx ON canonical_visit_command_idempotency
  (id,actor_participant_id,job_id,command_name);
CREATE UNIQUE INDEX canonical_quote_approval_external_schedule_uidx ON canonical_quote_approvals
  (id,quote_id,issued_quote_version,job_id,approval_source,issued_integrity_hash);
CREATE UNIQUE INDEX canonical_visit_event_external_identity_uidx ON canonical_visit_events
  (id,visit_id,job_id,visit_version,event_type,command_idempotency_id,recorded_by_participant_id);

CREATE TABLE canonical_visit_external_confirmation_evidence (
  id UUID PRIMARY KEY,
  job_id UUID NOT NULL,
  visit_id UUID NOT NULL,
  visit_purpose TEXT NOT NULL DEFAULT 'APPROVED_WORK' CHECK (visit_purpose='APPROVED_WORK'),
  proposed_visit_version INTEGER NOT NULL CHECK (proposed_visit_version>=1),
  proposed_visit_state TEXT NOT NULL DEFAULT 'PROPOSED' CHECK (proposed_visit_state='PROPOSED'),
  proposed_integrity_hash TEXT NOT NULL CHECK (proposed_integrity_hash ~ '^[0-9a-f]{64}$'),
  scheduled_visit_version INTEGER NOT NULL CHECK (scheduled_visit_version=proposed_visit_version+1),
  quote_approval_id UUID NOT NULL,
  approval_source TEXT NOT NULL DEFAULT 'EXTERNAL_EVIDENCE' CHECK (approval_source='EXTERNAL_EVIDENCE'),
  quote_id UUID NOT NULL,
  issued_quote_version INTEGER NOT NULL,
  issued_integrity_hash TEXT NOT NULL,
  contractor_profile_id INTEGER NOT NULL,
  customer_snapshot_hash TEXT NOT NULL,
  scheduled_start_at TIMESTAMPTZ NOT NULL,
  scheduled_end_at TIMESTAMPTZ,
  time_zone TEXT NOT NULL,
  location_mode TEXT NOT NULL,
  evidence_method TEXT NOT NULL CHECK (evidence_method IN ('PHONE','EMAIL','TEXT_MESSAGE','IN_PERSON','OTHER')),
  confirmed_at TIMESTAMPTZ NOT NULL,
  evidence_reference TEXT CHECK (char_length(btrim(evidence_reference)) BETWEEN 1 AND 1000),
  evidence_note TEXT CHECK (char_length(btrim(evidence_note)) BETWEEN 1 AND 8000),
  recorded_by_participant_id UUID NOT NULL,
  command_idempotency_id UUID NOT NULL UNIQUE,
  command_name TEXT NOT NULL DEFAULT 'visit.external_confirmation.record' CHECK (command_name='visit.external_confirmation.record'),
  event_id UUID NOT NULL UNIQUE,
  event_type TEXT NOT NULL DEFAULT 'VISIT_EXTERNAL_CONFIRMATION_RECORDED' CHECK (event_type='VISIT_EXTERNAL_CONFIRMATION_RECORDED'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (evidence_reference IS NOT NULL OR evidence_note IS NOT NULL),
  CHECK (confirmed_at <= created_at),
  CHECK (scheduled_start_at > created_at),
  UNIQUE (visit_id,proposed_visit_version),
  UNIQUE (visit_id,scheduled_visit_version),
  UNIQUE (id,visit_id,job_id,scheduled_visit_version,quote_approval_id),
  FOREIGN KEY (visit_id,job_id,visit_purpose,quote_approval_id)
    REFERENCES canonical_visits(id,job_id,purpose,quote_approval_id) ON DELETE RESTRICT,
  FOREIGN KEY (visit_id,proposed_visit_version,job_id,proposed_visit_state,proposed_integrity_hash)
    REFERENCES canonical_visit_versions(visit_id,version,job_id,state,integrity_hash) ON DELETE RESTRICT,
  FOREIGN KEY (visit_id,scheduled_visit_version) REFERENCES canonical_visit_versions(visit_id,version) ON DELETE RESTRICT,
  FOREIGN KEY (quote_approval_id,quote_id,issued_quote_version,job_id,approval_source,issued_integrity_hash)
    REFERENCES canonical_quote_approvals(id,quote_id,issued_quote_version,job_id,approval_source,issued_integrity_hash) ON DELETE RESTRICT,
  FOREIGN KEY (quote_id,customer_snapshot_hash,contractor_profile_id)
    REFERENCES canonical_quote_customer_snapshots(quote_id,snapshot_hash,contractor_profile_id) ON DELETE RESTRICT,
  FOREIGN KEY (recorded_by_participant_id,job_id) REFERENCES relationship_participants(id,job_id) ON DELETE RESTRICT,
  FOREIGN KEY (command_idempotency_id,recorded_by_participant_id,job_id,command_name)
    REFERENCES canonical_visit_command_idempotency(id,actor_participant_id,job_id,command_name) ON DELETE RESTRICT,
  FOREIGN KEY (event_id,visit_id,job_id,scheduled_visit_version,event_type,command_idempotency_id,recorded_by_participant_id)
    REFERENCES canonical_visit_events(id,visit_id,job_id,visit_version,event_type,command_idempotency_id,recorded_by_participant_id) ON DELETE RESTRICT
);

CREATE FUNCTION assert_external_visit_confirmation_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM jobs
    JOIN contractor_profiles profiles ON profiles.id=jobs.contractor_profile_id
    JOIN relationship_participants actor ON actor.job_id=jobs.id AND actor.user_id=profiles.user_id
      AND actor.request_relationship_id IS NULL
    JOIN canonical_visit_versions proposed ON proposed.visit_id=NEW.visit_id
      AND proposed.version=NEW.proposed_visit_version AND proposed.job_id=jobs.id
    JOIN canonical_visit_versions scheduled ON scheduled.visit_id=NEW.visit_id
      AND scheduled.version=NEW.scheduled_visit_version AND scheduled.job_id=jobs.id
    WHERE jobs.id=NEW.job_id AND jobs.source_type='business_document'
      AND jobs.job_request_id IS NULL AND jobs.source_request_relationship_id IS NULL
      AND profiles.id=NEW.contractor_profile_id AND actor.id=NEW.recorded_by_participant_id
      AND scheduled.state='SCHEDULED'
      AND scheduled.command_idempotency_id=NEW.command_idempotency_id
      AND scheduled.recorded_by_participant_id=NEW.recorded_by_participant_id
      AND proposed.state='PROPOSED'
      AND proposed.scheduled_start_at=NEW.scheduled_start_at
      AND proposed.scheduled_end_at IS NOT DISTINCT FROM NEW.scheduled_end_at
      AND proposed.time_zone=NEW.time_zone AND proposed.location_mode=NEW.location_mode
      AND scheduled.scheduled_start_at=proposed.scheduled_start_at
      AND scheduled.scheduled_end_at IS NOT DISTINCT FROM proposed.scheduled_end_at
      AND scheduled.time_zone=proposed.time_zone AND scheduled.location_mode=proposed.location_mode
      AND NEW.confirmed_at>=date_trunc('milliseconds',proposed.created_at)
      AND EXISTS (SELECT 1 FROM participant_role_assignments roles
        LEFT JOIN participant_role_revocations revocations ON revocations.role_assignment_id=roles.id
        WHERE roles.participant_id=actor.id AND roles.job_id=jobs.id AND roles.role='PRIMARY_PROFESSIONAL'
          AND roles.valid_from<=CURRENT_TIMESTAMP AND (roles.valid_until IS NULL OR roles.valid_until>CURRENT_TIMESTAMP)
          AND revocations.id IS NULL)
  ) THEN RAISE EXCEPTION 'External Visit confirmation identity or schedule mismatch.'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER canonical_external_visit_confirmation_identity BEFORE INSERT ON canonical_visit_external_confirmation_evidence
  FOR EACH ROW EXECUTE FUNCTION assert_external_visit_confirmation_identity();
CREATE TRIGGER canonical_external_visit_confirmation_append_only BEFORE UPDATE OR DELETE ON canonical_visit_external_confirmation_evidence
  FOR EACH ROW EXECUTE FUNCTION prevent_canonical_quote_history_mutation();

CREATE FUNCTION require_external_visit_schedule_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state='SCHEDULED' AND EXISTS (SELECT 1 FROM canonical_visits
      WHERE id=NEW.visit_id AND quote_approval_source='EXTERNAL_EVIDENCE')
    AND NOT EXISTS (SELECT 1 FROM canonical_visit_external_confirmation_evidence
      WHERE visit_id=NEW.visit_id AND job_id=NEW.job_id AND scheduled_visit_version=NEW.version
        AND command_idempotency_id=NEW.command_idempotency_id)
  THEN RAISE EXCEPTION 'External scheduled Visit requires canonical confirmation evidence.'; END IF;
  RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER canonical_external_visit_schedule_evidence AFTER INSERT ON canonical_visit_versions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_external_visit_schedule_evidence();
