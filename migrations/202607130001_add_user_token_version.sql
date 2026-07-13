-- Invalidates previously issued JWTs after an authenticated password change.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;
