-- MEETRO EXISTING CUSTOMER REQUEST SOURCE FOUNDATION
--
-- Adds a governed Job Request origin for a homeowner requesting NEW work
-- from an exact professional with whom that homeowner already has immutable
-- canonical Meetro Request Selection provenance.
--
-- This migration intentionally does NOT:
-- - create a Job Request
-- - create a Request Relationship
-- - create a Professional Response
-- - create a Request Selection
-- - create a Conversation
-- - create a Job
-- - create or infer Business Contacts
-- - create or infer business-owned Customer Relationships
-- - grant Quote, payment, deposit, scheduling, or work authority
--
-- Existing rows remain marketplace requests.
--
-- An existing_customer_request is not marketplace inventory. Its exact
-- professional target is proven from meetro_customer_business_relationships,
-- which itself is established only by canonical Request Selection history.


-- -------------------------------------------------------------------------
-- Exact durable homeowner + professional identity can be referenced as one
-- immutable provenance tuple.
-- -------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS
  meetro_customer_business_relationships_exact_identity_uidx
ON meetro_customer_business_relationships(
  id,
  homeowner_user_id,
  contractor_profile_id,
  professional_user_id
);


-- -------------------------------------------------------------------------
-- Job Request source authority.
-- -------------------------------------------------------------------------

ALTER TABLE posts
  ADD COLUMN IF NOT EXISTS request_origin TEXT NOT NULL DEFAULT 'marketplace',
  ADD COLUMN IF NOT EXISTS target_contractor_profile_id INTEGER,
  ADD COLUMN IF NOT EXISTS target_professional_user_id INTEGER,
  ADD COLUMN IF NOT EXISTS source_meetro_relationship_id UUID;

ALTER TABLE posts
  DROP CONSTRAINT IF EXISTS posts_request_origin_check;

ALTER TABLE posts
  ADD CONSTRAINT posts_request_origin_check
  CHECK (
    request_origin IN (
      'marketplace',
      'existing_customer_request'
    )
  );

ALTER TABLE posts
  DROP CONSTRAINT IF EXISTS posts_request_origin_shape_check;

ALTER TABLE posts
  ADD CONSTRAINT posts_request_origin_shape_check
  CHECK (
    (
      request_origin = 'marketplace'
      AND target_contractor_profile_id IS NULL
      AND target_professional_user_id IS NULL
      AND source_meetro_relationship_id IS NULL
    )
    OR
    (
      request_origin = 'existing_customer_request'
      AND target_contractor_profile_id IS NOT NULL
      AND target_professional_user_id IS NOT NULL
      AND source_meetro_relationship_id IS NOT NULL
      AND user_id <> target_professional_user_id
    )
  );

DO $constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'posts_target_professional_owner_fkey'
      AND conrelid = 'posts'::regclass
  ) THEN
    ALTER TABLE posts
      ADD CONSTRAINT posts_target_professional_owner_fkey
      FOREIGN KEY (
        target_contractor_profile_id,
        target_professional_user_id
      )
      REFERENCES contractor_profiles(
        id,
        user_id
      )
      ON DELETE RESTRICT;
  END IF;
END;
$constraint$;

DO $constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'posts_existing_customer_relationship_fkey'
      AND conrelid = 'posts'::regclass
  ) THEN
    ALTER TABLE posts
      ADD CONSTRAINT posts_existing_customer_relationship_fkey
      FOREIGN KEY (
        source_meetro_relationship_id,
        user_id,
        target_contractor_profile_id,
        target_professional_user_id
      )
      REFERENCES meetro_customer_business_relationships(
        id,
        homeowner_user_id,
        contractor_profile_id,
        professional_user_id
      )
      ON DELETE RESTRICT;
  END IF;
END;
$constraint$;

CREATE INDEX IF NOT EXISTS
  posts_existing_customer_target_idx
ON posts(
  target_contractor_profile_id,
  created_at DESC,
  id
)
WHERE request_origin = 'existing_customer_request';

CREATE INDEX IF NOT EXISTS
  posts_existing_customer_relationship_idx
ON posts(
  source_meetro_relationship_id,
  created_at DESC,
  id
)
WHERE request_origin = 'existing_customer_request';


