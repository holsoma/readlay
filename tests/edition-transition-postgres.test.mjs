import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { loadTypeScript, plain } from "./helpers/load-typescript.mjs";

// This existing private runtime is used only for local SQL verification. No connection strings or network are used.
const runtime = new URL("../.local/verification-runtime/node_modules/@electric-sql/pglite/dist/index.js", import.meta.url);
const oldEdition = "b17d5f5bc348f3d6", newEdition = "1234567890abcdef";
const mapping = () => ({ schemaVersion: 1, bookId: "seven-habits", fromEditionId: oldEdition, toEditionId: newEdition, paragraphs: {
  "0:0": { sourceLength: 18, target: { chapterIndex: 1, paragraphIndex: 2, charOffset: 3 }, words: [[2, 7, 1, 2, 3, 8], [8, 13, 1, 2, 9, 14]] },
} });

test("real PostgreSQL copies edition locations atomically once, preserves current positions and isolates accounts", { skip: !existsSync(runtime) && "Optional local PostgreSQL verification runtime is not installed." }, async () => {
  const { PGlite } = await import(runtime.href);
  const db = new PGlite();
  try {
    for (let pass = 0; pass < 2; pass++) for (const name of ["001_library.sql", "002_word_progress.sql", "003_word_bank.sql", "004_edition_transitions.sql"]) {
      await db.exec(readFileSync(new URL(`../db/migrations/${name}`, import.meta.url), "utf8"));
    }
    let activeMapping = mapping();
    const queries = [];
    let raceUpdates = 0;
    const sql = (parts, ...values) => {
      const text = parts.reduce((result, part, index) => result + part + (index < values.length ? `$${index + 1}` : ""), "");
      queries.push({ text, values });
      return db.query(text, values).then(async (result) => {
        if (text.startsWith("SELECT 'progress'") && values[0] === "race" && raceUpdates++ === 0) {
          await db.query("UPDATE readlay_progress SET char_offset=2 WHERE user_id='race' AND edition_id=$1", [oldEdition]);
        }
        if (text.startsWith("SELECT 'progress'") && values[0] === "racing") {
          await db.query("UPDATE readlay_progress SET char_offset=CASE WHEN char_offset=8 THEN 2 ELSE 8 END WHERE user_id='racing' AND edition_id=$1", [oldEdition]);
        }
        return result.rows;
      });
    };
    const { ensureLibraryEditionTransitions } = loadTypeScript("src/lib/library-edition-transition.ts", { stubs: {
      "server-only": {}, "./edition-migration-store": { getEditionMigrations: async () => [activeMapping] },
    } });
    const date = "2026-10-20T08:00:00.000Z";
    for (const user of ["A", "B", "C", "rollback", "race", "racing"]) {
      await db.query("INSERT INTO readlay_progress (user_id,book_id,edition_id,chapter_index,paragraph_index,char_offset,updated_at) VALUES ($1,'seven-habits',$2,0,0,8,$3)", [user, oldEdition, date]);
      await db.query("INSERT INTO readlay_bookmarks (user_id,book_id,edition_id,chapter_index,paragraph_index,created_at) VALUES ($1,'seven-habits',$2,0,0,$3)", [user, oldEdition, date]);
    }
    const microseconds = "2026-10-20T08:00:00.123456Z";
    await db.query("INSERT INTO readlay_progress (user_id,book_id,edition_id,chapter_index,paragraph_index,char_offset,updated_at) VALUES ('micros','seven-habits',$1,0,0,8,$2)", [oldEdition, microseconds]);
    await db.query("INSERT INTO readlay_bookmarks (user_id,book_id,edition_id,chapter_index,paragraph_index,created_at) VALUES ('micros','seven-habits',$1,0,0,$2)", [oldEdition, microseconds]);
    const parsedDate = (await db.query("SELECT updated_at AS saved_at FROM readlay_progress WHERE user_id='micros'")).rows[0].saved_at;
    assert.ok(parsedDate instanceof Date, "the local driver parses timestamps as Date, matching the Neon default");
    assert.equal(parsedDate.toISOString(), "2026-10-20T08:00:00.123Z", "a normal driver timestamp loses the final microseconds");
    await db.query("INSERT INTO readlay_progress (user_id,book_id,edition_id,chapter_index,paragraph_index,char_offset) VALUES ('A','atomic-habits','unchanged',2,5,44),('C','seven-habits',$1,5,8,123)", [newEdition]);
    const original = plain((await db.query("SELECT * FROM readlay_progress WHERE edition_id <> $1 ORDER BY user_id,book_id", [newEdition])).rows);
    await Promise.all([ensureLibraryEditionTransitions("A", sql), ensureLibraryEditionTransitions("A", sql)]);
    const a = (await db.query("SELECT * FROM readlay_progress WHERE user_id='A' AND edition_id=$1", [newEdition])).rows;
    assert.equal(a.length, 1); assert.equal(a[0].chapter_index, 1); assert.equal(a[0].paragraph_index, 2); assert.equal(a[0].char_offset, 9);
    assert.equal(new Date(a[0].updated_at).toISOString(), date);
    assert.equal((await db.query("SELECT * FROM readlay_progress WHERE user_id='B' AND edition_id=$1", [newEdition])).rows.length, 0, "another account must not be copied");
    assert.deepEqual(plain((await db.query("SELECT * FROM readlay_progress WHERE edition_id <> $1 ORDER BY user_id,book_id", [newEdition])).rows), original, "old editions and unrelated books must be unchanged");
    assert.equal((await db.query("SELECT * FROM readlay_bookmarks WHERE user_id='A' AND edition_id=$1", [newEdition])).rows.length, 1);
    await db.query("DELETE FROM readlay_bookmarks WHERE user_id='A' AND edition_id=$1", [newEdition]);
    await ensureLibraryEditionTransitions("A", sql);
    assert.equal((await db.query("SELECT * FROM readlay_bookmarks WHERE user_id='A' AND edition_id=$1", [newEdition])).rows.length, 0, "a removed bookmark must not return after another GET");
    await ensureLibraryEditionTransitions("C", sql);
    const c = (await db.query("SELECT * FROM readlay_progress WHERE user_id='C' AND edition_id=$1", [newEdition])).rows[0];
    assert.equal(c.chapter_index, 5); assert.equal(c.char_offset, 123, "a current-edition position takes priority");
    activeMapping = mapping(); activeMapping.paragraphs["0:0"].target.chapterIndex = -1;
    await assert.rejects(ensureLibraryEditionTransitions("rollback", sql), /check constraint/);
    assert.equal((await db.query("SELECT * FROM readlay_edition_transitions WHERE user_id='rollback'")).rows.length, 0, "a failed copy must roll back its claim");
    assert.equal((await db.query("SELECT * FROM readlay_progress WHERE user_id='rollback' AND edition_id=$1", [newEdition])).rows.length, 0, "a failed bookmark copy must also roll back copied progress");
    activeMapping = mapping(); await ensureLibraryEditionTransitions("rollback", sql);
    assert.equal((await db.query("SELECT * FROM readlay_edition_transitions WHERE user_id='rollback'")).rows.length, 1, "a rolled-back transition can be retried");
    await ensureLibraryEditionTransitions("race", sql);
    const raced = (await db.query("SELECT * FROM readlay_progress WHERE user_id='race' AND edition_id=$1", [newEdition])).rows;
    assert.equal(raced.length, 1); assert.equal(raced[0].char_offset, 3, "a source position changed after SELECT must be re-read and copied from its new word");
    assert.equal((await db.query("SELECT * FROM readlay_edition_transitions WHERE user_id='race'")).rows.length, 1);
    assert.ok(raceUpdates >= 2, "the guarded claim must retry the source read");
    await assert.rejects(ensureLibraryEditionTransitions("racing", sql), /changed during the edition transition/);
    assert.equal((await db.query("SELECT * FROM readlay_edition_transitions WHERE user_id='racing'")).rows.length, 0, "repeated racing writes must leave the migration retryable");
    assert.equal((await db.query("SELECT * FROM readlay_progress WHERE user_id='racing' AND edition_id=$1", [newEdition])).rows.length, 0);
    assert.equal(queries.every((query) => !query.text.includes(oldEdition) && !query.text.includes(newEdition)), true, "edition IDs must remain SQL parameters");
    await ensureLibraryEditionTransitions("micros", sql);
    const preciseProgress = (await db.query("SELECT updated_at = $1::timestamptz AS exact FROM readlay_progress WHERE user_id='micros' AND edition_id=$2", [microseconds, newEdition])).rows;
    const preciseBookmark = (await db.query("SELECT created_at = $1::timestamptz AS exact FROM readlay_bookmarks WHERE user_id='micros' AND edition_id=$2", [microseconds, newEdition])).rows;
    assert.deepEqual(plain(preciseProgress), [{ exact: true }], "microsecond progress timestamps must pass the snapshot guard and copy without truncation");
    assert.deepEqual(plain(preciseBookmark), [{ exact: true }], "microsecond bookmark timestamps must pass the snapshot guard and copy without truncation");
  } finally { await db.close(); }
});
