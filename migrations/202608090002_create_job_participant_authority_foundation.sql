-- MC-JOB-LIFECYCLE-004B Slice 001: authenticated relationship participants,
-- temporal roles, and narrowly scoped lifecycle authority grants.

CREATE TABLE IF NOT EXISTS relationship_participants (
  id UUID PRIMARY KEY,

  job_id UUID NOT NULL
    REFERENCES jobs(id)
    ON DELETE RESTRICT,

  request_relationship_id INTEGER NOT NULL
    REFERENCES request_relationships(id)
    ON DELETE RESTRICT,

  user_id INTEGER NOT NULL
    REFERENCES users(id)
    ON DELETE RESTRICT,

  identity_type TEXT NOT NULL DEFAULT 'authenticated_user'
    CHECK (identity_type = 'authenticated_user'),

  source_evidence_type TEXT NOT NULL DEFAULT 'request_selection'
    CHECK (source_evidence_type = 'request_selection'),

  source_evidence_reference TEXT NOT NULL
    CHECK (char_length(btrim(source_evidence_reference)) BETWEEN 1 AND 200),

  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT relationship_participants_job_user_key UNIQUE (job_id, user_id),
  CONSTRAINT relationship_participants_relationship_user_key
    UNIQUE (request_relationship_id, user_id),
  CONSTRAINT relationship_participants_job_identity_key UNIQUE (id, job_id)
);

CREATE INDEX IF NOT EXISTS relationship_participants_user_idx
ON relationship_participants(user_id, created_at ASC, id ASC);