-- Job Request origin authority is immutable after creation.
CREATE OR REPLACE FUNCTION
prevent_job_request_origin_authority_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.request_origin IS DISTINCT FROM OLD.request_origin
     OR NEW.target_contractor_profile_id
        IS DISTINCT FROM OLD.target_contractor_profile_id
     OR NEW.target_professional_user_id
        IS DISTINCT FROM OLD.target_professional_user_id
     OR NEW.source_meetro_relationship_id
        IS DISTINCT FROM OLD.source_meetro_relationship_id THEN
    RAISE EXCEPTION
      'Job Request origin authority is immutable.'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS
  posts_request_origin_authority_immutable
ON posts;

CREATE TRIGGER
  posts_request_origin_authority_immutable
BEFORE UPDATE OF
  request_origin,
  target_contractor_profile_id,
  target_professional_user_id,
  source_meetro_relationship_id
ON posts
FOR EACH ROW
EXECUTE FUNCTION
  prevent_job_request_origin_authority_mutation();


-- -------------------------------------------------------------------------
-- Request Relationship source authority.
--
-- A future existing-customer Request Relationship will be an active direct
-- relationship for THIS NEW request. It does not contain a Professional
-- Response and does not fabricate marketplace selection authority.
-- -------------------------------------------------------------------------

ALTER TABLE request_relationships
  ADD COLUMN IF NOT EXISTS source_meetro_relationship_id UUID;

ALTER TABLE request_relationships
  DROP CONSTRAINT IF EXISTS
    request_relationships_ordinary_authority_source_check;

ALTER TABLE request_relationships
  ADD CONSTRAINT
    request_relationships_ordinary_authority_source_check
  CHECK (
    ordinary_authority_source IS NULL
    OR ordinary_authority_source IN (
      'professional_response',
      'existing_customer_request'
    )
  );

ALTER TABLE request_relationships
  DROP CONSTRAINT IF EXISTS
    request_relationships_professional_response_shape_check;

ALTER TABLE request_relationships
  ADD CONSTRAINT
    request_relationships_professional_response_shape_check
  CHECK (
    (
      emergency_request_id IS NOT NULL
      AND post_id IS NULL
      AND professional_response_id IS NULL
      AND ordinary_authority_source IS NULL
      AND current_version IS NULL
      AND closure_reason IS NULL
      AND source_meetro_relationship_id IS NULL
    )
    OR
    (
      post_id IS NOT NULL
      AND emergency_request_id IS NULL
      AND (
        (
          professional_response_id IS NULL
          AND ordinary_authority_source IS NULL
          AND current_version IS NULL
          AND closure_reason IS NULL
          AND source_meetro_relationship_id IS NULL
        )
        OR
        (
          professional_response_id IS NOT NULL
          AND ordinary_authority_source = 'professional_response'
          AND source_meetro_relationship_id IS NULL
          AND current_version >= 1
          AND status IN (
            'pending',
            'active',
            'closed'
          )
          AND (
            (
              status IN ('pending', 'active')
              AND closure_reason IS NULL
            )
            OR
            (
              status = 'closed'
              AND closure_reason IS NOT NULL
            )
          )
        )
        OR
        (
          professional_response_id IS NULL
          AND ordinary_authority_source =
            'existing_customer_request'
          AND source_meetro_relationship_id IS NOT NULL
          AND current_version >= 1
          AND status IN ('active', 'closed')
          AND (
            (
              status = 'active'
              AND closure_reason IS NULL
            )
            OR
            (
              status = 'closed'
              AND closure_reason IS NOT NULL
            )
          )
        )
      )
    )
  );

DO $constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname =
      'request_relationships_existing_customer_relationship_fkey'
      AND conrelid = 'request_relationships'::regclass
  ) THEN
    ALTER TABLE request_relationships
      ADD CONSTRAINT
        request_relationships_existing_customer_relationship_fkey
      FOREIGN KEY (
        source_meetro_relationship_id,
        homeowner_id,
        contractor_id,
        professional_user_id
      )
      REFERENCES meetro_customer_business_relationships(
        id,
        homeowner_user_id,
        contractor_profile_id,
        professional_user_id
      )
      ON DELETE RESTRICT;
  END IF;
END;
$constraint$;


