-- Canonical Cloudinary metadata for authenticated personal profile images.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS profile_photo_details JSONB NOT NULL DEFAULT '{}'::jsonb;
