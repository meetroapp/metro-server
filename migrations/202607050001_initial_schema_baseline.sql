-- Meetro governed database schema baseline
-- Phase 4E: staging-first executable migration foundation
--
-- This migration creates only the tables and columns used by the current
-- backend API and tests. It is intentionally conservative and idempotent.

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'homeowner',
  account_type TEXT NOT NULL DEFAULT 'homeowner',
  business_name TEXT NOT NULL DEFAULT '',
  business_category TEXT NOT NULL DEFAULT '',
  profile_photo_url TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS posts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT,
  description TEXT,
  category TEXT,
  location TEXT,
  image_url TEXT,
  mage_url TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS contractor_profiles (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_name TEXT,
  category TEXT,
  phone TEXT,
  location TEXT,
  bio TEXT,
  image_url TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS quote_requests (
  id SERIAL PRIMARY KEY,
  contractor_id INTEGER NOT NULL REFERENCES contractor_profiles(id) ON DELETE CASCADE,
  homeowner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_title TEXT,
  project_description TEXT,
  location TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  quote_request_id INTEGER NOT NULL REFERENCES quote_requests(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  receiver_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  message_text TEXT NOT NULL DEFAULT '',
  image_url TEXT,
  message_type TEXT NOT NULL DEFAULT 'text',
  workflow_type TEXT,
  workflow_status TEXT,
  workflow_payload JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS workflow_events (
  id SERIAL PRIMARY KEY,
  quote_request_id INTEGER NOT NULL REFERENCES quote_requests(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workflow_type TEXT NOT NULL,
  workflow_status TEXT,
  workflow_payload JSONB DEFAULT '{}'::jsonb,
  event_label TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS reviews (
  id SERIAL PRIMARY KEY,
  contractor_id INTEGER NOT NULL REFERENCES contractor_profiles(id) ON DELETE CASCADE,
  reviewer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating INTEGER,
  review_text TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS contractor_projects (
  id SERIAL PRIMARY KEY,
  contractor_id INTEGER NOT NULL REFERENCES contractor_profiles(id) ON DELETE CASCADE,
  title TEXT,
  description TEXT,
  image_url TEXT,
  image_urls JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS posts_user_id_created_at_idx
  ON posts(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS contractor_profiles_user_id_idx
  ON contractor_profiles(user_id);

CREATE INDEX IF NOT EXISTS quote_requests_homeowner_id_created_at_idx
  ON quote_requests(homeowner_id, created_at DESC);

CREATE INDEX IF NOT EXISTS quote_requests_contractor_id_created_at_idx
  ON quote_requests(contractor_id, created_at DESC);

CREATE INDEX IF NOT EXISTS messages_quote_request_id_created_at_idx
  ON messages(quote_request_id, created_at ASC);

CREATE INDEX IF NOT EXISTS workflow_events_quote_request_id_created_at_idx
  ON workflow_events(quote_request_id, created_at ASC);

CREATE INDEX IF NOT EXISTS reviews_contractor_id_created_at_idx
  ON reviews(contractor_id, created_at DESC);

CREATE INDEX IF NOT EXISTS contractor_projects_contractor_id_created_at_idx
  ON contractor_projects(contractor_id, created_at DESC);
