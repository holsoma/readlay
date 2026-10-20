-- Existing paragraph positions resume at their first character.
-- Adding this column preserves all saved progress, books and bookmarks.
BEGIN;

ALTER TABLE readlay_progress
  ADD COLUMN IF NOT EXISTS char_offset integer NOT NULL DEFAULT 0
    CHECK (char_offset >= 0);

COMMIT;
