-- MEETRO HOMEOWNER ↔ PROFESSIONAL RELATIONSHIP FOUNDATION
--
-- Establishes durable Meetro relationship identity between one authenticated
-- homeowner and one exact professional/business identity.
--
-- The relationship is established from canonical Request Selection history.
-- Request Selection already binds the exact homeowner, contractor profile,
-- professional user, Professional Response, Request Relationship, Job Request,
-- and Conversation through governed marketplace authority.
--
-- This relationship is customer-side Meetro history.
-- It is NOT authority derived from a business's private Contact or Customer
-- History system.
--
-- This table does NOT:
-- - create or modify a Business Contact
-- - infer identity from name, email, or phone
-- - create a Job Request
-- - create a Professional Response
-- - create a Request Selection
-- - create a Conversation
-- - create a Job
-- - create a Quote, approval, deposit, payment, or schedule
-- - grant authority to any historical Job
--
-- A Request Selection may later close or end. That does not erase the
-- historical fact that the homeowner selected this exact professional.
--
-- Lifecycle-v2 selections may also atomically create a canonical Job.
-- Legacy lifecycle-v1 selections legitimately may not have a Job, so Job
-- existence is not required to establish this durable relationship.

CREATE TABLE IF NOT EXISTS meetro_customer_business_relationships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  homeowner_user_id INTEGER NOT NULL
    REFERENCES users(id)
    ON DELETE RESTRICT,

  contractor_profile_id INTEGER NOT NULL,

  professional_user_id INTEGER NOT NULL,

  established_from_request_selection_id BIGINT NOT NULL
    REFERENCES request_selections(id)
    ON DELETE RESTRICT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT meetro_customer_business_relationships_business_owner_fk
    FOREIGN KEY (
      contractor_profile_id,
      professional_user_id
    )
    REFERENCES contractor_profiles(
      id,
      user_id
    )
    ON DELETE RESTRICT,

  CONSTRAINT meetro_customer_business_relationships_distinct_users_check
    CHECK (homeowner_user_id <> professional_user_id),

  -- One durable Meetro relationship per homeowner/business pair.
  CONSTRAINT meetro_customer_business_relationships_homeowner_business_key
    UNIQUE (
      homeowner_user_id,
      contractor_profile_id
    ),

  -- One canonical selection establishes at most one durable relationship row.
  CONSTRAINT meetro_customer_business_relationships_selection_source_key
    UNIQUE (
      established_from_request_selection_id
    )
);

CREATE INDEX IF NOT EXISTS
  meetro_customer_business_relationships_homeowner_idx
ON meetro_customer_business_relationships(
  homeowner_user_id,
  created_at DESC,
  contractor_profile_id
);

CREATE INDEX IF NOT EXISTS
  meetro_customer_business_relationships_business_idx
ON meetro_customer_business_relationships(
  contractor_profile_id,
  created_at DESC,
  homeowner_user_id
);

CREATE OR REPLACE FUNCTION
assert_meetro_customer_business_relationship_provenance()
RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM request_selections selections
    WHERE selections.id =
          NEW.established_from_request_selection_id

      AND selections.selected_by_user_id =
          NEW.homeowner_user_id

      AND selections.contractor_id =
          NEW.contractor_profile_id

      AND selections.professional_user_id =
          NEW.professional_user_id
  ) THEN
    RAISE EXCEPTION
      'Meetro Customer Relationship requires exact canonical Request Selection provenance.'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER
  meetro_customer_business_relationships_provenance_guard
BEFORE INSERT ON meetro_customer_business_relationships
FOR EACH ROW
EXECUTE FUNCTION
  assert_meetro_customer_business_relationship_provenance();


-- ------------------------------------------------------------
-- Historical canonical relationship projection.
--
-- Existing Request Selections already contain the governed exact
-- homeowner + contractor profile + professional user identity.
--
-- The earliest canonical selection establishes the durable relationship.
-- Later selections remain independent request/work history and are NOT
-- collapsed, modified, or deleted.
--
-- Fail closed if historical data ever claims different professional users
-- for the same homeowner + contractor profile pair.
-- ------------------------------------------------------------

DO $historical_identity_guard$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM request_selections selections
    GROUP BY
      selections.selected_by_user_id,
      selections.contractor_id
    HAVING COUNT(DISTINCT selections.professional_user_id) > 1
  ) THEN
    RAISE EXCEPTION
      'Historical Request Selection identity conflict prevents Meetro relationship projection.'
      USING ERRCODE = '23514';
  END IF;
END;
$historical_identity_guard$;


-- If this migration is safely re-evaluated against an already populated
-- relationship table, an existing pair must still agree with canonical
-- historical professional identity.
DO $existing_relationship_identity_guard$
BEGIN
  IF EXISTS (
    WITH canonical_identity AS (
      SELECT
        selections.selected_by_user_id AS homeowner_user_id,
        selections.contractor_id AS contractor_profile_id,
        MIN(selections.professional_user_id) AS professional_user_id
      FROM request_selections selections
      GROUP BY
        selections.selected_by_user_id,
        selections.contractor_id
    )
    SELECT 1
    FROM meetro_customer_business_relationships relationships
    INNER JOIN canonical_identity canonical
      ON canonical.homeowner_user_id =
         relationships.homeowner_user_id
     AND canonical.contractor_profile_id =
         relationships.contractor_profile_id
    WHERE canonical.professional_user_id <>
          relationships.professional_user_id
  ) THEN
    RAISE EXCEPTION
      'Existing Meetro relationship conflicts with canonical Request Selection identity.'
      USING ERRCODE = '23514';
  END IF;
END;
$existing_relationship_identity_guard$;


WITH establishing_selections AS (
  SELECT DISTINCT ON (
    selections.selected_by_user_id,
    selections.contractor_id
  )
    selections.selected_by_user_id AS homeowner_user_id,
    selections.contractor_id AS contractor_profile_id,
    selections.professional_user_id,
    selections.id AS established_from_request_selection_id
  FROM request_selections selections
  ORDER BY
    selections.selected_by_user_id,
    selections.contractor_id,
    selections.selected_at ASC,
    selections.id ASC
)
INSERT INTO meetro_customer_business_relationships
(
  homeowner_user_id,
  contractor_profile_id,
  professional_user_id,
  established_from_request_selection_id
)
SELECT
  establishing.homeowner_user_id,
  establishing.contractor_profile_id,
  establishing.professional_user_id,
  establishing.established_from_request_selection_id
FROM establishing_selections establishing
ON CONFLICT ON CONSTRAINT
  meetro_customer_business_relationships_homeowner_business_key
DO NOTHING;


CREATE OR REPLACE FUNCTION
prevent_meetro_customer_business_relationship_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'Meetro Customer Relationship identity is immutable.'
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER
  meetro_customer_business_relationships_history_guard
BEFORE UPDATE OR DELETE ON meetro_customer_business_relationships
FOR EACH ROW
EXECUTE FUNCTION
  prevent_meetro_customer_business_relationship_mutation();

COMMENT ON TABLE meetro_customer_business_relationships IS
  'Exact durable Meetro relationship between one authenticated homeowner and one exact professional/business identity. Canonical Request Selection provenance establishes the relationship. It does not itself create or grant Job, Quote, Conversation, payment, scheduling, marketplace, or lifecycle authority.';

COMMENT ON COLUMN
  meetro_customer_business_relationships.established_from_request_selection_id IS
  'Canonical Request Selection that originally proved the exact homeowner, contractor profile, and professional user relationship.';
