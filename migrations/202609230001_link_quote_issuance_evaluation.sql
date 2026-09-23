-- Preserve the exact completed Evaluation version that governed an issued Quote.
-- Existing Quote issuances remain valid with NULL Evaluation provenance.
-- Emergency issuance code requires both values for new Emergency Quotes.

ALTER TABLE canonical_quote_issuances
  ADD COLUMN IF NOT EXISTS evaluation_id UUID;

ALTER TABLE canonical_quote_issuances
  ADD COLUMN IF NOT EXISTS evaluation_version INTEGER;

ALTER TABLE canonical_quote_issuances
  DROP CONSTRAINT IF EXISTS
    canonical_quote_issuance_evaluation_version_check;

ALTER TABLE canonical_quote_issuances
  ADD CONSTRAINT
    canonical_quote_issuance_evaluation_version_check
  CHECK (
    evaluation_version IS NULL
    OR evaluation_version >= 1
  );

ALTER TABLE canonical_quote_issuances
  DROP CONSTRAINT IF EXISTS
    canonical_quote_issuance_evaluation_pair_check;

ALTER TABLE canonical_quote_issuances
  ADD CONSTRAINT
    canonical_quote_issuance_evaluation_pair_check
  CHECK (
    (
      evaluation_id IS NULL
      AND evaluation_version IS NULL
    )
    OR
    (
      evaluation_id IS NOT NULL
      AND evaluation_version IS NOT NULL
    )
  );

ALTER TABLE canonical_quote_issuances
  DROP CONSTRAINT IF EXISTS
    canonical_quote_issuance_evaluation_version_fk;

ALTER TABLE canonical_quote_issuances
  ADD CONSTRAINT
    canonical_quote_issuance_evaluation_version_fk
  FOREIGN KEY (
    evaluation_id,
    evaluation_version
  )
  REFERENCES canonical_evaluation_versions(
    evaluation_id,
    version
  )
  ON DELETE RESTRICT;

ALTER TABLE canonical_quote_issuances
  DROP CONSTRAINT IF EXISTS
    canonical_quote_issuance_evaluation_job_fk;

ALTER TABLE canonical_quote_issuances
  ADD CONSTRAINT
    canonical_quote_issuance_evaluation_job_fk
  FOREIGN KEY (
    evaluation_id,
    job_id
  )
  REFERENCES canonical_evaluation_job_subjects(
    evaluation_id,
    job_id
  )
  ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS
  canonical_quote_issuance_evaluation_idx
ON canonical_quote_issuances(
  evaluation_id,
  evaluation_version
)
WHERE evaluation_id IS NOT NULL;

COMMENT ON COLUMN canonical_quote_issuances.evaluation_id IS
  'Exact canonical Evaluation attached to this issued Quote when Evaluation provenance applies.';

COMMENT ON COLUMN canonical_quote_issuances.evaluation_version IS
  'Exact immutable Evaluation version attached to this issued Quote.';
