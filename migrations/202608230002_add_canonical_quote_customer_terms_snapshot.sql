-- Canonical Quote customer-facing terms enter the existing immutable version,
-- issuance, and customer-decision integrity chain. Historical v1 hashes remain
-- untouched; only explicitly normalized terms snapshots use integrity v2.

ALTER TABLE canonical_quote_versions
  ADD COLUMN IF NOT EXISTS customer_terms_snapshot JSONB;

CREATE OR REPLACE FUNCTION canonical_quote_customer_terms_snapshot_is_valid(
  snapshot JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  agreement JSONB;
BEGIN
  IF snapshot IS NULL OR jsonb_typeof(snapshot) <> 'object' THEN
    RETURN FALSE;
  END IF;

  IF (SELECT count(*) FROM jsonb_object_keys(snapshot)) <> 5
    OR NOT snapshot ?& ARRAY[
      'schemaVersion',
      'paymentTerms',
      'estimatedDuration',
      'customerNotes',
      'agreement'
    ]
    OR snapshot->'schemaVersion' <> '1'::jsonb
    OR jsonb_typeof(snapshot->'paymentTerms') <> 'string'
    OR jsonb_typeof(snapshot->'estimatedDuration') <> 'string'
    OR jsonb_typeof(snapshot->'customerNotes') <> 'string'
    OR jsonb_typeof(snapshot->'agreement') <> 'object'
    OR char_length(snapshot->>'paymentTerms') > 8000
    OR char_length(snapshot->>'estimatedDuration') > 240
    OR char_length(snapshot->>'customerNotes') > 8000
    OR snapshot->>'paymentTerms' <> btrim(snapshot->>'paymentTerms')
    OR snapshot->>'estimatedDuration' <> btrim(snapshot->>'estimatedDuration')
    OR snapshot->>'customerNotes' <> btrim(snapshot->>'customerNotes')
  THEN
    RETURN FALSE;
  END IF;

  agreement := snapshot->'agreement';
  IF (SELECT count(*) FROM jsonb_object_keys(agreement)) <> 9
    OR NOT agreement ?& ARRAY[
      'exclusions',
      'additionalWorkTerms',
      'hiddenConditionsTerms',
      'diagnosticTerms',
      'customerResponsibilities',
      'warrantyTerms',
      'cancellationTerms',
      'acceptanceTerms',
      'preauthorizedAdditionalWorkLimit'
    ]
    OR jsonb_typeof(agreement->'exclusions') <> 'array'
    OR jsonb_array_length(agreement->'exclusions') > 100
    OR jsonb_typeof(agreement->'additionalWorkTerms') <> 'string'
    OR jsonb_typeof(agreement->'hiddenConditionsTerms') <> 'string'
    OR jsonb_typeof(agreement->'diagnosticTerms') <> 'string'
    OR jsonb_typeof(agreement->'customerResponsibilities') <> 'string'
    OR jsonb_typeof(agreement->'warrantyTerms') <> 'string'
    OR jsonb_typeof(agreement->'cancellationTerms') <> 'string'
    OR jsonb_typeof(agreement->'acceptanceTerms') <> 'string'
    OR jsonb_typeof(agreement->'preauthorizedAdditionalWorkLimit') <> 'string'
    OR char_length(agreement->>'additionalWorkTerms') > 8000
    OR char_length(agreement->>'hiddenConditionsTerms') > 8000
    OR char_length(agreement->>'diagnosticTerms') > 8000
    OR char_length(agreement->>'customerResponsibilities') > 8000
    OR char_length(agreement->>'warrantyTerms') > 8000
    OR char_length(agreement->>'cancellationTerms') > 8000
    OR char_length(agreement->>'acceptanceTerms') > 8000
    OR char_length(agreement->>'preauthorizedAdditionalWorkLimit') > 240
    OR agreement->>'additionalWorkTerms' <> btrim(agreement->>'additionalWorkTerms')
    OR agreement->>'hiddenConditionsTerms' <> btrim(agreement->>'hiddenConditionsTerms')
    OR agreement->>'diagnosticTerms' <> btrim(agreement->>'diagnosticTerms')
    OR agreement->>'customerResponsibilities' <> btrim(agreement->>'customerResponsibilities')
    OR agreement->>'warrantyTerms' <> btrim(agreement->>'warrantyTerms')
    OR agreement->>'cancellationTerms' <> btrim(agreement->>'cancellationTerms')
    OR agreement->>'acceptanceTerms' <> btrim(agreement->>'acceptanceTerms')
    OR agreement->>'preauthorizedAdditionalWorkLimit' <>
      btrim(agreement->>'preauthorizedAdditionalWorkLimit')
  THEN
    RETURN FALSE;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(agreement->'exclusions') AS entry(value)
    WHERE jsonb_typeof(value) <> 'string'
      OR char_length(value #>> '{}') NOT BETWEEN 1 AND 3000
      OR (value #>> '{}') <> btrim(value #>> '{}')
  ) THEN
    RETURN FALSE;
  END IF;

  RETURN TRUE;
END;
$$;

ALTER TABLE canonical_quote_versions
  DROP CONSTRAINT IF EXISTS canonical_quote_versions_integrity_version_check;

ALTER TABLE canonical_quote_versions
  ADD CONSTRAINT canonical_quote_versions_integrity_version_check
  CHECK (integrity_version IN (1, 2));

ALTER TABLE canonical_quote_versions
  ADD CONSTRAINT canonical_quote_versions_customer_terms_integrity_check
  CHECK (
    (integrity_version = 1 AND customer_terms_snapshot IS NULL)
    OR
    (
      integrity_version = 2
      AND canonical_quote_customer_terms_snapshot_is_valid(
        customer_terms_snapshot
      )
    )
  );
