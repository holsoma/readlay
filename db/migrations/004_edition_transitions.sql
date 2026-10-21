-- Claim each edition transition once, keeping all original locations available.
BEGIN;

CREATE TABLE IF NOT EXISTS readlay_edition_transitions (
  user_id text NOT NULL,
  book_id text NOT NULL,
  from_edition_id text NOT NULL,
  to_edition_id text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, book_id, from_edition_id, to_edition_id),
  CHECK (from_edition_id <> to_edition_id)
);

COMMIT;
