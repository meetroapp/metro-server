-- Canonical ordered Cloudinary metadata for governed homeowner request photos.
ALTER TABLE posts
  ADD COLUMN IF NOT EXISTS request_photos JSONB NOT NULL DEFAULT '[]'::jsonb;
