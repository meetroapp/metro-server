-- MC-U1-03B-2: additive Business Portfolio authority foundation.
-- Existing projects remain legacy-review-required through a NULL
-- publication_state. This migration does not publish, archive, feature, or
-- privacy-classify existing Portfolio content.

ALTER TABLE contractor_projects
  ADD COLUMN IF NOT EXISTS publication_state TEXT,
  ADD COLUMN IF NOT EXISTS display_order INTEGER,
  ADD COLUMN IF NOT EXISTS is_featured BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS privacy_confirmation_version TEXT,
  ADD COLUMN IF NOT EXISTS privacy_content_digest TEXT,
  ADD COLUMN IF NOT EXISTS privacy_confirmed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS privacy_confirmed_by_user_id INTEGER
    REFERENCES users(id)
    ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS featured_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

-- Establish deterministic owner ordering without assigning publication
-- authority. Existing content and governed media columns are not rewritten.
WITH deterministic_project_order AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY contractor_id
      ORDER BY created_at ASC, id ASC
    ) - 1 AS display_order
  FROM contractor_projects
)
UPDATE contractor_projects AS project
SET display_order = deterministic_project_order.display_order
FROM deterministic_project_order
WHERE project.id = deterministic_project_order.id
  AND project.display_order IS NULL;

