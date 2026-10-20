-- Run this migration once against the configured PostgreSQL database.
-- Request handlers never create or alter tables.
BEGIN;

CREATE TABLE IF NOT EXISTS readlay_progress (
  user_id text NOT NULL,
  book_id text NOT NULL,
  edition_id text NOT NULL,
  chapter_index integer NOT NULL CHECK (chapter_index >= 0),
  paragraph_index integer NOT NULL CHECK (paragraph_index >= 0),
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, book_id, edition_id)
);

CREATE INDEX IF NOT EXISTS readlay_progress_user_updated
  ON readlay_progress (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS readlay_saved_books (
  user_id text NOT NULL,
  book_id text NOT NULL,
  PRIMARY KEY (user_id, book_id)
);

CREATE TABLE IF NOT EXISTS readlay_bookmarks (
  user_id text NOT NULL,
  book_id text NOT NULL,
  edition_id text NOT NULL,
  chapter_index integer NOT NULL CHECK (chapter_index >= 0),
  paragraph_index integer NOT NULL CHECK (paragraph_index >= 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, book_id, edition_id, chapter_index, paragraph_index)
);

COMMIT;