-- The new Request Relationship must belong to the same exact governed
-- existing-customer Job Request source tuple.
CREATE OR REPLACE FUNCTION
assert_existing_customer_request_relationship_source()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.ordinary_authority_source IS DISTINCT FROM
     'existing_customer_request' THEN
    RETURN NEW;
  END IF;

  IF NEW.post_id IS NULL
     OR NEW.emergency_request_id IS NOT NULL
     OR NEW.professional_response_id IS NOT NULL
     OR NEW.source_meetro_relationship_id IS NULL THEN
    RAISE EXCEPTION
      'Existing Customer Request Relationship source is incomplete.'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM posts
    WHERE posts.id = NEW.post_id
      AND posts.user_id = NEW.homeowner_id
      AND posts.request_origin =
        'existing_customer_request'
      AND posts.target_contractor_profile_id =
        NEW.contractor_id
      AND posts.target_professional_user_id =
        NEW.professional_user_id
      AND posts.source_meetro_relationship_id =
        NEW.source_meetro_relationship_id
  ) THEN
    RAISE EXCEPTION
      'Existing Customer Request Relationship does not match its governed Job Request source.'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS
  request_relationships_existing_customer_source_check
ON request_relationships;

CREATE TRIGGER
  request_relationships_existing_customer_source_check
BEFORE INSERT OR UPDATE
ON request_relationships
FOR EACH ROW
EXECUTE FUNCTION
  assert_existing_customer_request_relationship_source();


-- -------------------------------------------------------------------------
-- Preserve Professional Response authority validation unchanged for
-- marketplace rows while explicitly excluding existing-customer rows from
-- Professional Response linkage.
-- -------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION
validate_professional_response_relationship_pair()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  response_record professional_responses%ROWTYPE;
  relationship_record request_relationships%ROWTYPE;
  response_id BIGINT;
BEGIN
  IF TG_TABLE_NAME = 'professional_responses' THEN
    response_id := NEW.id;
  ELSE
    IF NEW.ordinary_authority_source IS NULL
       AND NEW.professional_response_id IS NULL THEN
      RETURN NEW;
    END IF;

    IF NEW.ordinary_authority_source =
         'existing_customer_request'
       AND NEW.professional_response_id IS NULL THEN
      RETURN NEW;
    END IF;

    response_id := NEW.professional_response_id;
  END IF;

  SELECT *
  INTO response_record
  FROM professional_responses
  WHERE id = response_id;

  IF response_record.id IS NULL THEN
    RAISE EXCEPTION
      'Canonical Professional Response linkage is incomplete.'
      USING ERRCODE = '23514';
  END IF;

  SELECT *
  INTO relationship_record
  FROM request_relationships
  WHERE id = response_record.request_relationship_id;

  IF relationship_record.id IS NULL THEN
    RAISE EXCEPTION
      'Canonical Professional Response relationship is missing.'
      USING ERRCODE = '23514';
  END IF;

  IF relationship_record.emergency_request_id IS NOT NULL
     OR relationship_record.post_id IS NULL
     OR relationship_record.ordinary_authority_source <>
       'professional_response'
     OR relationship_record.professional_response_id <>
       response_record.id
     OR relationship_record.post_id <>
       response_record.post_id
     OR relationship_record.homeowner_id <>
       response_record.homeowner_id
     OR relationship_record.contractor_id <>
       response_record.contractor_id
     OR relationship_record.professional_user_id <>
       response_record.professional_user_id
     OR relationship_record.current_version <>
       response_record.current_version THEN
    RAISE EXCEPTION
      'Canonical Professional Response identity does not match its relationship.'
      USING ERRCODE = '23514';
  END IF;

  IF (
       response_record.status = 'submitted'
       AND relationship_record.status <> 'pending'
     )
     OR (
       response_record.status = 'selected'
       AND relationship_record.status <> 'active'
     )
     OR (
       response_record.status IN (
         'withdrawn',
         'declined',
         'not_selected',
         'expired',
         'cancelled',
         'closed'
       )
       AND relationship_record.status <> 'closed'
     ) THEN
    RAISE EXCEPTION
      'Canonical Professional Response lifecycle does not match its relationship.'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;


COMMENT ON COLUMN posts.request_origin IS
  'Governed Job Request distribution origin. marketplace enters professional opportunity matching; existing_customer_request targets one exact prior Meetro professional relationship and is excluded from marketplace distribution.';

COMMENT ON COLUMN posts.source_meetro_relationship_id IS
  'Immutable prior Meetro homeowner-professional relationship proving authority for request_origin=existing_customer_request.';

COMMENT ON COLUMN request_relationships.source_meetro_relationship_id IS
  'Prior immutable Meetro relationship provenance for ordinary_authority_source=existing_customer_request; NULL for marketplace Professional Response and Emergency authority.';