-- Defaults are established only after the legacy rows above have retained
-- publication_state = NULL. They therefore govern future inserts only.
ALTER TABLE contractor_projects
  ALTER COLUMN publication_state SET DEFAULT 'DRAFT',
  ALTER COLUMN updated_at SET DEFAULT CURRENT_TIMESTAMP;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'contractor_projects_publication_state_check'
      AND conrelid = 'contractor_projects'::regclass
  ) THEN
    ALTER TABLE contractor_projects
      ADD CONSTRAINT contractor_projects_publication_state_check
      CHECK (
        publication_state IS NULL
        OR publication_state IN ('DRAFT', 'PUBLISHED', 'ARCHIVED')
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'contractor_projects_display_order_check'
      AND conrelid = 'contractor_projects'::regclass
  ) THEN
    ALTER TABLE contractor_projects
      ADD CONSTRAINT contractor_projects_display_order_check
      CHECK (display_order IS NULL OR display_order >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'contractor_projects_version_check'
      AND conrelid = 'contractor_projects'::regclass
  ) THEN
    ALTER TABLE contractor_projects
      ADD CONSTRAINT contractor_projects_version_check
      CHECK (version >= 1);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'contractor_projects_privacy_confirmation_check'
      AND conrelid = 'contractor_projects'::regclass
  ) THEN
    ALTER TABLE contractor_projects
      ADD CONSTRAINT contractor_projects_privacy_confirmation_check
      CHECK (
        (
          privacy_confirmation_version IS NULL
          AND privacy_content_digest IS NULL
          AND privacy_confirmed_at IS NULL
          AND privacy_confirmed_by_user_id IS NULL
        )
        OR
        (
          char_length(btrim(privacy_confirmation_version)) BETWEEN 1 AND 100
          AND privacy_content_digest ~ '^[0-9a-f]{64}$'
          AND privacy_confirmed_at IS NOT NULL
          AND privacy_confirmed_by_user_id IS NOT NULL
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'contractor_projects_publication_timestamps_check'
      AND conrelid = 'contractor_projects'::regclass
  ) THEN
    ALTER TABLE contractor_projects
      ADD CONSTRAINT contractor_projects_publication_timestamps_check
      CHECK (
        (
          publication_state IS NULL
          AND published_at IS NULL
          AND archived_at IS NULL
        )
        OR
        (
          publication_state = 'DRAFT'
          AND published_at IS NULL
          AND archived_at IS NULL
        )
        OR
        (
          publication_state = 'PUBLISHED'
          AND published_at IS NOT NULL
          AND archived_at IS NULL
        )
        OR
        (
          publication_state = 'ARCHIVED'
          AND published_at IS NOT NULL
          AND archived_at IS NOT NULL
          AND archived_at >= published_at
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'contractor_projects_published_privacy_check'
      AND conrelid = 'contractor_projects'::regclass
  ) THEN
    ALTER TABLE contractor_projects
      ADD CONSTRAINT contractor_projects_published_privacy_check
      CHECK (
        publication_state NOT IN ('PUBLISHED', 'ARCHIVED')
        OR (
          privacy_confirmation_version IS NOT NULL
          AND privacy_content_digest IS NOT NULL
          AND privacy_confirmed_at IS NOT NULL
          AND privacy_confirmed_by_user_id IS NOT NULL
          AND privacy_confirmed_at <= published_at
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'contractor_projects_feature_state_check'
      AND conrelid = 'contractor_projects'::regclass
  ) THEN
    ALTER TABLE contractor_projects
      ADD CONSTRAINT contractor_projects_feature_state_check
      CHECK (
        (
          is_featured = FALSE
          AND featured_at IS NULL
        )
        OR
        (
          is_featured = TRUE
          AND publication_state = 'PUBLISHED'
          AND published_at IS NOT NULL
          AND archived_at IS NULL
          AND featured_at IS NOT NULL
          AND featured_at >= published_at
        )
      );
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS contractor_projects_identity_contractor_uidx
ON contractor_projects(id, contractor_id);

CREATE UNIQUE INDEX IF NOT EXISTS contractor_projects_contractor_display_order_uidx
ON contractor_projects(contractor_id, display_order)
WHERE display_order IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS contractor_projects_one_featured_published_uidx
ON contractor_projects(contractor_id)
WHERE is_featured = TRUE AND publication_state = 'PUBLISHED';

CREATE INDEX IF NOT EXISTS contractor_projects_owner_authority_order_idx
ON contractor_projects(
  contractor_id,
  publication_state,
  display_order ASC,
  created_at ASC,
  id ASC
);

CREATE INDEX IF NOT EXISTS contractor_projects_public_order_idx
ON contractor_projects(contractor_id, display_order ASC, created_at ASC, id ASC)
WHERE publication_state = 'PUBLISHED';

CREATE TABLE IF NOT EXISTS contractor_project_publication_events (
  id BIGSERIAL PRIMARY KEY,

  project_id INTEGER NOT NULL,
  contractor_id INTEGER NOT NULL,
  actor_user_id INTEGER NOT NULL
    REFERENCES users(id)
    ON DELETE RESTRICT,

  project_version INTEGER NOT NULL
    CHECK (project_version >= 1),

  from_state TEXT,
  to_state TEXT NOT NULL,

  privacy_confirmation_version TEXT,
  privacy_content_digest TEXT,

  transitioned_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT contractor_project_publication_event_project_fk
    FOREIGN KEY (project_id, contractor_id)
    REFERENCES contractor_projects(id, contractor_id)
    ON DELETE RESTRICT,

  CONSTRAINT contractor_project_publication_event_from_state_check
    CHECK (
      from_state IS NULL
      OR from_state IN ('DRAFT', 'PUBLISHED', 'ARCHIVED')
    ),

  CONSTRAINT contractor_project_publication_event_to_state_check
    CHECK (to_state IN ('DRAFT', 'PUBLISHED', 'ARCHIVED')),

  CONSTRAINT contractor_project_publication_event_transition_check
    CHECK (
      (from_state IS NULL AND to_state = 'DRAFT')
      OR (from_state = 'DRAFT' AND to_state = 'PUBLISHED')
      OR (from_state = 'PUBLISHED' AND to_state = 'ARCHIVED')
    ),

  CONSTRAINT contractor_project_publication_event_privacy_check
    CHECK (
      (
        privacy_confirmation_version IS NULL
        AND privacy_content_digest IS NULL
        AND to_state = 'DRAFT'
      )
      OR
      (
        char_length(btrim(privacy_confirmation_version)) BETWEEN 1 AND 100
        AND privacy_content_digest ~ '^[0-9a-f]{64}$'
      )
    ),

  CONSTRAINT contractor_project_publication_event_version_key
    UNIQUE (project_id, project_version)
);

CREATE INDEX IF NOT EXISTS contractor_project_publication_event_order_idx
ON contractor_project_publication_events(
  project_id,
  project_version ASC,
  transitioned_at ASC,
  id ASC
);

CREATE INDEX IF NOT EXISTS contractor_project_publication_event_contractor_idx
ON contractor_project_publication_events(
  contractor_id,
  transitioned_at DESC,
  id DESC
);

CREATE OR REPLACE FUNCTION prevent_contractor_project_publication_event_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'Contractor project publication events are append-only.'
    USING ERRCODE = '55000';
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'contractor_project_publication_events_append_only'
      AND tgrelid = 'contractor_project_publication_events'::regclass
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER contractor_project_publication_events_append_only
    BEFORE UPDATE OR DELETE ON contractor_project_publication_events
    FOR EACH ROW
    EXECUTE FUNCTION prevent_contractor_project_publication_event_mutation();
  END IF;
END $$;
