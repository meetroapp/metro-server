-- Canonical private service-location foundation for ordinary Job Requests.
-- Existing free-form posts.location values remain untouched and unclassified.

ALTER TABLE posts
  ADD COLUMN IF NOT EXISTS location_intake_mode TEXT,
  ADD COLUMN IF NOT EXISTS location_normalization_status TEXT NOT NULL
    DEFAULT 'legacy_unclassified',
  ADD COLUMN IF NOT EXISTS service_address_line1 TEXT,
  ADD COLUMN IF NOT EXISTS service_city TEXT,
  ADD COLUMN IF NOT EXISTS service_region TEXT,
  ADD COLUMN IF NOT EXISTS service_postal_code TEXT,
  ADD COLUMN IF NOT EXISTS service_country_code TEXT,
  ADD COLUMN IF NOT EXISTS discovery_area_label TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'posts_location_intake_mode_check'
  ) THEN
    ALTER TABLE posts
      ADD CONSTRAINT posts_location_intake_mode_check
      CHECK (
        location_intake_mode IS NULL
        OR location_intake_mode IN ('exact_on_file', 'address_after_selection')
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'posts_location_normalization_status_check'
  ) THEN
    ALTER TABLE posts
      ADD CONSTRAINT posts_location_normalization_status_check
      CHECK (
        location_normalization_status IN ('normalized', 'legacy_unclassified')
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'posts_service_country_code_check'
  ) THEN
    ALTER TABLE posts
      ADD CONSTRAINT posts_service_country_code_check
      CHECK (
        service_country_code IS NULL
        OR service_country_code ~ '^[A-Z]{2}$'
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'posts_service_location_length_check'
  ) THEN
    ALTER TABLE posts
      ADD CONSTRAINT posts_service_location_length_check
      CHECK (
        (service_address_line1 IS NULL OR char_length(service_address_line1) <= 500)
        AND (service_city IS NULL OR char_length(service_city) <= 120)
        AND (service_region IS NULL OR char_length(service_region) <= 120)
        AND (service_postal_code IS NULL OR char_length(service_postal_code) <= 32)
        AND (discovery_area_label IS NULL OR char_length(discovery_area_label) <= 250)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'posts_service_location_shape_check'
  ) THEN
    ALTER TABLE posts
      ADD CONSTRAINT posts_service_location_shape_check
      CHECK (
        (
          location_normalization_status = 'legacy_unclassified'
          AND location_intake_mode IS NULL
          AND service_address_line1 IS NULL
          AND service_city IS NULL
          AND service_region IS NULL
          AND service_postal_code IS NULL
          AND service_country_code IS NULL
          AND discovery_area_label IS NULL
        )
        OR
        (
          location_normalization_status = 'normalized'
          AND location_intake_mode = 'exact_on_file'
          AND service_address_line1 IS NOT NULL
          AND btrim(service_address_line1) <> ''
          AND service_city IS NOT NULL
          AND btrim(service_city) <> ''
          AND service_region IS NOT NULL
          AND btrim(service_region) <> ''
          AND service_postal_code IS NOT NULL
          AND btrim(service_postal_code) <> ''
          AND service_country_code IS NOT NULL
          AND discovery_area_label = service_city || ', ' || service_region
        )
        OR
        (
          location_normalization_status = 'normalized'
          AND location_intake_mode = 'address_after_selection'
          AND service_address_line1 IS NULL
          AND btrim(unit_number) = ''
          AND service_city IS NOT NULL
          AND btrim(service_city) <> ''
          AND service_region IS NOT NULL
          AND btrim(service_region) <> ''
          AND service_postal_code IS NOT NULL
          AND btrim(service_postal_code) <> ''
          AND service_country_code IS NOT NULL
          AND discovery_area_label = service_city || ', ' || service_region
        )
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_posts_open_normalized_service_locality
  ON posts (
    status,
    service_country_code,
    service_region,
    service_city,
    service_postal_code,
    created_at DESC
  )
  WHERE location_normalization_status = 'normalized';
