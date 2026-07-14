-- Canonical backend storage for validated extended Business Profile fields.
ALTER TABLE contractor_profiles
  ADD COLUMN IF NOT EXISTS profile_details JSONB NOT NULL DEFAULT '{}'::jsonb;