CREATE TABLE IF NOT EXISTS participant_role_assignments (
  id UUID PRIMARY KEY,

  participant_id UUID NOT NULL,
  job_id UUID NOT NULL,

  role TEXT NOT NULL
    CHECK (
      role IN (
        'CUSTOMER_REPRESENTATIVE',
        'SITE_OCCUPANT',
        'PRIMARY_PROFESSIONAL',
        'SPECIALIST'
      )
    ),

  assigned_by_participant_id UUID NOT NULL,
  valid_from TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  valid_until TIMESTAMPTZ,

  source_evidence_type TEXT NOT NULL,
  source_evidence_reference TEXT NOT NULL
    CHECK (char_length(btrim(source_evidence_reference)) BETWEEN 1 AND 200),

  idempotency_key TEXT NOT NULL
    CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),

  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT participant_role_assignments_participant_fk
    FOREIGN KEY (participant_id, job_id)
    REFERENCES relationship_participants(id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT participant_role_assignments_assigner_fk
    FOREIGN KEY (assigned_by_participant_id, job_id)
    REFERENCES relationship_participants(id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT participant_role_assignments_validity_check
    CHECK (valid_until IS NULL OR valid_until > valid_from),

  CONSTRAINT participant_role_assignments_command_key
    UNIQUE (assigned_by_participant_id, participant_id, role, idempotency_key),

  CONSTRAINT participant_role_assignments_identity_key UNIQUE (id, job_id)
);

CREATE INDEX IF NOT EXISTS participant_role_assignments_active_idx
ON participant_role_assignments(participant_id, role, valid_from ASC, id ASC)
WHERE valid_until IS NULL;

CREATE TABLE IF NOT EXISTS participant_role_revocations (
  id UUID PRIMARY KEY,

  role_assignment_id UUID NOT NULL UNIQUE,
  job_id UUID NOT NULL,
  revoked_by_participant_id UUID NOT NULL,
  revocation_reason TEXT NOT NULL
    CHECK (char_length(btrim(revocation_reason)) BETWEEN 1 AND 500),
  source_evidence_type TEXT NOT NULL,
  source_evidence_reference TEXT NOT NULL
    CHECK (char_length(btrim(source_evidence_reference)) BETWEEN 1 AND 200),
  idempotency_key TEXT NOT NULL
    CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  revoked_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT participant_role_revocations_assignment_fk
    FOREIGN KEY (role_assignment_id, job_id)
    REFERENCES participant_role_assignments(id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT participant_role_revocations_actor_fk
    FOREIGN KEY (revoked_by_participant_id, job_id)
    REFERENCES relationship_participants(id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT participant_role_revocations_command_key
    UNIQUE (revoked_by_participant_id, role_assignment_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS lifecycle_capabilities (
  capability TEXT PRIMARY KEY
    CHECK (capability ~ '^[a-z][a-z0-9_.]{2,119}$'),
  owning_module TEXT NOT NULL DEFAULT 'authorization'
    CHECK (owning_module = 'authorization'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO lifecycle_capabilities (capability)
VALUES
  ('reported_concern.read'),
  ('reported_concern.clarify'),
  ('participant.read')
ON CONFLICT (capability) DO NOTHING;

CREATE TABLE IF NOT EXISTS lifecycle_authority_grants (
  id UUID PRIMARY KEY,

  grantee_participant_id UUID NOT NULL,
  grantor_participant_id UUID NOT NULL,
  job_id UUID NOT NULL,

  capability TEXT NOT NULL
    REFERENCES lifecycle_capabilities(capability)
    ON DELETE RESTRICT,

  scope_type TEXT NOT NULL
    CHECK (scope_type IN ('job', 'reported_concern')),

  scope_job_id UUID NOT NULL
    REFERENCES jobs(id)
    ON DELETE RESTRICT,

  scope_concern_id UUID
    REFERENCES reported_concerns(id)
    ON DELETE RESTRICT,

  valid_from TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  valid_until TIMESTAMPTZ,

  source_evidence_type TEXT NOT NULL,
  source_evidence_reference TEXT NOT NULL
    CHECK (char_length(btrim(source_evidence_reference)) BETWEEN 1 AND 200),

  idempotency_key TEXT NOT NULL
    CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),

  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT lifecycle_authority_grants_grantee_fk
    FOREIGN KEY (grantee_participant_id, job_id)
    REFERENCES relationship_participants(id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT lifecycle_authority_grants_grantor_fk
    FOREIGN KEY (grantor_participant_id, job_id)
    REFERENCES relationship_participants(id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT lifecycle_authority_grants_job_scope_check
    CHECK (scope_job_id = job_id),

  CONSTRAINT lifecycle_authority_grants_scope_shape_check
    CHECK (
      (scope_type = 'job' AND scope_concern_id IS NULL)
      OR
      (scope_type = 'reported_concern' AND scope_concern_id IS NOT NULL)
    ),

  CONSTRAINT lifecycle_authority_grants_validity_check
    CHECK (valid_until IS NULL OR valid_until > valid_from),

  CONSTRAINT lifecycle_authority_grants_command_key
    UNIQUE (
      grantor_participant_id,
      grantee_participant_id,
      capability,
      scope_type,
      scope_job_id,
      idempotency_key
    ),

  CONSTRAINT lifecycle_authority_grants_identity_key UNIQUE (id, job_id)
);

CREATE INDEX IF NOT EXISTS lifecycle_authority_grants_active_idx
ON lifecycle_authority_grants(
  grantee_participant_id,
  capability,
  scope_job_id,
  valid_from ASC,
  id ASC
)
WHERE valid_until IS NULL;

CREATE TABLE IF NOT EXISTS lifecycle_authority_grant_revocations (
  id UUID PRIMARY KEY,

  authority_grant_id UUID NOT NULL UNIQUE,
  job_id UUID NOT NULL,
  revoked_by_participant_id UUID NOT NULL,
  revocation_reason TEXT NOT NULL
    CHECK (char_length(btrim(revocation_reason)) BETWEEN 1 AND 500),
  source_evidence_type TEXT NOT NULL,
  source_evidence_reference TEXT NOT NULL
    CHECK (char_length(btrim(source_evidence_reference)) BETWEEN 1 AND 200),
  idempotency_key TEXT NOT NULL
    CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  revoked_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT lifecycle_authority_grant_revocations_grant_fk
    FOREIGN KEY (authority_grant_id, job_id)
    REFERENCES lifecycle_authority_grants(id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT lifecycle_authority_grant_revocations_actor_fk
    FOREIGN KEY (revoked_by_participant_id, job_id)
    REFERENCES relationship_participants(id, job_id)
    ON DELETE RESTRICT,

  CONSTRAINT lifecycle_authority_grant_revocations_command_key
    UNIQUE (revoked_by_participant_id, authority_grant_id, idempotency_key)
);

DO $$
BEGIN
  ALTER TABLE concern_clarifications
    ADD CONSTRAINT concern_clarifications_actor_participant_fk
    FOREIGN KEY (actor_participant_id)
    REFERENCES relationship_participants(id)
    ON DELETE RESTRICT;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'relationship_participants',
    'participant_role_assignments',
    'participant_role_revocations',
    'lifecycle_capabilities',
    'lifecycle_authority_grants',
    'lifecycle_authority_grant_revocations'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgname = table_name || '_append_only'
        AND NOT tgisinternal
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION prevent_lifecycle_append_only_mutation()',
        table_name || '_append_only',
        table_name
      );
    END IF;
  END LOOP;
END $$;
