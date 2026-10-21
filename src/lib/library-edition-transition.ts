import "server-only";
import type { NeonQueryFunction } from "@neondatabase/serverless";
import { getEditionMigrations } from "./edition-migration-store";
import { migrateReadingPosition, type EditionMigration } from "./edition-migration";

type Sql = NeonQueryFunction<false, false>;
type Row = Record<string, unknown>;

export function libraryTransitionCopies(migration: EditionMigration, rows: Row[]) {
  const progress: Record<string, unknown>[] = [], bookmarks: Record<string, unknown>[] = [];
  for (const row of rows) {
    const ci = Number(row.chapter_index), pi = Number(row.paragraph_index);
    if (row.kind === "progress") {
      const mapped = migrateReadingPosition(migration, { chapterIndex: ci, paragraphIndex: pi, charOffset: Number(row.char_offset ?? 0) });
      if (mapped) progress.push({ chapter_index: mapped.chapterIndex, paragraph_index: mapped.paragraphIndex, char_offset: mapped.charOffset,
        source_chapter: ci, source_paragraph: pi, source_offset: Number(row.char_offset ?? 0), updated_at: row.saved_at });
    } else if (row.kind === "bookmark") {
      const mapped = migration.paragraphs[`${ci}:${pi}`]?.target;
      if (mapped) bookmarks.push({ chapter_index: mapped.chapterIndex, paragraph_index: mapped.paragraphIndex, source_chapter: ci, source_paragraph: pi, created_at: row.saved_at });
    }
  }
  return { progress, bookmarks };
}

/** A marker and both copies commit together. Original rows are never rewritten. */
export async function ensureLibraryEditionTransitions(userId: string, sql: Sql) {
  for (const migration of await getEditionMigrations()) {
    let finished = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const applied = await sql`SELECT 1 FROM readlay_edition_transitions
        WHERE user_id = ${userId} AND book_id = ${migration.bookId}
          AND from_edition_id = ${migration.fromEditionId} AND to_edition_id = ${migration.toEditionId}`;
      if (applied.length) { finished = true; break; }
      // Preserve PostgreSQL microseconds; a driver Date would truncate them before
      // the exact snapshot comparison and make an unchanged source look different.
      const rows = await sql`SELECT 'progress' AS kind, chapter_index, paragraph_index, char_offset, updated_at::text AS saved_at
        FROM readlay_progress WHERE user_id = ${userId} AND book_id = ${migration.bookId} AND edition_id = ${migration.fromEditionId}
      UNION ALL
      SELECT 'bookmark' AS kind, chapter_index, paragraph_index, 0 AS char_offset, created_at::text AS saved_at
        FROM readlay_bookmarks WHERE user_id = ${userId} AND book_id = ${migration.bookId} AND edition_id = ${migration.fromEditionId}`;
      const copies = libraryTransitionCopies(migration, rows);
      // Compare both complete source sets before claiming. Existing rows stay locked
      // through the copy, so a changed source cannot commit a marker without its place.
      const result = await sql`WITH expected AS (
        SELECT * FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
          AS item(kind text, chapter_index integer, paragraph_index integer, char_offset integer, saved_at timestamptz)
      ), live_progress AS MATERIALIZED (
        SELECT 'progress'::text AS kind, chapter_index, paragraph_index, char_offset, updated_at AS saved_at
        FROM readlay_progress WHERE user_id = ${userId} AND book_id = ${migration.bookId} AND edition_id = ${migration.fromEditionId} FOR UPDATE
      ), live_bookmarks AS MATERIALIZED (
        SELECT 'bookmark'::text AS kind, chapter_index, paragraph_index, 0 AS char_offset, created_at AS saved_at
        FROM readlay_bookmarks WHERE user_id = ${userId} AND book_id = ${migration.bookId} AND edition_id = ${migration.fromEditionId} FOR UPDATE
      ), live AS (
        SELECT * FROM live_progress UNION ALL SELECT * FROM live_bookmarks
      ), unchanged AS (
        SELECT 1 WHERE NOT EXISTS (
          (SELECT * FROM live EXCEPT SELECT * FROM expected)
          UNION ALL
          (SELECT * FROM expected EXCEPT SELECT * FROM live)
        )
      ), claimed AS (
        INSERT INTO readlay_edition_transitions (user_id, book_id, from_edition_id, to_edition_id)
        SELECT ${userId}, ${migration.bookId}, ${migration.fromEditionId}, ${migration.toEditionId} FROM unchanged
        ON CONFLICT (user_id, book_id, from_edition_id, to_edition_id) DO NOTHING RETURNING 1
      ), copied_progress AS (
        INSERT INTO readlay_progress (user_id, book_id, edition_id, chapter_index, paragraph_index, char_offset, updated_at)
        SELECT ${userId}, ${migration.bookId}, ${migration.toEditionId}, item.chapter_index, item.paragraph_index, item.char_offset, item.updated_at
        FROM claimed CROSS JOIN jsonb_to_recordset(${JSON.stringify(copies.progress)}::jsonb)
          AS item(chapter_index integer, paragraph_index integer, char_offset integer, source_chapter integer, source_paragraph integer, source_offset integer, updated_at timestamptz)
        WHERE EXISTS (SELECT 1 FROM readlay_progress old WHERE old.user_id = ${userId} AND old.book_id = ${migration.bookId}
          AND old.edition_id = ${migration.fromEditionId} AND old.chapter_index = item.source_chapter AND old.paragraph_index = item.source_paragraph AND old.char_offset = item.source_offset)
        ON CONFLICT (user_id, book_id, edition_id) DO NOTHING RETURNING 1
      ), copied_bookmarks AS (
        INSERT INTO readlay_bookmarks (user_id, book_id, edition_id, chapter_index, paragraph_index, created_at)
        SELECT ${userId}, ${migration.bookId}, ${migration.toEditionId}, item.chapter_index, item.paragraph_index, item.created_at
        FROM claimed CROSS JOIN jsonb_to_recordset(${JSON.stringify(copies.bookmarks)}::jsonb)
        AS item(chapter_index integer, paragraph_index integer, source_chapter integer, source_paragraph integer, created_at timestamptz)
      WHERE EXISTS (SELECT 1 FROM readlay_bookmarks old WHERE old.user_id = ${userId} AND old.book_id = ${migration.bookId}
        AND old.edition_id = ${migration.fromEditionId} AND old.chapter_index = item.source_chapter AND old.paragraph_index = item.source_paragraph)
        ON CONFLICT (user_id, book_id, edition_id, chapter_index, paragraph_index) DO NOTHING RETURNING 1
      ) SELECT EXISTS (SELECT 1 FROM claimed) AS claimed`;
      if (result[0]?.claimed === true) { finished = true; break; }
    }
    if (!finished) throw new Error("The original reading locations changed during the edition transition. Try again.");
  }
}
