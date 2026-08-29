-- MC-TF-INVOICE-AUTHORITY-017: truthfully distinguish approved Quote work
-- from professionally reviewed Extra work on immutable Invoice snapshots.

ALTER TABLE canonical_invoice_line_item_snapshots
  ADD COLUMN IF NOT EXISTS source_type TEXT;

UPDATE canonical_invoice_line_item_snapshots
SET source_type = 'APPROVED_QUOTE_SCOPE'
WHERE source_type IS NULL;

ALTER TABLE canonical_invoice_line_item_snapshots
  ALTER COLUMN source_type SET NOT NULL,
  ALTER COLUMN source_quote_id DROP NOT NULL,
  ALTER COLUMN source_quote_version DROP NOT NULL,
  ALTER COLUMN source_scope_item_id DROP NOT NULL,
  ALTER COLUMN lineage_label DROP NOT NULL;

ALTER TABLE canonical_invoice_line_item_snapshots
  ADD CONSTRAINT canonical_invoice_line_source_type_check
    CHECK (source_type IN ('APPROVED_QUOTE_SCOPE', 'EXTRA_WORK')),
  ADD CONSTRAINT canonical_invoice_line_source_shape_check
    CHECK (
      (
        source_type = 'APPROVED_QUOTE_SCOPE'
        AND source_quote_id IS NOT NULL
        AND source_quote_version IS NOT NULL
        AND source_scope_item_id IS NOT NULL
        AND lineage_label IS NOT NULL
      )
      OR
      (
        source_type = 'EXTRA_WORK'
        AND source_quote_id IS NULL
        AND source_quote_version IS NULL
        AND source_scope_item_id IS NULL
        AND lineage_label IS NULL
      )
    );

ALTER TABLE canonical_invoice_versions
  DROP CONSTRAINT canonical_invoice_version_status_check;

ALTER TABLE canonical_invoice_versions
  ADD CONSTRAINT canonical_invoice_version_status_check
    CHECK (
      status = 'DRAFT'
      OR (status = 'SENT' AND paid_minor = 0 AND balance_minor = total_minor)
      OR (status = 'PARTIALLY_PAID' AND paid_minor > 0 AND balance_minor > 0)
      OR (status = 'PAID' AND paid_minor = total_minor AND balance_minor = 0)
    );

COMMENT ON COLUMN canonical_invoice_line_item_snapshots.source_type IS
  'APPROVED_QUOTE_SCOPE requires exact approved Quote scope lineage; EXTRA_WORK is a reviewed Invoice-only snapshot with null Quote lineage.';
