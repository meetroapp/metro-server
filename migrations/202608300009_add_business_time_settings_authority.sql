-- MC Employee / Team V1: Business-owned calendar authority for Team projections.
-- Existing Businesses remain unconfigured until an Owner explicitly saves both values.

ALTER TABLE contractor_profiles
  ADD COLUMN IF NOT EXISTS time_zone TEXT,
  ADD COLUMN IF NOT EXISTS week_start_day TEXT,
  ADD COLUMN IF NOT EXISTS time_settings_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS time_settings_updated_by_membership_id UUID;

ALTER TABLE contractor_profiles
  DROP CONSTRAINT IF EXISTS contractor_profiles_time_zone_check,
  ADD CONSTRAINT contractor_profiles_time_zone_check CHECK (
    time_zone IS NULL
    OR (
      time_zone = btrim(time_zone)
      AND char_length(time_zone) BETWEEN 3 AND 100
      AND time_zone !~ '[[:cntrl:]]'
    )
  ),
  DROP CONSTRAINT IF EXISTS contractor_profiles_week_start_day_check,
  ADD CONSTRAINT contractor_profiles_week_start_day_check CHECK (
    week_start_day IS NULL
    OR week_start_day IN (
      'SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY',
      'THURSDAY', 'FRIDAY', 'SATURDAY'
    )
  ),
  DROP CONSTRAINT IF EXISTS contractor_profiles_time_settings_complete_check,
  ADD CONSTRAINT contractor_profiles_time_settings_complete_check CHECK (
    (time_zone IS NULL AND week_start_day IS NULL
      AND time_settings_updated_at IS NULL
      AND time_settings_updated_by_membership_id IS NULL)
    OR
    (time_zone IS NOT NULL AND week_start_day IS NOT NULL
      AND time_settings_updated_at IS NOT NULL
      AND time_settings_updated_by_membership_id IS NOT NULL)
  ),
  DROP CONSTRAINT IF EXISTS contractor_profiles_time_settings_actor_fk,
  ADD CONSTRAINT contractor_profiles_time_settings_actor_fk
    FOREIGN KEY (time_settings_updated_by_membership_id, id)
    REFERENCES business_team_memberships(id, contractor_profile_id)
    ON DELETE RESTRICT;

