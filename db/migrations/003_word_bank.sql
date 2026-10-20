-- Vocabulary is owned by the authenticated GitHub account. Reading progress is independent.
BEGIN;

CREATE TABLE IF NOT EXISTS readlay_words (
  id uuid PRIMARY KEY,
  user_id text NOT NULL,
  word text NOT NULL CHECK (length(word) BETWEEN 1 AND 100),
  entry jsonb NOT NULL CHECK (jsonb_typeof(entry) = 'object'),
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'learning', 'learned')),
  saved_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, word),
  UNIQUE (user_id, id)
);

CREATE INDEX IF NOT EXISTS readlay_words_user_saved
  ON readlay_words (user_id, saved_at DESC, id);

CREATE TABLE IF NOT EXISTS readlay_word_occurrences (
  id uuid PRIMARY KEY,
  user_id text NOT NULL,
  word_id uuid NOT NULL,
  book_id text NOT NULL,
  edition_id text NOT NULL,
  chapter_index integer NOT NULL CHECK (chapter_index >= 0),
  paragraph_index integer NOT NULL CHECK (paragraph_index >= 0),
  char_start integer NOT NULL CHECK (char_start >= 0),
  char_end integer NOT NULL CHECK (char_end > char_start),
  cfi_start text NOT NULL,
  cfi_end text NOT NULL,
  cfi_range text NOT NULL,
  sentence text NOT NULL,
  selected_text text NOT NULL,
  saved_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id, word_id) REFERENCES readlay_words (user_id, id) ON DELETE CASCADE,
  UNIQUE (user_id, word_id, book_id, edition_id, chapter_index, paragraph_index, char_start, char_end)
);

CREATE INDEX IF NOT EXISTS readlay_word_occurrences_user_word
  ON readlay_word_occurrences (user_id, word_id, saved_at DESC, id);

COMMIT;
